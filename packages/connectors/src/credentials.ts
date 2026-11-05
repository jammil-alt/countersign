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
 * Crypto returns it). The plaintext is the connector's credentials as JSON (tokens, realm id,
 * expiry).
 *
 * - v1: under the deployment's master key named by `kid` (`ENCRYPTION_KEY`). Still decrypted;
 *   never written any more (the hourly cron re-encrypts these rows as v2).
 * - v2 (docs/plan.md §1.26): under the client's own data key, `kid` = its `tenant_key` id. The
 *   data key is stored only wrapped by the master key, so destroying it makes every v2 envelope of
 *   that client unreadable at once, and a master key rotation re-wraps keys, not envelopes.
 */
export const CredentialEnvelopeV1 = z.object({
  v: z.literal(1),
  alg: z.literal("A256GCM"),
  kid: z.string().min(1),
  iv: z.string().min(1),
  ct: z.string().min(1),
});
export type CredentialEnvelopeV1 = z.infer<typeof CredentialEnvelopeV1>;

export const CredentialEnvelopeV2 = z.object({
  v: z.literal(2),
  alg: z.literal("A256GCM"),
  kid: z.string().min(1),
  iv: z.string().min(1),
  ct: z.string().min(1),
});
export type CredentialEnvelopeV2 = z.infer<typeof CredentialEnvelopeV2>;

export const CredentialEnvelope = z.discriminatedUnion("v", [
  CredentialEnvelopeV1,
  CredentialEnvelopeV2,
]);
export type CredentialEnvelope = z.infer<typeof CredentialEnvelope>;

/** A client data key wrapped by a master key (`tenant_key.wrapped_key`). */
export const WrappedKey = z.object({
  v: z.literal(1),
  alg: z.literal("A256GCM"),
  /** The master key's id. */
  kid: z.string().min(1),
  iv: z.string().min(1),
  ct: z.string().min(1),
});
export type WrappedKey = z.infer<typeof WrappedKey>;

/**
 * Additional authenticated data: the ciphertext only decrypts for the connection it was written
 * for, so a row's credentials copied onto another client's connection (or another connection of
 * the same client) fail to decrypt instead of acting there.
 */
export interface CredentialBinding {
  tenantId: string;
  connectionId: string;
}

export type CredentialErrorCode =
  | "invalid_key"
  | "unknown_key"
  | "key_destroyed"
  | "malformed"
  | "decrypt_failed";

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
// ENCRYPTION_KEY_PREVIOUS, let the hourly cron re-wrap client keys (CredentialCipher.rewrap) and
// re-encrypt v1 rows as v2, then drop the old key" (docs/operations.md).
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
const AAD_PREFIX_V2 = "countersign/credentials/v2";
const WRAP_PREFIX = "countersign/tenant-key/v1";
const KID_LABEL = "countersign/credential-key-id/v1";

function aad(binding: CredentialBinding, prefix = AAD_PREFIX): Uint8Array {
  if (!binding.tenantId || !binding.connectionId) {
    throw new CredentialError("malformed", "credentials must be bound to a tenant and connection");
  }
  return utf8(`${prefix}|${binding.tenantId}|${binding.connectionId}`);
}

