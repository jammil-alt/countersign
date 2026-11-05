import type { JsonObject } from "@countersign/core";
import {
  type CredentialBinding,
  type CredentialEnvelope,
  CredentialError,
  type CredentialSealer,
} from "./credentials";

/**
 * How a connector reaches its connection's credentials: decrypted only when asked for, and
 * written back encrypted (refreshed tokens must be persisted every time, ARCHITECTURE §6.2).
 * Tool handlers get this, never the key.
 */
export interface CredentialsAccessor {
  /** The decrypted credentials, or null when the connection has none (e.g. auth 'none'). */
  get(): Promise<JsonObject | null>;
  set(value: JsonObject): Promise<void>;
}

/**
 * The accessor over `connection.credentials_encrypted`: `load` reads the stored envelope and
 * `save` writes a new one (both inside the caller's `withTenant()` transaction). Decrypted values
 * are cached for the life of the accessor (one run step), not beyond.
 */
export function encryptedCredentials(opts: {
  /** The vault cipher (the client's own key; v1 envelopes still open). */
  cipher: CredentialSealer;
  binding: CredentialBinding;
  load: () => Promise<unknown>;
  save: (envelope: CredentialEnvelope) => Promise<void>;
}): CredentialsAccessor {
  let cached: JsonObject | null | undefined;
  return {
    async get() {
      if (cached !== undefined) return cached;
      const stored = await opts.load();
      cached = stored == null ? null : await opts.cipher.decrypt(stored, opts.binding);
      return cached;
    },
    async set(value) {
      await opts.save(await opts.cipher.encrypt(value, opts.binding));
      cached = value;
    },
  };
}

/** Plain in-memory credentials, for tests and connectors without auth. */
export function memoryCredentials(
  initial: JsonObject | null = null,
): CredentialsAccessor & { current(): JsonObject | null; writes: number } {
  let value = initial;
  const acc = {
    writes: 0,
    current: () => value,
    async get() {
      return value;
    },
    async set(next: JsonObject) {
      value = next;
      acc.writes += 1;
    },
  };
  return acc;
}

/** For connections that must have credentials: throws a clear error when they are missing. */
export async function requireCredentials(acc: CredentialsAccessor): Promise<JsonObject> {
  const value = await acc.get();
  if (value === null) throw new CredentialError("malformed", "the connection has no credentials");
  return value;
}
