// v0.14 W4-A: Meta's Graph API for WhatsApp (docs/plan.md §1.57). Every request goes to one origin,
// `https://graph.facebook.com`, at one pinned version (`v26.0`), on a path built from validated ids
// (digits) and fixed words, never from a URL taken from input. Answers are read up to a limit.
// Tokens travel in the Authorization header (the app's own token, for `debug_token`, in its query:
// Meta's documented form) and are never logged or put in an error. Unchecked facts: ./NOTES.md.

import {
  type FetchLike,
  formEncode,
  type HttpResponseLike,
  parseUrl,
  timeoutSignal,
} from "../http";
import { fromUtf8, utf8 } from "../runtime";

/** The Graph API version, pinned in every URL (an unversioned call follows the app dashboard). */
export const GRAPH_VERSION = "v26.0";
export const GRAPH_ORIGIN = "https://graph.facebook.com";
const TIMEOUT_MS = 20_000;
/** Graph's answers here are small; anything longer is refused unread. */
const MAX_ANSWER_BYTES = 1_000_000;

/** A Graph object id (WABA, phone number, media, business): digits only, checked without a regex. */
export function isGraphId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 32) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

const WAMID_PREFIX = "wamid.";

/** A WhatsApp message id (`wamid.` and base64-like characters), checked without a regex. */
export function isWamid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length <= WAMID_PREFIX.length || value.length > 512) return false;
  if (value.slice(0, WAMID_PREFIX.length) !== WAMID_PREFIX) return false;
  for (let i = WAMID_PREFIX.length; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2b || // +
      c === 0x2f || // /
      c === 0x3d || // =
      c === 0x5f || // _
      c === 0x2d; // -
    if (!ok) return false;
  }
  return true;
}

/** A WhatsApp id (`wa_id`, a sender's number without `+`) as E.164, or null. */
export function e164OfWaId(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 7 || value.length > 15) return null;
  if (value.charCodeAt(0) === 0x30) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
  }
  return `+${value}`;
}

/** E.164 → the `to` Meta takes (digits only). */
export function waIdOf(e164: string): string {
  return e164.startsWith("+") ? e164.slice(1) : e164;
}

export class MetaGraphError extends Error {
  constructor(
    readonly status: number,
    /** Graph's error code (190: the token is gone; 131047: outside the 24-hour window), or null. */
    readonly code: number | null,
    message: string,
    readonly subcode: number | null = null,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

/** Graph's codes that mean the token no longer works: the client must connect again. */
export const TOKEN_ERROR_CODES: ReadonlySet<number> = new Set([190, 102, 10, 200]);

/**
 * Reads at most `limit` bytes of a body; null when it is longer. Chunks are copied once into a
 * buffer of the exact size, so nothing larger than the limit is ever allocated.
 */
export async function readLimited(
  res: HttpResponseLike,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel?.().catch(() => {});
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    // Fakes without a stream: their text, checked after (they are ours and small).
    const text = await res.text();
    const bytes = utf8(text);
    return bytes.length > limit ? null : bytes;
  }
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

/** A path under the pinned version, from ids and fixed words only; null when any part isn't. */
export function graphUrl(
  segments: readonly string[],
  query: Readonly<Record<string, string>> = {},
): string | null {
  for (const s of segments) {
    if (!isGraphId(s) && !FIXED_SEGMENTS.has(s)) return null;
  }
  const q = Object.keys(query).length ? `?${formEncode({ ...query })}` : "";
  const url = parseUrl(`${GRAPH_ORIGIN}/${GRAPH_VERSION}/${segments.join("/")}${q}`);
  // Compared by exact origin, never by a string prefix.
  return url && url.origin === GRAPH_ORIGIN ? url.href : null;
}

/** The fixed words a path may contain besides ids. */
const FIXED_SEGMENTS: ReadonlySet<string> = new Set([
  "oauth",
  "access_token",
  "debug_token",
  "phone_numbers",
  "subscribed_apps",
  "register",
  "messages",
]);

export interface GraphAnswer {
  status: number;
  body: unknown;
}

/** One Graph call. Throws MetaGraphError on an error answer; returns the parsed JSON otherwise. */
export async function graphCall(
  fetch: FetchLike,
  input: {
    method: "GET" | "POST" | "DELETE";
    segments: readonly string[];
    query?: Readonly<Record<string, string>>;
    /** The bearer token; absent for calls that carry the app's credentials in the query. */
    token?: string;
    json?: unknown;
  },
): Promise<unknown> {
  const url = graphUrl(input.segments, input.query);
  if (!url) throw new MetaGraphError(0, null, "a Graph path was malformed");
  let res: HttpResponseLike;
  try {
    res = await fetch(url, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(input.json === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.json === undefined ? {} : { body: JSON.stringify(input.json) }),
      redirect: "manual",
      signal: timeoutSignal(TIMEOUT_MS),
    });
  } catch {
    throw new MetaGraphError(0, null, "Meta could not be reached");
  }
  const bytes = await readLimited(res, MAX_ANSWER_BYTES);
  let body: unknown = null;
  if (bytes && bytes.length > 0) {
    try {
      body = JSON.parse(fromUtf8(bytes));
    } catch {
      body = null;
    }
  }
  if (res.status >= 200 && res.status < 300 && bytes) return body;
  throw graphErrorOf(res.status, body);
}

/** Graph's error answer, as plain words (Meta's message, cut short; never a token). */
export function graphErrorOf(status: number, body: unknown): MetaGraphError {
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  const e = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
  const code = typeof e.code === "number" ? e.code : null;
  const subcode = typeof e.error_subcode === "number" ? e.error_subcode : null;
  const message =
    typeof e.message === "string" && e.message.trim()
      ? e.message.trim().slice(0, 200)
      : `Meta answered ${status}`;
  return new MetaGraphError(status, code, message, subcode);
}
