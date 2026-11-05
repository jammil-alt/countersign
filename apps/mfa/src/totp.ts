// Authenticator codes: HOTP (RFC 4226) and TOTP (RFC 6238) on Web Crypto HMAC, and the
// `otpauth://totp/...` URI a site shows in its QR code (the Key Uri Format used by authenticator
// apps). The secret only ever lives encrypted in the identity's storage and in memory here.

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpParams {
  /** The shared secret's bytes. */
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

const HASH: Record<TotpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes RFC 4648 base32 (case, spaces and padding ignored). Null when it is not base32. */
export function decodeBase32(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  if (clean.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** HOTP (RFC 4226 §5.3): dynamic truncation of HMAC(secret, counter) to `digits` digits. */
export async function hotp(
  secret: Uint8Array,
  counter: number,
  options: { algorithm?: TotpAlgorithm; digits?: number } = {},
): Promise<string> {
  const algorithm = options.algorithm ?? "SHA1";
  const digits = options.digits ?? 6;
  const msg = new Uint8Array(8);
  // The counter as 8 bytes big-endian; JavaScript numbers are exact to 2^53.
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c % 256;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: HASH[algorithm] },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** TOTP (RFC 6238): HOTP over the number of `period`-second steps since the Unix epoch. */
export async function totp(params: TotpParams, at: Date): Promise<string> {
  const counter = Math.floor(Math.floor(at.getTime() / 1000) / params.period);
  return hotp(params.secret, counter, { algorithm: params.algorithm, digits: params.digits });
}

export class OtpauthError extends Error {}

/**
 * Reads `otpauth://totp/<label>?secret=<base32>&algorithm=&digits=&period=&issuer=`. Only TOTP;
 * digits 6 to 8; period 15 to 120 seconds; algorithm SHA1 (the default), SHA256 or SHA512.
 */
export function parseOtpauthUri(uri: string): TotpParams {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new OtpauthError("not an otpauth URI");
  }
  if (url.protocol !== "otpauth:") throw new OtpauthError("not an otpauth URI");
  // `otpauth://totp/...`: the type is the URL's host.
  if (url.host.toLowerCase() !== "totp") {
    throw new OtpauthError("only time-based (totp) authenticators are supported");
  }
  const secret = decodeBase32(url.searchParams.get("secret") ?? "");
  if (!secret || secret.length < 10) throw new OtpauthError("the secret is missing or too short");
  const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") {
    throw new OtpauthError("unsupported algorithm");
  }
  const digits = Number(url.searchParams.get("digits") ?? "6");
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new OtpauthError("digits must be 6 to 8");
  }
  const period = Number(url.searchParams.get("period") ?? "30");
  if (!Number.isInteger(period) || period < 15 || period > 120) {
    throw new OtpauthError("period must be 15 to 120 seconds");
  }
  return { secret, algorithm, digits, period };
}
