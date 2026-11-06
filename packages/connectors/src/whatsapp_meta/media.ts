// v0.14 W4-A: an inbound attachment's bytes from Meta (docs/plan.md §1.57, M33's capture path).
// Meta's two-step download, both steps with the client's business token:
//   1. `GET https://graph.facebook.com/v26.0/<media id>?phone_number_id=<the client's number>`
//      answers a short-lived signed `url` (Meta refuses a media id not received on that number);
//   2. `GET <url>` answers the bytes.
// The signed link is fetched only if it is HTTPS on an origin of a fixed list (exact origins,
// never a prefix), with no redirect followed. A link that has expired (404/410) is resolved again,
// once. The declared size is checked before reading and the body read in chunks up to the
// conversation's limit; the response's type must be the declared one. Links and tokens are never
// logged: failures are codes. Pattern from Respaldo's verified two-step; no code shared.

import { normalizeContentType } from "@countersign/core";
import type { FetchLike, HttpResponseLike } from "../http";
import { parseUrl, timeoutSignal } from "../http";
import { TransientMediaError } from "../twilio/media";
import { graphCall, isGraphId, MetaGraphError, readLimited } from "./graph";

/**
 * Where Meta's signed media links may point. UNCHECKED beyond Respaldo's verified receiver
 * (NOTES.md): `lookaside.fbsbx.com`. Anything else is refused (`redirect_refused`).
 */
// DECISION: a fixed list of exact origins, as for Twilio's redirect (plan §1.55).
export const META_MEDIA_ORIGINS: ReadonlySet<string> = new Set(["https://lookaside.fbsbx.com"]);

const TIMEOUT_MS = 30_000;

export type MetaMediaResult =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; status: "refused"; reason: "too_large" | "type_mismatch" | "empty" }
  | {
      ok: false;
      status: "failed";
      reason: "gone" | "unauthorized" | "redirect_refused" | "no_media_id";
    };

interface Resolved {
  url: string;
  sizeBytes: number | null;
}

class ExpiredLink extends Error {
  override name = "ExpiredLink";
}

function classify(status: number): MetaMediaResult | null {
  if (status === 401 || status === 403) {
    return { ok: false, status: "failed", reason: "unauthorized" };
  }
  if (status === 429 || status >= 500) throw new TransientMediaError(`Meta answered ${status}`);
  return null;
}

async function resolve(
  fetch: FetchLike,
  token: string,
  mediaId: string,
  phoneNumberId: string,
): Promise<Resolved | MetaMediaResult> {
  let body: unknown;
  try {
    // `phone_number_id` makes Meta refuse a media id that didn't come to this client's number.
    body = await graphCall(fetch, {
      method: "GET",
      segments: [mediaId],
      query: { phone_number_id: phoneNumberId },
      token,
    });
  } catch (error) {
    if (error instanceof MetaGraphError) {
      if (error.status === 0) throw new TransientMediaError("could not reach Meta");
      const known = classify(error.status);
      if (known) return known;
      // A media id Meta doesn't know is gone for good; only the link expires, not the id.
      return { ok: false, status: "failed", reason: "gone" };
    }
    throw error;
  }
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (typeof b.url !== "string" || b.url.length > 4096) {
    return { ok: false, status: "failed", reason: "gone" };
  }
  const size =
    typeof b.file_size === "number"
      ? b.file_size
      : typeof b.file_size === "string"
        ? Number(b.file_size)
        : Number.NaN;
  return { url: b.url, sizeBytes: Number.isFinite(size) && size >= 0 ? size : null };
}

/** Whether a link may be fetched: HTTPS, no credentials in it, on a listed origin. */
export function metaMediaLinkAllowed(link: string): boolean {
  const url = parseUrl(link);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    META_MEDIA_ORIGINS.has(url.origin)
  );
}

async function download(
  fetch: FetchLike,
  token: string,
  link: string,
  input: { contentType: string; maxBytes: number },
): Promise<MetaMediaResult> {
  if (!metaMediaLinkAllowed(link)) {
    return { ok: false, status: "failed", reason: "redirect_refused" };
  }
  let res: HttpResponseLike;
  try {
    // Meta's signed link needs the bearer token too.
    res = await fetch(link, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: timeoutSignal(TIMEOUT_MS),
    });
  } catch {
    throw new TransientMediaError("could not reach Meta's media host");
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, status: "failed", reason: "redirect_refused" };
  }
  if (res.status === 404 || res.status === 410) throw new ExpiredLink();
  if (!res.ok) {
    const known = classify(res.status);
    return known ?? { ok: false, status: "failed", reason: "gone" };
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > input.maxBytes) {
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

/**
 * Fetches one attachment with the client's business token: resolve the media id on the client's
 * number, then download the signed link; an expired link is resolved again once.
 */
export async function fetchMetaMedia(
  fetch: FetchLike,
  input: {
    token: string;
    phoneNumberId: string;
    mediaId: string | null;
    contentType: string;
    maxBytes: number;
  },
): Promise<MetaMediaResult> {
  if (!input.mediaId || !isGraphId(input.mediaId) || !isGraphId(input.phoneNumberId)) {
    return { ok: false, status: "failed", reason: "no_media_id" };
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await resolve(fetch, input.token, input.mediaId, input.phoneNumberId);
    if ("ok" in r) return r;
    // The declared size, before anything is downloaded.
    if (r.sizeBytes !== null && r.sizeBytes > input.maxBytes) {
      return { ok: false, status: "refused", reason: "too_large" };
    }
    try {
      return await download(fetch, input.token, r.url, input);
    } catch (error) {
      if (!(error instanceof ExpiredLink)) throw error;
      // DECISION: one fresh link, not a loop: a second dead link is not an expiry.
    }
  }
  return { ok: false, status: "failed", reason: "gone" };
}
