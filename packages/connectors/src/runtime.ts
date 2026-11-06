// The Web Platform APIs this package uses (Web Crypto, TextEncoder/Decoder). They exist in Workers
// and Node 22 alike, but the package has no DOM/Node/Workers types (it must typecheck without them
// and apps/api is the only place with Workers bindings), so they are reached through globalThis
// with the narrow types below.

/** Opaque handle to an imported key. */
export interface CryptoKeyLike {
  readonly type: string;
}

type AesGcmParams = {
  name: "AES-GCM";
  iv: Uint8Array;
  additionalData?: Uint8Array;
  tagLength?: number;
};

/** v0.12 bankfeed: a P-256 public key as a JWK (Plaid's webhook verification keys). */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

interface SubtleCryptoLike {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "AES-GCM" } | { name: "HMAC"; hash: "SHA-256" | "SHA-1" },
    extractable: boolean,
    usages: ("encrypt" | "decrypt" | "sign" | "verify")[],
  ): Promise<CryptoKeyLike>;
  // v0.12 bankfeed: ES256 (ECDSA P-256 with SHA-256), to verify Plaid's webhook JWTs.
  importKey(
    format: "jwk",
    keyData: EcPublicJwk,
    algorithm: { name: "ECDSA"; namedCurve: "P-256" },
    extractable: boolean,
    usages: "verify"[],
  ): Promise<CryptoKeyLike>;
  encrypt(algorithm: AesGcmParams, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: AesGcmParams, key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: "HMAC", key: CryptoKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: "HMAC",
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  verify(
    algorithm: { name: "ECDSA"; hash: "SHA-256" },
    key: CryptoKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

interface CryptoLike {
  getRandomValues<T extends Uint8Array>(array: T): T;
  subtle: SubtleCryptoLike;
}

const g = globalThis as unknown as {
  crypto?: CryptoLike;
  TextEncoder?: new () => { encode(input: string): Uint8Array };
  TextDecoder?: new (
    label?: string,
    options?: { fatal?: boolean },
  ) => { decode(input: Uint8Array): string };
};

export function subtle(): SubtleCryptoLike {
  if (!g.crypto?.subtle) throw new Error("Web Crypto is not available in this runtime");
  return g.crypto.subtle;
}

export function randomBytes(n: number): Uint8Array {
  if (!g.crypto) throw new Error("Web Crypto is not available in this runtime");
  return g.crypto.getRandomValues(new Uint8Array(n));
}

export function utf8(input: string): Uint8Array {
  if (!g.TextEncoder) throw new Error("TextEncoder is not available in this runtime");
  return new g.TextEncoder().encode(input);
}

export function fromUtf8(bytes: Uint8Array): string {
  if (!g.TextDecoder) throw new Error("TextDecoder is not available in this runtime");
  return new g.TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", data));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/** Accepts standard and URL-safe base64, with or without padding; throws on anything else. */
export function fromBase64(input: string): Uint8Array {
  const s = input.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (s.length % 4 === 1) throw new Error("invalid base64");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const ch of s) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) throw new Error("invalid base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** URL-safe base64 without padding (OAuth state, tokens in URLs). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  return fromBase64(input);
}

export async function hmacKey(
  secret: Uint8Array,
  hash: "SHA-256" | "SHA-1" = "SHA-256",
): Promise<CryptoKeyLike> {
  return subtle().importKey("raw", secret, { name: "HMAC", hash }, false, ["sign", "verify"]);
}
