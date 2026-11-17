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
  /**
   * Reads the stored credentials afresh (past any cache) and passes them to `decide`. When it
   * returns a value, that is written, but only if the stored credentials are still the ones it was
   * shown (compare-and-swap; another isolate may have written meanwhile, and then `decide` is
   * shown the newer ones). Returns what is stored afterwards. `decide(…) => null` only reads.
   * Optional: without it, tokenManager reads and writes with `get` and `set`.
   */
  update?(decide: (stored: JsonObject | null) => JsonObject | null): Promise<JsonObject | null>;
  /**
   * A call works again after renewing access had been failing (tokenManager): the platform
   * closes an open `refresh_failing` issue on the connection. Optional and best effort.
   */
  accessRestored?(): Promise<void>;
}

/** Tries of `update` before it gives up (each one lost to another writer). */
const UPDATE_TRIES = 5;

/**
 * The accessor over `connection.credentials_encrypted`: `load` reads the stored envelope and
 * `save` writes a new one (both inside the caller's `withTenant()` transaction). Decrypted values
 * are cached for the life of the accessor (one run step), not beyond. With `saveIf`, `update`
 * is a compare-and-swap on the stored envelope.
 */
export function encryptedCredentials(opts: {
  /** The vault cipher (the client's own key; v1 envelopes still open). */
  cipher: CredentialSealer;
  binding: CredentialBinding;
  load: () => Promise<unknown>;
  save: (envelope: CredentialEnvelope) => Promise<void>;
  /**
   * Writes `envelope` only if the stored one is still `expected` (as `load` returned it; null:
   * none stored). True when it was written.
   */
  saveIf?: (envelope: CredentialEnvelope, expected: unknown) => Promise<boolean>;
}): CredentialsAccessor {
  let cached: JsonObject | null | undefined;
  const open = async (stored: unknown) =>
    stored == null ? null : await opts.cipher.decrypt(stored, opts.binding);
  const accessor: CredentialsAccessor = {
    async get() {
      if (cached !== undefined) return cached;
      cached = await open(await opts.load());
      return cached;
    },
    async set(value) {
      await opts.save(await opts.cipher.encrypt(value, opts.binding));
      cached = value;
    },
  };
  const saveIf = opts.saveIf;
  if (saveIf) {
    // DECISION: the swap compares the stored envelope (every write has a fresh IV, so an equal
    // envelope is an unchanged value) and decrypts outside the write: a run's or a request's one
    // pooled connection can't wait on a row lock while the client's key is read.
    accessor.update = async (decide) => {
      for (let i = 0; i < UPDATE_TRIES; i++) {
        const raw = (await opts.load()) ?? null;
        const stored = await open(raw);
        const next = decide(stored);
        if (next === null) {
          cached = stored;
          return stored;
        }
        if (await saveIf(await opts.cipher.encrypt(next, opts.binding), raw)) {
          cached = next;
          return next;
        }
      }
      throw new Error("the connection's credentials kept changing; try again");
    };
  }
  return accessor;
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
    async update(decide: (stored: JsonObject | null) => JsonObject | null) {
      // One turn of the event loop: nothing else can write between the read and the write.
      const next = decide(value);
      if (next === null) return value;
      value = next;
      acc.writes += 1;
      return next;
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
