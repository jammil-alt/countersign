import {
  DEFAULT_CONTENT_TYPE,
  type ListResult,
  type ObjectInfo,
  type ObjectStore,
  type PutOptions,
  type StoredObject,
} from "./object-store";

/** An ObjectStore in memory, for tests and local tools. Copies bytes in and out. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  get size(): number {
    return this.objects.size;
  }

  async put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<ObjectInfo | null> {
    if (opts.onlyIfAbsent && this.objects.has(key)) return null;
    const info: ObjectInfo = {
      key,
      size: bytes.length,
      contentType: opts.contentType ?? DEFAULT_CONTENT_TYPE,
      sha256: opts.sha256 ?? null,
      metadata: { ...opts.metadata },
    };
    this.objects.set(key, { info, bytes: bytes.slice() });
    return { ...info, metadata: { ...info.metadata } };
  }

  async get(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key);
    return o
      ? { info: { ...o.info, metadata: { ...o.info.metadata } }, bytes: o.bytes.slice() }
      : null;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    const o = this.objects.get(key);
    return o ? { ...o.info, metadata: { ...o.info.metadata } } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<ListResult> {
    const keys = [...this.objects.keys()]
      .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
      .sort()
      .filter((k) => !opts.cursor || k > opts.cursor);
    const limit = opts.limit ?? 1000;
    const page = keys.slice(0, limit);
    return {
      objects: page.map((k) => ({ ...(this.objects.get(k) as StoredObject).info })),
      cursor: keys.length > limit ? (page.at(-1) ?? null) : null,
    };
  }
}
