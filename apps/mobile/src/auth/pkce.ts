// PKCE for the app's sign-in (RFC 7636, S256): the verifier stays on the phone; the challenge goes
// with the browser to sign-in and comes back sealed in the handoff code, which only this verifier
// redeems (POST /api/mobile/session).
import { sha256 } from "@noble/hashes/sha2.js";
import { base64url, utf8 } from "../util/bytes";

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** A 64-character verifier from random bytes (each byte picks one of 66 characters, unbiased). */
export function pkceVerifier(randomBytes: (n: number) => Uint8Array): string {
  let out = "";
  while (out.length < 64) {
    for (const b of randomBytes(96)) {
      // 198 = 3 × 66: bytes at or above it are dropped so every character is equally likely.
      if (b >= 198) continue;
      out += UNRESERVED[b % 66] as string;
      if (out.length === 64) break;
    }
  }
  return out;
}

export function pkceChallenge(verifier: string): string {
  return base64url(sha256(utf8(verifier)));
}

/** The handoff code from `mezonas://signed-in?code=…`, or null (cancelled, refused, or no code). */
export function handoffCode(url: string | null | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(url.slice(q + 1).split("#")[0]);
  const code = params.get("code");
  return code && code.length > 0 ? code : null;
}

/** A refusal the handoff sent back instead (`?error=not_invited`), for the sign-in screen. */
export function handoffError(url: string | null | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1).split("#")[0]).get("error");
}
