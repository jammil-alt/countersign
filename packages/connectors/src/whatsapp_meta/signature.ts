// v0.14 W4-A: Meta's webhook checks (docs/plan.md §1.57). Meta signs every POST with HMAC-SHA256
// over the raw body, keyed with the app secret, as `X-Hub-Signature-256: sha256=<hex>`; the check
// runs on the bytes as received (a body parsed and serialized again no longer matches, since Meta
// escapes unicode when it signs) and before anything else. The subscription handshake (GET) echoes
// `hub.challenge` when `hub.verify_token` is ours. Both comparisons are constant-time: the
// signature through Web Crypto's `verify`, the verify token through `constantTimeEqual`.
// Pattern from Respaldo's verified receiver; no code shared.

import { constantTimeEqual } from "../http";
import { hmacKey, subtle, utf8 } from "../runtime";

export const META_SIGNATURE_HEADER = "x-hub-signature-256";
const PREFIX = "sha256=";

/** `sha256=<64 hex>` → its 32 bytes, or null for anything else (checked without a regex). */
export function parseMetaSignature(header: string | null | undefined): Uint8Array | null {
  if (typeof header !== "string" || header.length !== PREFIX.length + 64) return null;
  if (header.slice(0, PREFIX.length) !== PREFIX) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const hi = hexValue(header.charCodeAt(PREFIX.length + i * 2));
    const lo = hexValue(header.charCodeAt(PREFIX.length + i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = hi * 16 + lo;
  }
  return out;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

/**
 * Whether the raw body carries Meta's signature under the app secret. An empty secret, a missing
 * or malformed header, or a different body all fail closed.
 */
export async function verifyMetaSignature(input: {
  rawBody: Uint8Array;
  header: string | null | undefined;
  appSecret: string | undefined;
}): Promise<boolean> {
  const signature = parseMetaSignature(input.header);
  // An empty secret would accept a signature anyone can compute.
  if (!signature || !input.appSecret) return false;
  const key = await hmacKey(utf8(input.appSecret));
  return subtle().verify("HMAC", key, signature, input.rawBody);
}

/**
 * The subscription handshake: the challenge to echo (as text/plain), or null when the mode isn't
 * `subscribe`, the token isn't ours, or there is no challenge.
 */
export function verifyMetaChallenge(input: {
  mode: string | null | undefined;
  token: string | null | undefined;
  challenge: string | null | undefined;
  verifyToken: string | undefined;
}): string | null {
  if (input.mode !== "subscribe") return null;
  if (!input.verifyToken || !input.token || !input.challenge) return null;
  // Meta's challenge is a number; anything long or odd is refused rather than echoed.
  if (input.challenge.length > 128 || !isPlainToken(input.challenge)) return null;
  return constantTimeEqual(input.token, input.verifyToken) ? input.challenge : null;
}

/** Letters, digits, `-`, `_` and `.` only (no markup can be echoed back). */
function isPlainToken(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x2d ||
      c === 0x5f ||
      c === 0x2e;
    if (!ok) return false;
  }
  return true;
}
