import { sha256Bytes, toHex } from "../runtime";
import type { ObjectInfo, ObjectStore } from "./object-store";

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Where a client's original lives: per client, then by sha256. Keys carry the tenant so one
 * client's bytes are never served as another's, even when two clients upload the same file.
 */
// DECISION: dedupe by sha256 within a client, not across clients (invariant 1: nothing one client
// stores is used for another).
export function contentKey(tenantId: string, sha256: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error(`not a tenant id: ${tenantId}`);
  if (!SHA256_RE.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
  return `tenants/${tenantId.toLowerCase()}/content/${sha256.slice(0, 2)}/${sha256}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256Bytes(bytes));
}

export interface StoredContent {
  key: string;
  sha256: string;
  size: number;
  contentType: string;
  /** False when the same bytes were already stored for this client. */
  created: boolean;
}

export class ContentIntegrityError extends Error {
  constructor(readonly key: string) {
    super(`stored bytes at ${key} do not match their sha256`);
    this.name = "ContentIntegrityError";
  }
}

/**
 * Content-addressed originals over any ObjectStore: written once per client and sha256, never
 * mutated, checked on read.
 */
export class ContentStore {
  constructor(private readonly store: ObjectStore) {}

  async put(input: {
    tenantId: string;
    bytes: Uint8Array;
    contentType?: string;
    /** E.g. the original filename; kept only on the first write. */
    metadata?: Record<string, string>;
  }): Promise<StoredContent> {
    const sha256 = await sha256Hex(input.bytes);
    const key = contentKey(input.tenantId, sha256);
    const written = await this.store.put(key, input.bytes, {
      sha256,
      onlyIfAbsent: true,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    const stored: ObjectInfo | null = written ?? (await this.store.head(key));
    if (!stored) throw new Error(`object ${key} vanished after write`);
    return {
      key,
      sha256,
      size: stored.size,
      contentType: stored.contentType,
      created: written !== null,
    };
  }

  async has(tenantId: string, sha256: string): Promise<boolean> {
    return (await this.store.head(contentKey(tenantId, sha256))) !== null;
  }

  async head(tenantId: string, sha256: string): Promise<ObjectInfo | null> {
    return this.store.head(contentKey(tenantId, sha256));
  }

  /** The bytes, verified against their address; null when this client has no such content. */
  async get(
    tenantId: string,
    sha256: string,
  ): Promise<{ bytes: Uint8Array; info: ObjectInfo } | null> {
    const key = contentKey(tenantId, sha256);
    const o = await this.store.get(key);
    if (!o) return null;
    if ((await sha256Hex(o.bytes)) !== sha256) throw new ContentIntegrityError(key);
    return o;
  }
}
