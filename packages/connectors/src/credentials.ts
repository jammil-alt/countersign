import type { JsonObject } from "@countersign/core";
import { z } from "zod";
import {
  type CryptoKeyLike,
  fromBase64,
  fromUtf8,
  hmacKey,
  randomBytes,
  subtle,
  toBase64,
  toHex,
  utf8,
} from "./runtime";

/**
 * What `connection.credentials_encrypted` holds: AES-256-GCM ciphertext (tag appended, as Web
 * Crypto returns it) under the key named by `kid`. The plaintext is the connector's credentials as
 * JSON (tokens, realm id, expiry).
 */
export const CredentialEnvelope = z.object({
  v: z.literal(1),
  alg: z.literal("A256GCM"),
  kid: z.string().min(1),
  iv: z.string().min(1),
  ct: z.string().min(1),
});
export type CredentialEnvelope = z.infer<typeof CredentialEnvelope>;

/**
 * Additional authenticated data: the ciphertext only decrypts for the connection it was written
 * for, so a row's credentials copied onto another client's connection (or another connection of
 * the same client) fail to decrypt instead of acting there.
 */
export interface CredentialBinding {
  tenantId: string;
  connectionId: string;
}

export type CredentialErrorCode = "invalid_key" | "unknown_key" | "malformed" | "decrypt_failed";

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface CredentialKeys {
  /** The key new ciphertexts are written with: 32 bytes, base64 (`ENCRYPTION_KEY`). */
  current: string;
  /** Retired keys still accepted for decryption until every row is re-encrypted. */
  previous?: readonly string[] | undefined;
}

/**
 * Reads the keys from the Worker's env. `ENCRYPTION_KEY` is the current key (ARCHITECTURE §17);
 * during a rotation the old one moves to `ENCRYPTION_KEY_PREVIOUS` (comma-separated if several).
 */
// DECISION: rotation is "add the new key as ENCRYPTION_KEY, move the old one to
// ENCRYPTION_KEY_PREVIOUS, re-encrypt rows with CredentialCipher.rotate, then drop the old key".
export function credentialKeysFromEnv(env: {
  ENCRYPTION_KEY?: string | undefined;
  ENCRYPTION_KEY_PREVIOUS?: string | undefined;
}): CredentialKeys {
  if (!env.ENCRYPTION_KEY) throw new CredentialError("invalid_key", "ENCRYPTION_KEY is not set");
  const previous = (env.ENCRYPTION_KEY_PREVIOUS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { current: env.ENCRYPTION_KEY, previous };
}

const AAD_PREFIX = "countersign/credentials/v1";
const KID_LABEL = "countersign/credential-key-id/v1";

function aad(binding: CredentialBinding): Uint8Array {
  if (!binding.tenantId || !binding.connectionId) {
    throw new CredentialError("malformed", "credentials must be bound to a tenant and connection");
  }
  return utf8(`${AAD_PREFIX}|${binding.tenantId}|${binding.connectionId}`);
}

function decodeKey(b64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = fromBase64(b64);
  } catch {
    throw new CredentialError("invalid_key", "encryption key is not valid base64");
  }
  if (raw.length !== 32) {
    throw new CredentialError("invalid_key", `encryption key must be 32 bytes, got ${raw.length}`);
  }
  return raw;
}

/**
 * The key id is derived from the key (HMAC of a fixed label, first 8 bytes), so the env holds only
 * keys and an id can never point at the wrong one. It reveals nothing usable about the key.
 */
// DECISION: derived key ids rather than named keys; nothing to keep in sync between env vars.
async function keyId(raw: Uint8Array): Promise<string> {
  const mac = await subtle().sign("HMAC", await hmacKey(raw), utf8(KID_LABEL));
  return toHex(new Uint8Array(mac).slice(0, 8));
}

/** Encrypts and decrypts connection credentials (AES-256-GCM, Web Crypto). */
export class CredentialCipher {
  private constructor(
    readonly currentKeyId: string,
    private readonly keys: ReadonlyMap<string, CryptoKeyLike>,
  ) {}

  static async create(keys: CredentialKeys): Promise<CredentialCipher> {
    const all = [keys.current, ...(keys.previous ?? [])];
    const map = new Map<string, CryptoKeyLike>();
    let current = "";
    for (const [i, b64] of all.entries()) {
      const raw = decodeKey(b64);
      const kid = await keyId(raw);
      if (i === 0) current = kid;
      if (map.has(kid)) continue;
      map.set(
        kid,
        await subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
      );
    }
    return new CredentialCipher(current, map);
  }

  /** The ids of every key this cipher can decrypt with, current first. */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  async encrypt(value: JsonObject, binding: CredentialBinding): Promise<CredentialEnvelope> {
    const key = this.keys.get(this.currentKeyId);
    if (!key) throw new CredentialError("unknown_key", "current key missing");
    const iv = randomBytes(12);
    const ct = await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: aad(binding) },
      key,
      utf8(JSON.stringify(value)),
    );
    return {
      v: 1,
      alg: "A256GCM",
      kid: this.currentKeyId,
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ct)),
    };
  }

  /**
   * Decrypts an envelope (as read from the database) for the connection it was bound to. With a
   * schema, the plaintext is validated too (invariant 5).
   */
  async decrypt(envelope: unknown, binding: CredentialBinding): Promise<JsonObject>;
  async decrypt<T>(envelope: unknown, binding: CredentialBinding, schema: z.ZodType<T>): Promise<T>;
  async decrypt<T>(
    envelope: unknown,
    binding: CredentialBinding,
    schema?: z.ZodType<T>,
  ): Promise<T | JsonObject> {
    const env = parseEnvelope(envelope);
    const key = this.keys.get(env.kid);
    if (!key) {
      throw new CredentialError("unknown_key", `no key with id ${env.kid}; was it retired early?`);
    }
    let iv: Uint8Array;
    let ct: Uint8Array;
    try {
      iv = fromBase64(env.iv);
      ct = fromBase64(env.ct);
    } catch {
      throw new CredentialError("malformed", "credential envelope is not valid base64");
    }
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad(binding) }, key, ct),
      );
    } catch {
      // Same message for a wrong key, a tampered ciphertext and a wrong binding: no oracle.
      throw new CredentialError("decrypt_failed", "credentials could not be decrypted");
    }
    let value: unknown;
    try {
      value = JSON.parse(fromUtf8(plain));
    } catch {
      throw new CredentialError("malformed", "decrypted credentials are not JSON");
    }
    if (schema) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new CredentialError("malformed", "decrypted credentials do not match their schema");
      }
      return parsed.data;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CredentialError("malformed", "decrypted credentials are not an object");
    }
    return value as JsonObject;
  }

  /** Whether the envelope was written with a key other than the current one. */
  needsRotation(envelope: unknown): boolean {
    return parseEnvelope(envelope).kid !== this.currentKeyId;
  }

  /** Re-encrypts under the current key; returns the envelope unchanged when it already is. */
  async rotate(envelope: unknown, binding: CredentialBinding): Promise<CredentialEnvelope> {
    const env = parseEnvelope(envelope);
    if (env.kid === this.currentKeyId) return env;
    return this.encrypt(await this.decrypt(env, binding), binding);
  }
}

function parseEnvelope(envelope: unknown): CredentialEnvelope {
  const parsed = CredentialEnvelope.safeParse(envelope);
  if (!parsed.success) throw new CredentialError("malformed", "not a credential envelope");
  return parsed.data;
}

/** A fresh random key, base64: for local `.dev.vars` and tests. */
export function generateEncryptionKey(): string {
  return toBase64(randomBytes(32));
}