/** A wrapped data key opens only for its client (additional data = the client id). */
function wrapAad(tenantId: string): Uint8Array {
  if (!tenantId) throw new CredentialError("malformed", "a data key must belong to a client");
  return utf8(`${WRAP_PREFIX}|${tenantId}`);
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

async function importAesKey(raw: Uint8Array): Promise<CryptoKeyLike> {
  return subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function decodeParts(env: { iv: string; ct: string }): { iv: Uint8Array; ct: Uint8Array } {
  try {
    return { iv: fromBase64(env.iv), ct: fromBase64(env.ct) };
  } catch {
    throw new CredentialError("malformed", "credential envelope is not valid base64");
  }
}

async function sealJson(
  key: CryptoKeyLike,
  value: JsonObject,
  additionalData: Uint8Array,
): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(12);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    utf8(JSON.stringify(value)),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

async function openJson<T>(
  key: CryptoKeyLike,
  env: { iv: string; ct: string },
  additionalData: Uint8Array,
  schema?: z.ZodType<T>,
): Promise<T | JsonObject> {
  const { iv, ct } = decodeParts(env);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv, additionalData }, key, ct),
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

/**
 * The deployment's master keys (`ENCRYPTION_KEY`, and `ENCRYPTION_KEY_PREVIOUS` during a
 * rotation): they wrap each client's data key, and still open v1 envelopes. New credentials are
 * never written with them: use `forClients` (the client's own key, envelope v2).
 */
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
      map.set(kid, await importAesKey(raw));
    }
    return new CredentialCipher(current, map);
  }

  /** The ids of every key this cipher can decrypt with, current first. */
  get keyIds(): string[] {
    return [...this.keys.keys()];
  }

  private key(kid: string): CryptoKeyLike {
    const key = this.keys.get(kid);
    if (!key) {
      throw new CredentialError("unknown_key", `no key with id ${kid}; was it retired early?`);
    }
    return key;
  }

  /** The cipher for client credentials: each client's own data key, from `store`. */
  forClients(store: TenantKeyStore): VaultCipher {
    return new VaultCipher(this, store);
  }

  /**
   * A v1 envelope under the current master key. Only for tests and fixtures of v1 rows: the
   * platform writes v2 (`forClients(...).encrypt`).
   */
  async encryptV1(value: JsonObject, binding: CredentialBinding): Promise<CredentialEnvelopeV1> {
    const sealed = await sealJson(this.key(this.currentKeyId), value, aad(binding));
    return { v: 1, alg: "A256GCM", kid: this.currentKeyId, ...sealed };
  }

  /**
   * Decrypts a v1 envelope (as read from the database) for the connection it was bound to. With
   * a schema, the plaintext is validated too (invariant 5). A v2 envelope needs the client's key:
   * `forClients(...).decrypt`.
   */
  async decryptV1(envelope: unknown, binding: CredentialBinding): Promise<JsonObject>;
  async decryptV1<T>(
    envelope: unknown,
    binding: CredentialBinding,
    schema: z.ZodType<T>,
  ): Promise<T>;
  async decryptV1<T>(
    envelope: unknown,
    binding: CredentialBinding,
    schema?: z.ZodType<T>,
  ): Promise<T | JsonObject> {
    const env = parseEnvelope(envelope);
    if (env.v !== 1) {
      throw new CredentialError("unknown_key", "a v2 envelope opens only with the client's key");
    }
    return openJson(this.key(env.kid), env, aad(binding), schema);
  }

  /** Whether a v1 envelope was written with a key other than the current one. */
  needsRotation(envelope: unknown): boolean {
    const env = parseEnvelope(envelope);
    return env.v === 1 && env.kid !== this.currentKeyId;
  }

  /**
   * Re-encrypts a v1 envelope under the current master key; returns it unchanged when it already
   * is, or when it is v2 (a client key's envelope survives a master rotation: `rewrap` its key).
   */
  async rotate(envelope: unknown, binding: CredentialBinding): Promise<CredentialEnvelope> {
    const env = parseEnvelope(envelope);
    if (env.v === 2 || env.kid === this.currentKeyId) return env;
    return this.encryptV1(await this.decryptV1(env, binding), binding);
  }

  /** Wraps a client's 32-byte data key under the current master key, bound to the client. */
  async wrap(raw: Uint8Array, tenantId: string): Promise<WrappedKey> {
    if (raw.length !== 32) throw new CredentialError("invalid_key", "a data key is 32 bytes");
    const iv = randomBytes(12);
    const ct = await subtle().encrypt(
      { name: "AES-GCM", iv, additionalData: wrapAad(tenantId) },
      this.key(this.currentKeyId),
      raw,
    );
    return {
      v: 1,
      alg: "A256GCM",
      kid: this.currentKeyId,
      iv: toBase64(iv),
      ct: toBase64(new Uint8Array(ct)),
    };
  }

  /** The raw data key, for its own client only. */
  async unwrap(wrapped: unknown, tenantId: string): Promise<Uint8Array> {
    const parsed = WrappedKey.safeParse(wrapped);
    if (!parsed.success) throw new CredentialError("malformed", "not a wrapped key");
    const { iv, ct } = decodeParts(parsed.data);
    const key = this.key(parsed.data.kid);
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(
        await subtle().decrypt({ name: "AES-GCM", iv, additionalData: wrapAad(tenantId) }, key, ct),
      );
    } catch {
      throw new CredentialError("decrypt_failed", "the client's key could not be unwrapped");
    }
    if (raw.length !== 32) throw new CredentialError("malformed", "a data key is 32 bytes");
    return raw;
  }

  /** Whether a wrapped key was wrapped with a master key other than the current one. */
  needsRewrap(wrapped: unknown): boolean {
    const parsed = WrappedKey.safeParse(wrapped);
    if (!parsed.success) throw new CredentialError("malformed", "not a wrapped key");
    return parsed.data.kid !== this.currentKeyId;
  }

  /**
   * Master key rotation for client keys: re-wraps a data key under the current master key, the
   * data key itself unchanged (so its envelopes stay as they are). Unchanged when already current.
   */
  async rewrap(wrapped: unknown, tenantId: string): Promise<WrappedKey> {
    if (!this.needsRewrap(wrapped)) return WrappedKey.parse(wrapped);
    return this.wrap(await this.unwrap(wrapped, tenantId), tenantId);
  }
}

/** One client data key as stored (`tenant_key`). */
export interface TenantKeyRecord {
  id: string;
  status: "active" | "retired" | "destroyed";
  /** Null once destroyed. */
  wrapped: WrappedKey | null;
}

/**
 * Where client data keys live (`tenant_key`; packages/connectors' tenant-keys.ts over the
 * database, `memoryTenantKeys` in tests). Every call names its client.
 */
export interface TenantKeyStore {
  /**
   * The client's active key; with none yet, one is created from `wrapNew` (first use). Throws
   * `key_destroyed` for a client whose key was destroyed: nothing new is stored for it.
   */
  active(tenantId: string, wrapNew: () => Promise<WrappedKey>): Promise<TenantKeyRecord>;
  /** A key of this client by id; null when the client has none with that id. */
  get(tenantId: string, id: string): Promise<TenantKeyRecord | null>;
}

