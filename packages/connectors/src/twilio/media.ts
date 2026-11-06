// v0.14 capture: an inbound message's attachments (ARCHITECTURE §6.12, docs/plan.md §1.55).
//
// What is kept of each attachment is its index, declared type and Twilio's media SID (ME…), never
// the link. The link is rebuilt from validated SIDs on Twilio's API origin, so nothing taken from a
// webhook is ever fetched (server-side fetching: SSRF). Twilio answers a media request with a
// redirect to a short-lived signed link on another host: it is followed once, by hand, HTTPS only,
// without our credentials, and only to an origin on a fixed list. The body is read in chunks and
// stops at the conversation's limit. Patterns from Respaldo's capture, no code shared. Facts not
// checked against Twilio's docs are in NOTES.md.

import { normalizeContentType, type StoredMedia } from "@countersign/core";
import type { FetchLike, HttpResponseLike, UrlLike } from "../http";
import { parseUrl, timeoutSignal } from "../http";
import { toBase64, utf8 } from "../runtime";
import { TWILIO_API, type TwilioAuth } from "./api";

/** Most attachments Twilio puts on one message. */
export const MAX_MEDIA_PER_MESSAGE = 10;
const TIMEOUT_MS = 30_000;

/** Twilio's API origin: the only place a media request starts. */
export const TWILIO_API_ORIGIN = "https://api.twilio.com";

/**
 * Where Twilio's media redirect may lead. UNCHECKED (NOTES.md): the hosts Twilio's signed media
 * links are on. Anything else is refused (`redirect_refused`).
 */
// DECISION (plan §1.55, confirmed by the lead 2026-11-06): a fixed list of exact origins.
export const TWILIO_MEDIA_REDIRECT_ORIGINS: ReadonlySet<string> = new Set([
  "https://media.twiliocdn.com",
  "https://mms.twiliocdn.com",
  "https://s3-external-1.amazonaws.com",
]);

const HEX = new Set("0123456789abcdef");

/** `<prefix>` followed by 32 lowercase hex characters, checked without a regular expression. */
function isSid(value: string, prefix: string): boolean {
  if (value.length !== prefix.length + 32 || !value.startsWith(prefix)) return false;
  for (const ch of value.slice(prefix.length)) if (!HEX.has(ch)) return false;
  return true;
}

export const isAccountSid = (v: string) => isSid(v, "AC");
export const isMediaSid = (v: string) => isSid(v, "ME");
export const isMessageSid = (v: string) => isSid(v, "SM") || isSid(v, "MM");

/**
 * The media SID in a Twilio media link (`https://api.twilio.com/2010-04-01/Accounts/AC…/Messages/
 * MM…/Media/ME…`), or null for anything else. Used on the webhook's `MediaUrl{i}` and on records
 * made before v0.14, which kept the link.
 */
export function mediaSidOf(link: string | null | undefined): string | null {
  if (!link || link.length > 512) return null;
  const url = parseUrl(link);
  if (!url || url.origin !== TWILIO_API_ORIGIN) return null;
  const parts = url.pathname.split("/");
  const last = parts.at(-1) ?? "";
  return parts.at(-2) === "Media" && isMediaSid(last) ? last : null;
}

/**
 * A webhook's attachments, as they are kept: index, declared type and media SID. The form's
 * `MediaUrl{i}` and `MediaContentType{i}` are read by building each name, never by walking the
 * form's keys, and `NumMedia` is capped at 10.
 */
export function inboundMedia(form: ReadonlyMap<string, string>): StoredMedia[] {
  const declared = Number.parseInt(form.get("NumMedia") ?? "0", 10);
  const count = Number.isFinite(declared)
    ? Math.max(0, Math.min(MAX_MEDIA_PER_MESSAGE, declared))
    : 0;
  return Array.from({ length: count }, (_, index) => ({
    index,
    contentType: normalizeContentType(form.get(`MediaContentType${index}`)).slice(0, 200),
    mediaSid: mediaSidOf(form.get(`MediaUrl${index}`)),
  }));
}

