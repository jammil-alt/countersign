/**
 * Object storage for originals (documents, attachments, uploads): R2 in the Worker, memory in
 * tests. Objects are written once and never mutated (ARCHITECTURE §7: originals in R2 keyed by
 * sha256), so the interface has no update.
 */
// DECISION: whole-object bytes, not streams, in v1: originals are invoices and attachments (a few
// MB at most), and Uint8Array keeps the package free of stream types.
export interface ObjectInfo {
  key: string;
  size: number;
  contentType: string;
  /** Hex sha256 of the bytes, when known (always, for objects written through ContentStore). */
  sha256: string | null;
  metadata: Record<string, string>;
}

export interface StoredObject {
  info: ObjectInfo;
  bytes: Uint8Array;
}

export interface PutOptions {
  contentType?: string;
  /** Hex sha256 of the bytes: stored with the object and, on R2, checked by the server. */
  sha256?: string;
  metadata?: Record<string, string>;
  /** Only write when nothing exists at the key (content-addressed writes). */
  onlyIfAbsent?: boolean;
}

export interface ListResult {
  objects: ObjectInfo[];
  cursor: string | null;
}

export interface ObjectStore {
  /** Returns the stored object's info; with `onlyIfAbsent`, null when the key already existed. */
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<ObjectInfo | null>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectInfo | null>;
  /** For retention and tests; originals are never deleted by normal operation. */
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<ListResult>;
}

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";
/** customMetadata key that carries the hex sha256 on R2. */
export const SHA256_METADATA_KEY = "sha256";
