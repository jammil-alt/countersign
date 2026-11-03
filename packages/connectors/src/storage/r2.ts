import {
  DEFAULT_CONTENT_TYPE,
  type ListResult,
  type ObjectInfo,
  type ObjectStore,
  type PutOptions,
  SHA256_METADATA_KEY,
  type StoredObject,
} from "./object-store";

// The parts of Cloudflare's R2 binding this store uses, typed structurally so the package needs no
// Workers types. apps/api passes `env.ARTIFACTS` (an R2Bucket), which satisfies these.

export interface R2ObjectLike {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string } | undefined;
  customMetadata?: Record<string, string> | undefined;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

function info(o: R2ObjectLike): ObjectInfo {
  const metadata = { ...o.customMetadata };
  return {
    key: o.key,
    size: o.size,
    contentType: o.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
    sha256: metadata[SHA256_METADATA_KEY] ?? null,
    metadata,
  };
}

/** ObjectStore over an R2 bucket binding. */
export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<ObjectInfo | null> {
    // DECISION: "only if absent" is a head then a put. The race between two writers of the same
    // content-addressed key writes identical bytes, so it is harmless.
    if (opts.onlyIfAbsent && (await this.bucket.head(key))) return null;
    const customMetadata = { ...opts.metadata };
    if (opts.sha256) customMetadata[SHA256_METADATA_KEY] = opts.sha256;
    const written = await this.bucket.put(key, bytes, {
      httpMetadata: { contentType: opts.contentType ?? DEFAULT_CONTENT_TYPE },
      customMetadata,
      // R2 checks the upload against it and rejects a mismatch.
      ...(opts.sha256 ? { sha256: opts.sha256 } : {}),
    });
    if (!written) throw new Error(`R2 refused the write to ${key}`);
    return info(written);
  }

  async get(key: string): Promise<StoredObject | null> {
    const o = await this.bucket.get(key);
    if (!o) return null;
    return { info: info(o), bytes: new Uint8Array(await o.arrayBuffer()) };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const o = await this.bucket.head(key);
    return o ? info(o) : null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const r = await this.bucket.list(opts);
    return { objects: r.objects.map(info), cursor: r.truncated ? (r.cursor ?? null) : null };
  }
}
