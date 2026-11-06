// RS256 for the Google Chat app on Web Crypto (Workers and Node 22 alike): signing the service
// account's token request with its PKCS#8 key, and verifying the tokens Google Chat sends with the
// certificates Google publishes for `chat@system.gserviceaccount.com`. The package has no DOM or
// Workers types, so Web Crypto is reached through the narrow types below (as ../runtime does for
// the parts the other connectors use). Nothing here logs a key, a token or a claim.

import { fromBase64, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../runtime";

interface RsaKeyLike {
  readonly type: string;
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

interface RsaSubtle {
  importKey(
    format: "pkcs8" | "spki",
    keyData: Uint8Array,
    algorithm: typeof RS256,
    extractable: boolean,
    usages: ("sign" | "verify")[],
  ): Promise<RsaKeyLike>;
  sign(algorithm: "RSASSA-PKCS1-v1_5", key: RsaKeyLike, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: "RSASSA-PKCS1-v1_5",
    key: RsaKeyLike,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

function rsaSubtle(): RsaSubtle {
  const c = (globalThis as unknown as { crypto?: { subtle?: RsaSubtle } }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this runtime");
  return c.subtle;
}

export type RsaKey = RsaKeyLike;

/** Largest PEM we read (a 4096-bit key or certificate is well under 8 KB). */
const MAX_PEM = 16 * 1024;

/** The base64 body of the first PEM block of this label, decoded; null when there is none. */
export function pemBody(pem: string, label: string): Uint8Array | null {
  if (pem.length > MAX_PEM) return null;
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  const a = pem.indexOf(begin);
  if (a < 0) return null;
  const b = pem.indexOf(end, a + begin.length);
  if (b < 0) return null;
  let body = "";
  for (const ch of pem.slice(a + begin.length, b)) {
    if (ch !== "\n" && ch !== "\r" && ch !== " " && ch !== "\t") body += ch;
  }
  try {
    return fromBase64(body);
  } catch {
    return null;
  }
}

/** A service account's private key (PEM, PKCS#8), for signing. */
export async function importSigningKey(pem: string): Promise<RsaKey> {
  const der = pemBody(pem, "PRIVATE KEY");
  if (!der) throw new Error("the service account's private key is not a PKCS#8 PEM");
  return rsaSubtle().importKey("pkcs8", der, RS256, false, ["sign"]);
}

/** A JWT signed with RS256: `header.claims.signature`, base64url. */
export async function signJwt(
  key: RsaKey,
  header: Record<string, string>,
  claims: Record<string, string | number>,
): Promise<string> {
  const part = (v: unknown) => toBase64Url(utf8(JSON.stringify(v)));
  const input = `${part({ ...header, alg: "RS256", typ: "JWT" })}.${part(claims)}`;
  const sig = await rsaSubtle().sign("RSASSA-PKCS1-v1_5", key, utf8(input));
  return `${input}.${toBase64Url(new Uint8Array(sig))}`;
}

// --- X.509: the certificate's public key, for verifying -----------------------------------------

/** One DER element: where its contents start and end, and where the whole element ends. */
interface Der {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

function readDer(bytes: Uint8Array, at: number): Der | null {
  if (at + 2 > bytes.length) return null;
  const tag = bytes[at] as number;
  let len = bytes[at + 1] as number;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    // Lengths of one to three bytes (16 MB) are all a certificate needs.
    if (n < 1 || n > 3 || p + n > bytes.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (bytes[p + i] as number);
    p += n;
  }
  if (p + len > bytes.length) return null;
  return { tag, start: at, contentStart: p, end: p + len };
}

const SEQUENCE = 0x30;
const VERSION = 0xa0;

/**
 * The SubjectPublicKeyInfo of a DER certificate (RFC 5280 §4.1): Certificate → tbsCertificate →
 * [version], serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.
 */
export function certificatePublicKey(der: Uint8Array): Uint8Array | null {
  const cert = readDer(der, 0);
  if (cert?.tag !== SEQUENCE) return null;
  const tbs = readDer(der, cert.contentStart);
  if (tbs?.tag !== SEQUENCE) return null;
  let at = tbs.contentStart;
  let field = readDer(der, at);
  if (field?.tag === VERSION) {
    at = field.end;
    field = readDer(der, at);
  }
  // serialNumber, signature, issuer, validity, subject: five elements to step over.
  for (let i = 0; i < 5; i++) {
    if (!field || field.end > tbs.end) return null;
    at = field.end;
    field = readDer(der, at);
  }
  if (field?.tag !== SEQUENCE || field.end > tbs.end) return null;
  return der.slice(field.start, field.end);
}

/** A PEM certificate's RSA public key, for RS256 verification. */
export async function importCertificateKey(pem: string): Promise<RsaKey | null> {
  const der = pemBody(pem, "CERTIFICATE");
  const spki = der ? certificatePublicKey(der) : null;
  if (!spki) return null;
  try {
    return await rsaSubtle().importKey("spki", spki, RS256, false, ["verify"]);
  } catch {
    return null;
  }
}

// --- Reading a JWT ------------------------------------------------------------------------------

/** Longest token we read: Google's are about 1 KB. */
export const MAX_JWT_LENGTH = 8 * 1024;

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: Uint8Array;
  signature: Uint8Array;
}

function jsonObject(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fromUtf8(fromBase64Url(part)));
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The three parts of a compact JWT, decoded; null when it isn't one. Nothing is checked yet. */
export function decodeJwt(token: string): DecodedJwt | null {
  if (token.length === 0 || token.length > MAX_JWT_LENGTH) return null;
  const a = token.indexOf(".");
  const b = a < 0 ? -1 : token.indexOf(".", a + 1);
  if (a < 1 || b < 0 || token.indexOf(".", b + 1) >= 0 || b === token.length - 1) return null;
  const header = jsonObject(token.slice(0, a));
  const claims = jsonObject(token.slice(a + 1, b));
  if (!header || !claims) return null;
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(token.slice(b + 1));
  } catch {
    return null;
  }
  return { header, claims, signingInput: utf8(token.slice(0, b)), signature };
}

/** Whether `jwt`'s signature is the key's (RS256). */
export async function verifyRs256(key: RsaKey, jwt: DecodedJwt): Promise<boolean> {
  try {
    return await rsaSubtle().verify("RSASSA-PKCS1-v1_5", key, jwt.signature, jwt.signingInput);
  } catch {
    return false;
  }
}
