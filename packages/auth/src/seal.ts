// Encrypt-and-authenticate for the sign-in cookies, ported from Plenary Labs'
// apps/api/src/identity/seal.ts.
//
// Web Crypto AES-256-GCM, so it runs in Workers with nothing imported. The key is never the cookie
// password itself: it is HMAC-SHA-256(password, purpose), so the session cookie and the login
// `state` cookie are sealed under different keys, and a value sealed for one cannot be replayed as
// the other. The purpose is also the GCM additional data, which makes that true twice over.
//
// `unseal` answers null for anything it cannot open (wrong key, flipped bit, truncated value, older
// format). It never throws and never returns partial plaintext.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Shorter than this and the password is treated as missing: sign-in is misconfigured. */
export const MIN_COOKIE_PASSWORD_LENGTH = 32;

/**
 * `mcp-confirm`: the two-step write tokens of the MCP server (apps/api/src/mcp). `account`: the dev
 * sign-in's carried account (../dev.ts); WorkOS carries it inside `session`.
 */
export type SealPurpose =
  | "session"
  | "state"
  | "mcp-confirm"
  | "account"
  | "mobile-start"
  | "mobile-handoff";

const FORMAT = "v1";

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(password: string, purpose: SealPurpose): Promise<CryptoKey> {
  const cacheKey = `${purpose} ${password}`;
  let key = keys.get(cacheKey);
  if (!key) {
    key = (async () => {
      const hmac = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const raw = await crypto.subtle.sign(
        "HMAC",
        hmac,
        encoder.encode(`countersign-auth:${purpose}`),
      );
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    })();
    keys.set(cacheKey, key);
  }
  return key;
}

export async function seal(
  value: unknown,
  password: string,
  purpose: SealPurpose,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
    await keyFor(password, purpose),
    encoder.encode(JSON.stringify(value)),
  );
  return `${FORMAT}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function unseal(
  sealed: string,
  password: string,
  purpose: SealPurpose,
): Promise<unknown | null> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== FORMAT) return null;
  const iv = base64UrlToBytes(parts[1] ?? "");
  const ciphertext = base64UrlToBytes(parts[2] ?? "");
  if (iv?.length !== 12 || !ciphertext || ciphertext.length < 16) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
      await keyFor(password, purpose),
      ciphertext,
    );
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

/** Constant-time string comparison, for the login `state` nonce. */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left[i % left.length] ?? 0) ^ (right[i % right.length] ?? 0);
  }
  return difference === 0 && left.length > 0;
}

export function randomToken(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}
