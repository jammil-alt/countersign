// HTTP for connectors that call out (Zoho CRM, outbound webhooks). The package has no DOM or Workers
// types, so `fetch` is reached through the narrow types below and injected: apps/api passes the
// runtime's fetch, tests pass a fake that answers from fixtures. Nothing here talks to a live API.

import { hmacKey, subtle, toHex, utf8 } from "./runtime";

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "manual" | "follow" | "error";
  signal?: unknown;
}

export interface HttpResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string, init?: HttpRequestInit) => Promise<HttpResponseLike>;

/** The runtime's fetch (Workers, Node 22), typed narrowly. */
export function globalFetch(): FetchLike {
  const f = (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!f) throw new Error("fetch is not available in this runtime");
  return (url, init) => f(url, init);
}

/** An abort signal that fires after `ms` (AbortSignal.timeout), or undefined where there is none. */
export function timeoutSignal(ms: number): unknown {
  const A = (globalThis as unknown as { AbortSignal?: { timeout?(ms: number): unknown } })
    .AbortSignal;
  return A?.timeout?.(ms);
}

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const sig = await subtle().sign("HMAC", await hmacKey(utf8(secret)), utf8(message));
  return toHex(new Uint8Array(sig));
}

/**
 * Compares two strings in time that depends only on their lengths, so a secret can't be guessed a
 * character at a time from response timings.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = utf8(a);
  const y = utf8(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The WHATWG URL parts used here (no DOM types in this package). */
export interface UrlLike {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly port: string;
  readonly host: string;
  readonly pathname: string;
  readonly origin: string;
  readonly href: string;
}

export function parseUrl(raw: string): UrlLike | null {
  const U = (globalThis as unknown as { URL?: new (s: string) => UrlLike }).URL;
  if (!U) throw new Error("URL is not available in this runtime");
  try {
    return new U(raw);
  } catch {
    return null;
  }
}

/** `a=1&b=2`, percent-encoded. */
export function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Parses `a=1&b=2` (also `+` for spaces); a repeated key keeps the last value. */
export function formDecode(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const i = pair.indexOf("=");
    const dec = (v: string) => decodeURIComponent(v.replace(/\+/g, " "));
    const k = dec(i < 0 ? pair : pair.slice(0, i));
    out[k] = i < 0 ? "" : dec(pair.slice(i + 1));
  }
  return out;
}

export type UrlRefusal = "invalid" | "not_https" | "credentials" | "private_host";

/**
 * Whether a URL the client gave may be called from the Worker: https only, no user:password, and
 * not a private, loopback, link-local or internal address or name (SSRF).
 */
// DECISION: the check is on the URL as written (IP literals in private ranges, localhost and
// internal-only names); names are not resolved first, because a Worker cannot resolve DNS itself.
// Cloudflare's egress does not reach private networks either, and redirects are never followed, so
// a public name pointing at a private address gets nowhere.
export function checkPublicHttpsUrl(
  raw: string,
): { ok: true; url: UrlLike } | { ok: false; reason: UrlRefusal } {
  const url = raw.length <= 2048 ? parseUrl(raw) : null;
  if (!url) return { ok: false, reason: "invalid" };
  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username || url.password) return { ok: false, reason: "credentials" };
  if (url.port && url.port !== "443") return { ok: false, reason: "private_host" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isPrivateHost(host)) return { ok: false, reason: "private_host" };
  return { ok: true, url };
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".corp"];

function isPrivateHost(host: string): boolean {
  if (host === "" || host === "localhost" || !host.includes(".")) {
    // Single-label names only resolve inside a private network; IPv6 literals are bracketed.
    if (!host.startsWith("[")) return true;
  }
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host === "metadata.google.internal") return true;
  if (host.startsWith("[")) return isPrivateIpv6(host.slice(1, -1));
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return isPrivateIpv4(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return true;
  const [a, b] = parts.map(Number) as [number, number, number, number];
  if (parts.some((p) => Number(p) > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return true;
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique local
  if (/^fe[89ab]/.test(a)) return true; // link-local
  if (a.startsWith("::ffff:")) {
    const v4 = a.slice(7);
    return v4.includes(".") ? isPrivateIpv4(v4) : true;
  }
  return false;
}
