// RS256 keys for the Teams bot on Web Crypto (Workers and Node 22 alike): the Bot Connector
// publishes its signing keys as JWKs (with an `endorsements` list per key), so they are imported
// from `n` and `e`. Reading a JWT and checking an RS256 signature are Google Chat's helpers
// (../gchat/jwt), which know nothing of Google. The package has no DOM or Workers types, so Web
// Crypto is reached through the narrow type below. Nothing here logs a key, a token or a claim.

import type { RsaKey } from "../gchat/jwt";

export { type DecodedJwt, decodeJwt, type RsaKey, verifyRs256 } from "../gchat/jwt";

/** An RSA public key as a JWK: only what verification needs. */
export interface RsaPublicJwk {
  kty: "RSA";
  n: string;
  e: string;
}

interface JwkSubtle {
  importKey(
    format: "jwk",
    keyData: RsaPublicJwk & { alg: "RS256"; ext: boolean },
    algorithm: { name: "RSASSA-PKCS1-v1_5"; hash: "SHA-256" },
    extractable: boolean,
    usages: "verify"[],
  ): Promise<RsaKey>;
}

function jwkSubtle(): JwkSubtle {
  const c = (globalThis as unknown as { crypto?: { subtle?: JwkSubtle } }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this runtime");
  return c.subtle;
}

/** base64url without padding: what a JWK's `n` and `e` are. */
function isBase64Url(s: string): boolean {
  for (const ch of s) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_";
    if (!ok) return false;
  }
  return true;
}

/** A published RSA key, for RS256 verification; null when it isn't one we can use. */
export async function importRsaJwk(jwk: RsaPublicJwk): Promise<RsaKey | null> {
  // A 2048–4096-bit modulus is 342–683 base64url characters; the exponent is a few.
  if (jwk.n.length < 300 || jwk.n.length > 1400 || jwk.e.length < 1 || jwk.e.length > 12) {
    return null;
  }
  if (!isBase64Url(jwk.n) || !isBase64Url(jwk.e)) return null;
  try {
    return await jwkSubtle().importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}