/** The media request's link, from validated SIDs only; null when any is malformed. */
export function twilioMediaUrl(input: {
  accountSid: string;
  messageSid: string;
  mediaSid: string;
}): UrlLike | null {
  if (!isAccountSid(input.accountSid)) return null;
  if (!isMessageSid(input.messageSid) || !isMediaSid(input.mediaSid)) return null;
  const url = parseUrl(
    `${TWILIO_API}/Accounts/${input.accountSid}/Messages/${input.messageSid}/Media/${input.mediaSid}`,
  );
  return url && url.origin === TWILIO_API_ORIGIN ? url : null;
}

export type MediaFetchResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | {
      ok: false;
      status: "refused";
      reason: "too_large" | "type_mismatch" | "empty";
    }
  | {
      ok: false;
      status: "failed";
      reason: "gone" | "unauthorized" | "redirect_refused" | "no_media_id";
    };

/** A failure worth trying again later (Twilio busy or down): the job's step retries it. */
export class TransientMediaError extends Error {
  override name = "TransientMediaError";
}

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

function basic(auth: TwilioAuth): string {
  return `Basic ${toBase64(utf8(`${auth.accountSid}:${auth.authToken}`))}`;
}

/**
 * Reads at most `limit` bytes of a body; null when it is longer. Chunks are kept as they come and
 * copied once into a buffer of the exact size, so nothing larger than the limit is ever allocated.
 */
async function readLimited(res: HttpResponseLike, limit: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  // No stream is no body (the whole body is never read at once: its size is unknown).
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function classify(status: number): MediaFetchResult | null {
  if (status === 404 || status === 410) return { ok: false, status: "failed", reason: "gone" };
  if (status === 401 || status === 403) {
    return { ok: false, status: "failed", reason: "unauthorized" };
  }
  if (status === 429 || status >= 500) throw new TransientMediaError(`Twilio answered ${status}`);
  return null;
}

/**
 * Fetches one attachment with the client's subaccount credentials. The first request goes only to
 * Twilio's API origin; one redirect is followed to a listed origin without credentials. Never logs
 * a link or a credential: failures are codes.
 */
export async function fetchTwilioMedia(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { messageSid: string; mediaSid: string | null; contentType: string; maxBytes: number },
): Promise<MediaFetchResult> {
  if (!input.mediaSid) return { ok: false, status: "failed", reason: "no_media_id" };
  const first = twilioMediaUrl({
    accountSid: auth.accountSid,
    messageSid: input.messageSid,
    mediaSid: input.mediaSid,
  });
  if (!first) return { ok: false, status: "failed", reason: "no_media_id" };
  let res: HttpResponseLike;
  try {
    res = await fetch(first.href, {
      method: "GET",
      headers: { authorization: basic(auth) },
      redirect: "manual",
      signal: timeoutSignal(TIMEOUT_MS),
    });
  } catch {
    throw new TransientMediaError("could not reach Twilio");
  }
  if (isRedirect(res.status)) {
    const location = res.headers.get("location") ?? "";
    const next = location.length <= 4096 ? parseUrl(location) : null;
    // Compared by exact origin (scheme, host and port), never by a string prefix.
    const allowed =
      next !== null &&
      next.protocol === "https:" &&
      !next.username &&
      !next.password &&
      TWILIO_MEDIA_REDIRECT_ORIGINS.has(next.origin);
    if (!allowed || !next) return { ok: false, status: "failed", reason: "redirect_refused" };
    try {
      // No credentials to the signed link's host.
      res = await fetch(next.href, {
        method: "GET",
        redirect: "manual",
        signal: timeoutSignal(TIMEOUT_MS),
      });
    } catch {
      throw new TransientMediaError("could not reach the media host");
    }
    if (isRedirect(res.status)) return { ok: false, status: "failed", reason: "redirect_refused" };
  }
  if (!res.ok) {
    const known = classify(res.status);
    if (known) return known;
    return { ok: false, status: "failed", reason: "gone" };
  }
  const declaredLength = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, status: "refused", reason: "too_large" };
  }
  const got = normalizeContentType(res.headers.get("content-type"));
  if (got && got !== "application/octet-stream" && got !== input.contentType) {
    await res.body?.cancel?.().catch(() => {});
    return { ok: false, status: "refused", reason: "type_mismatch" };
  }
  const bytes = await readLimited(res, input.maxBytes);
  if (!bytes) return { ok: false, status: "refused", reason: "too_large" };
  if (bytes.length === 0) return { ok: false, status: "refused", reason: "empty" };
  return { ok: true, bytes, contentType: input.contentType };
}
