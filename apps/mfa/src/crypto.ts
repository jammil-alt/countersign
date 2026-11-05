// Encryption at rest for the code service: authenticator secrets and held codes are sealed with
// MFA_ENCRYPTION_KEY (32 bytes, base64; AES-256-GCM through Web Crypto). The additional data binds
// each envelope to its identity, its site and what it is, so an envelope copied to another identity
// or site does not open. This key is the code service's own: apps/api never has it.

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const VERSION = 1;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Lowercase base32 (RFC 4648 alphabet, no padding). */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** A new identity id: 12 base32 characters, 60 random bits (core `CodesIdentityId`). */
export function newIdentityId(): string {
  return base32(crypto.getRandomValues(new Uint8Array(8))).slice(0, 12);
}

/** The additional data of an envelope: what it is, for which identity and site. */
export function sealContext(parts: {
  identityId: string;
  siteKey: string;
  purpose: "authenticator" | `code:${string}`;
}): string {
  return `mezonas-codes/v${VERSION}\n${parts.identityId}\n${parts.siteKey}\n${parts.purpose}`;
}

export class SealKey {
  private constructor(private readonly key: CryptoKey) {}

  /** Imports MFA_ENCRYPTION_KEY. Throws when it is missing or not 32 bytes. */
  static async fromBase64(raw: string | undefined): Promise<SealKey> {
    if (!raw) throw new Error("MFA_ENCRYPTION_KEY is not set");
    const bytes = fromBase64(raw.trim());
    if (bytes.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 bytes, base64");
    const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return new SealKey(key);
  }

  /** `v1.<iv>.<ciphertext>` (base64), sealed under `context` as additional data. */
  async seal(plaintext: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(context) },
      this.key,
      utf8(plaintext),
    );
    return `v${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
  }

  /** Opens an envelope; throws when the key, the context or the bytes do not match. */
  async open(envelope: string, context: string): Promise<string> {
    const [v, iv, ct] = envelope.split(".");
    if (v !== `v${VERSION}` || !iv || !ct) throw new Error("not a code service envelope");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: utf8(context) },
      this.key,
      fromBase64(ct),
    );
    return new TextDecoder().decode(pt);
  }
}

/** Constant-time comparison of two strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
