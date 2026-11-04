// Originals in object storage (R2 in the Worker) and the 5-minute links to them (ARCHITECTURE §16).
// With the R2 S3 API configured (STORAGE_*), links are R2 presigned URLs. Without it (local
// `wrangler dev`, or before the coordinator sets the keys), the Worker signs its own link to
// `GET /api/files/:token`, which streams the bytes from the binding.

import { SIGNED_URL_TTL_SECONDS, s3UrlSigner, type UrlSigner } from "@countersign/connectors";
import type { Bindings } from "./env";
import { isProductionEnv } from "./platform";

// DECISION: one signing path everywhere when the S3 keys are missing: an HMAC over
// (storage key, filename, expiry) with a key derived from ENCRYPTION_KEY; in development without
// ENCRYPTION_KEY, a random key per isolate (links then last as long as the isolate). Production
// without either refuses to make links.
const encoder = new TextEncoder();
let devKey: Uint8Array | undefined;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmacKey(env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">): Promise<CryptoKey> {
  let raw: Uint8Array;
  if (env.ENCRYPTION_KEY?.trim()) {
    raw = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`mezonas-document-link:${env.ENCRYPTION_KEY.trim()}`),
      ),
    );
  } else if (!isProductionEnv(env)) {
    devKey ??= crypto.getRandomValues(new Uint8Array(32));
    raw = devKey;
  } else {
    throw new Error("document links need STORAGE_* or ENCRYPTION_KEY in production");
  }
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

interface LinkPayload {
  /** Storage key. */
  k: string;
  /** Filename for Content-Disposition. */
  f: string;
  /** Expiry, Unix seconds. */
  e: number;
}

export function workerUrlSigner(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT" | "APP_ORIGIN">,
  origin: string,
  filenameOf: (key: string) => string = () => "document",
  now: () => number = () => Date.now(),
): UrlSigner {
  return {
    async signedGetUrl(key, opts = {}) {
      const ttl = opts.expiresInSeconds ?? SIGNED_URL_TTL_SECONDS;
      const payload: LinkPayload = {
        k: key,
        f: filenameOf(key),
        e: Math.floor(now() / 1000) + ttl,
      };
      const body = encoder.encode(JSON.stringify(payload));
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), body));
      return `${origin.replace(/\/+$/, "")}/api/files/${b64url(body)}.${b64url(sig)}`;
    },
  };
}

/** The payload of a valid, unexpired link token; null otherwise. */
export async function verifyFileToken(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENVIRONMENT">,
  token: string,
  now: () => number = () => Date.now(),
): Promise<LinkPayload | null> {
  const [bodyText, sigText] = token.split(".");
  if (!bodyText || !sigText) return null;
  try {
    const body = unb64url(bodyText);
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(sigText), body);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as LinkPayload;
    if (typeof payload.k !== "string" || typeof payload.e !== "number") return null;
    if (payload.e * 1000 < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** R2 presigned links when the S3 API is configured; null otherwise. */
export function s3SignerFor(env: Bindings): UrlSigner | null {
  const { STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY, STORAGE_SECRET_KEY } = env;
  if (!STORAGE_ENDPOINT || !STORAGE_BUCKET || !STORAGE_ACCESS_KEY || !STORAGE_SECRET_KEY) {
    return null;
  }
  return s3UrlSigner({
    endpoint: STORAGE_ENDPOINT,
    bucket: STORAGE_BUCKET,
    accessKeyId: STORAGE_ACCESS_KEY,
    secretAccessKey: STORAGE_SECRET_KEY,
  });
}

/** The signer for this request: S3 presigning if configured, else the Worker's own links. */
export function signerFor(
  env: Bindings,
  origin: string,
  filenameOf?: (key: string) => string,
): UrlSigner {
  return s3SignerFor(env) ?? workerUrlSigner(env, origin, filenameOf);
}
