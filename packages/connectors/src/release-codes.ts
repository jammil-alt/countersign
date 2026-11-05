// Human release codes (docs/plan.md §1.26 "Human release"): six random digits from the platform's
// CSPRNG, kept only as an HMAC-SHA256 under a key derived from ENCRYPTION_KEY with a fixed label
// (never the raw key), and compared in constant time. The code itself lives only in the message
// that carries it and in what the person types back; nothing here logs or returns it.

import { constantTimeEqual } from "./http";
import { fromBase64, hmacKey, randomBytes, subtle, toHex, utf8 } from "./runtime";

/** The label the code key is derived under: changing it voids every pending code. */
const LABEL = "countersign/access-release/v1";
const DIGITS = 6;
const SPACE = 10 ** DIGITS;
/** The largest multiple of SPACE under 2^32: draws at or above it are thrown away (no bias). */
const LIMIT = Math.floor(0x1_0000_0000 / SPACE) * SPACE;

/** Six digits, uniform, from crypto.getRandomValues. */
export function generateReleaseCode(): string {
  for (;;) {
    const b = randomBytes(4);
    const n =
      ((b[0] ?? 0) * 0x1_000000 + ((b[1] ?? 0) << 16) + ((b[2] ?? 0) << 8) + (b[3] ?? 0)) >>> 0;
    if (n < LIMIT) return String(n % SPACE).padStart(DIGITS, "0");
  }
}

function rawKey(b64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = fromBase64(b64);
  } catch {
    throw new Error("ENCRYPTION_KEY is not valid base64");
  }
  if (raw.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
  return raw;
}

/** HMAC-derive: the code key is HMAC-SHA256(master key, label), so the master key is never used. */
async function deriveKey(master: string): Promise<Uint8Array> {
  const mac = await subtle().sign("HMAC", await hmacKey(rawKey(master)), utf8(LABEL));
  return new Uint8Array(mac);
}

/**
 * Hashes and checks codes. Bound to the request: the HMAC covers the request's id with the code,
 * so a hash says nothing about another request's code.
 */
// DECISION: HMAC-derive with a fixed label (as the credential key ids are derived), not HKDF: the
// narrow Web Crypto surface this package uses has HMAC, and one HMAC of a label is a sound KDF for
// a uniformly random 32-byte key. During a key rotation, codes made under the previous key still
// check (they live 10 minutes).
export class ReleaseCodeKeys {
  private constructor(
    private readonly current: Uint8Array,
    private readonly previous: readonly Uint8Array[],
  ) {}

  static async create(keys: {
    current: string;
    previous?: readonly string[] | undefined;
  }): Promise<ReleaseCodeKeys> {
    return new ReleaseCodeKeys(
      await deriveKey(keys.current),
      await Promise.all((keys.previous ?? []).map(deriveKey)),
    );
  }

  private static async mac(key: Uint8Array, releaseId: string, code: string): Promise<string> {
    const sig = await subtle().sign("HMAC", await hmacKey(key), utf8(`${releaseId}:${code}`));
    return toHex(new Uint8Array(sig));
  }

  /** The value stored in `access_release.code_hash`. */
  hash(releaseId: string, code: string): Promise<string> {
    return ReleaseCodeKeys.mac(this.current, releaseId, code);
  }

  /** Whether `code` is the request's, compared in constant time under each key. */
  async matches(releaseId: string, code: string, stored: string): Promise<boolean> {
    let ok = false;
    for (const key of [this.current, ...this.previous]) {
      // Every key is tried, so the time taken doesn't say which one matched.
      if (constantTimeEqual(await ReleaseCodeKeys.mac(key, releaseId, code), stored)) ok = true;
    }
    return ok;
  }
}