/** What reads and writes one connection's credentials: the vault cipher, or a fake in tests. */
export interface CredentialSealer {
  encrypt(value: JsonObject, binding: CredentialBinding): Promise<CredentialEnvelope>;
  decrypt(envelope: unknown, binding: CredentialBinding): Promise<JsonObject>;
}

/**
 * Connection credentials under each client's own data key (envelope v2; docs/plan.md §1.26).
 * Every new write is v2; v1 envelopes still decrypt with the master keys. Unwrapped keys are
 * kept for the life of this object (one request or one run step), never beyond.
 */
export class VaultCipher implements CredentialSealer {
  private readonly cache = new Map<string, Promise<CryptoKeyLike>>();

  constructor(
    readonly master: CredentialCipher,
    private readonly store: TenantKeyStore,
  ) {}

  private open(tenantId: string, record: TenantKeyRecord): Promise<CryptoKeyLike> {
    if (record.status === "destroyed" || !record.wrapped) {
      throw new CredentialError("key_destroyed", "the client's key was destroyed");
    }
    const cacheKey = `${tenantId}|${record.id}`;
    let key = this.cache.get(cacheKey);
    if (!key) {
      const wrapped = record.wrapped;
      key = this.master.unwrap(wrapped, tenantId).then(importAesKey);
      key.catch(() => this.cache.delete(cacheKey));
      this.cache.set(cacheKey, key);
    }
    return key;
  }

  async encrypt(value: JsonObject, binding: CredentialBinding): Promise<CredentialEnvelopeV2> {
    const record = await this.store.active(binding.tenantId, () =>
      this.master.wrap(randomBytes(32), binding.tenantId),
    );
    const key = await this.open(binding.tenantId, record);
    const sealed = await sealJson(key, value, aad(binding, AAD_PREFIX_V2));
    return { v: 2, alg: "A256GCM", kid: record.id, ...sealed };
  }

  async decrypt(envelope: unknown, binding: CredentialBinding): Promise<JsonObject>;
  async decrypt<T>(envelope: unknown, binding: CredentialBinding, schema: z.ZodType<T>): Promise<T>;
  async decrypt<T>(
    envelope: unknown,
    binding: CredentialBinding,
    schema?: z.ZodType<T>,
  ): Promise<T | JsonObject> {
    const env = parseEnvelope(envelope);
    if (env.v === 1) {
      return schema
        ? this.master.decryptV1(env, binding, schema)
        : this.master.decryptV1(env, binding);
    }
    // The key is looked up within the binding's client: another client's key id finds nothing.
    const record = await this.store.get(binding.tenantId, env.kid);
    if (!record) throw new CredentialError("unknown_key", "no such key for this client");
    const key = await this.open(binding.tenantId, record);
    return openJson(key, env, aad(binding, AAD_PREFIX_V2), schema);
  }

  /** Whether the envelope should be re-encrypted under the client's key (it is still v1). */
  needsReencrypt(envelope: unknown): boolean {
    return parseEnvelope(envelope).v !== 2;
  }

  /** A v1 envelope re-encrypted as v2 under the client's active key; v2 comes back as it is. */
  async reencrypt(envelope: unknown, binding: CredentialBinding): Promise<CredentialEnvelope> {
    const env = parseEnvelope(envelope);
    if (env.v === 2) return env;
    return this.encrypt(await this.master.decryptV1(env, binding), binding);
  }
}

function parseEnvelope(envelope: unknown): CredentialEnvelope {
  const parsed = CredentialEnvelope.safeParse(envelope);
  if (!parsed.success) throw new CredentialError("malformed", "not a credential envelope");
  return parsed.data;
}

/** Client data keys in memory, for tests and connectors' own tests. */
export function memoryTenantKeys(): TenantKeyStore & {
  records: Map<string, TenantKeyRecord & { tenantId: string }>;
  destroy(tenantId: string): void;
} {
  const records = new Map<string, TenantKeyRecord & { tenantId: string }>();
  let n = 0;
  return {
    records,
    async active(tenantId, wrapNew) {
      const mine = [...records.values()].filter((r) => r.tenantId === tenantId);
      const active = mine.find((r) => r.status === "active");
      if (active) return active;
      if (mine.some((r) => r.status === "destroyed")) {
        throw new CredentialError("key_destroyed", "the client's key was destroyed");
      }
      n += 1;
      const id = `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
      const record = { id, tenantId, status: "active" as const, wrapped: await wrapNew() };
      records.set(id, record);
      return record;
    },
    async get(tenantId, id) {
      const r = records.get(id);
      return r && r.tenantId === tenantId ? r : null;
    },
    destroy(tenantId) {
      for (const r of records.values()) {
        if (r.tenantId === tenantId) Object.assign(r, { status: "destroyed", wrapped: null });
      }
    },
  };
}

/** A fresh random key, base64: for local `.dev.vars` and tests. */
export function generateEncryptionKey(): string {
  return toBase64(randomBytes(32));
}
