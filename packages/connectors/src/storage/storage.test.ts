import { describe, expect, it } from "vitest";
import { utf8 } from "../runtime";
import { ContentIntegrityError, ContentStore, contentKey, sha256Hex } from "./content";
import { MemoryObjectStore } from "./memory";
import { type R2BucketLike, type R2ObjectBodyLike, R2ObjectStore } from "./r2";
import { s3UrlSigner } from "./signed-url";

const tenantA = "0190f0c8-0000-7000-8000-000000000001";
const tenantB = "0190f0c8-0000-7000-8000-000000000002";
const pdf = utf8("%PDF-1.7 invoice 1001");
// sha256 of "abc" is a well-known test vector.
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

/** An R2 bucket stand-in with the binding's behaviour that matters here. */
function fakeR2(): R2BucketLike & { puts: number } {
  const objects = new Map<
    string,
    { bytes: Uint8Array; contentType?: string; meta: Record<string, string> }
  >();
  const head = (key: string) => {
    const o = objects.get(key);
    return o
      ? {
          key,
          size: o.bytes.length,
          httpMetadata: o.contentType === undefined ? {} : { contentType: o.contentType },
          customMetadata: { ...o.meta },
        }
      : null;
  };
  const bucket = {
    puts: 0,
    async put(
      key: string,
      value: Uint8Array,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
        sha256?: string;
      },
    ) {
      if (options?.sha256 && (await sha256Hex(value)) !== options.sha256) {
        throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
      }
      bucket.puts += 1;
      const entry: { bytes: Uint8Array; contentType?: string; meta: Record<string, string> } = {
        bytes: value.slice(),
        meta: { ...options?.customMetadata },
      };
      if (options?.httpMetadata?.contentType) entry.contentType = options.httpMetadata.contentType;
      objects.set(key, entry);
      return head(key);
    },
    async get(key: string): Promise<R2ObjectBodyLike | null> {
      const h = head(key);
      const o = objects.get(key);
      if (!h || !o) return null;
      return { ...h, arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer };
    },
    async head(key: string) {
      return head(key);
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()]
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .sort();
      return {
        objects: keys.map((k) => head(k) as NonNullable<ReturnType<typeof head>>),
        truncated: false,
      };
    },
  };
  return bucket;
}

describe("sha256 content addressing", () => {
  it("hashes bytes to hex", async () => {
    expect(await sha256Hex(utf8("abc"))).toBe(ABC);
  });

  it("keys content per client by its hash", () => {
    expect(contentKey(tenantA, ABC)).toBe(`tenants/${tenantA}/content/ba/${ABC}`);
    expect(() => contentKey(tenantA, "nothex")).toThrow();
    expect(() => contentKey("../other", ABC)).toThrow();
  });
});

for (const [name, make] of [
  ["memory", () => new MemoryObjectStore()],
  ["R2", () => new R2ObjectStore(fakeR2())],
] as const) {
  describe(`ContentStore over ${name}`, () => {
    it("stores once per client and sha256, and reads back verified", async () => {
      const store = new ContentStore(make());
      const first = await store.put({
        tenantId: tenantA,
        bytes: pdf,
        contentType: "application/pdf",
        metadata: { filename: "inv-1001.pdf" },
      });
      expect(first).toMatchObject({
        sha256: await sha256Hex(pdf),
        size: pdf.length,
        contentType: "application/pdf",
        created: true,
      });
      const again = await store.put({ tenantId: tenantA, bytes: pdf, contentType: "image/png" });
      expect(again).toEqual({ ...first, created: false });

      const got = await store.get(tenantA, first.sha256);
      expect(got?.bytes).toEqual(pdf);
      expect(got?.info.metadata.filename).toBe("inv-1001.pdf");
      expect(got?.info.sha256).toBe(first.sha256);
      expect(await store.has(tenantA, first.sha256)).toBe(true);
    });

    it("keeps clients apart even for identical bytes", async () => {
      const store = new ContentStore(make());
      const a = await store.put({ tenantId: tenantA, bytes: pdf });
      expect(await store.has(tenantB, a.sha256)).toBe(false);
      expect(await store.get(tenantB, a.sha256)).toBeNull();
      const b = await store.put({ tenantId: tenantB, bytes: pdf });
      expect(b.created).toBe(true);
      expect(b.key).not.toBe(a.key);
    });

    it("detects bytes that don't match their address", async () => {
      const objects = make();
      const store = new ContentStore(objects);
      const { key, sha256 } = await store.put({ tenantId: tenantA, bytes: pdf });
      await objects.delete(key);
      await objects.put(key, utf8("tampered"));
      await expect(store.get(tenantA, sha256)).rejects.toBeInstanceOf(ContentIntegrityError);
    });
  });
}

describe("ObjectStore basics", () => {
  it("memory: put only-if-absent, head, list with paging, delete", async () => {
    const s = new MemoryObjectStore();
    expect(await s.put("a/1", utf8("x"), { contentType: "text/plain" })).toMatchObject({ size: 1 });
    expect(await s.put("a/1", utf8("y"), { onlyIfAbsent: true })).toBeNull();
    expect((await s.get("a/1"))?.bytes).toEqual(utf8("x"));
    await s.put("a/2", utf8("y"));
    await s.put("b/1", utf8("z"));
    const page = await s.list({ prefix: "a/", limit: 1 });
    expect(page.objects.map((o) => o.key)).toEqual(["a/1"]);
    const next = await s.list({ prefix: "a/", limit: 1, cursor: page.cursor ?? "" });
    expect(next).toMatchObject({ objects: [{ key: "a/2" }], cursor: null });
    await s.delete("a/1");
    expect(await s.head("a/1")).toBeNull();
  });

  it("R2: passes the sha256 for server-side checking", async () => {
    const bucket = fakeR2();
    const s = new R2ObjectStore(bucket);
    await expect(s.put("k", utf8("abc"), { sha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/);
    const ok = await s.put("k", utf8("abc"), { sha256: ABC, contentType: "text/plain" });
    expect(ok).toMatchObject({ key: "k", size: 3, sha256: ABC, contentType: "text/plain" });
    expect(await s.put("k", utf8("abc"), { onlyIfAbsent: true })).toBeNull();
    expect(bucket.puts).toBe(1);
  });
});

describe("signed URLs", () => {
  it("presigns a GET for 5 minutes by default", async () => {
    const signer = s3UrlSigner({
      endpoint: "https://acct.r2.cloudflarestorage.com/",
      bucket: "countersign-test",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    });
    const url = await signer.signedGetUrl(`tenants/${tenantA}/content/ba/${ABC}`);
    expect(url).toMatch(
      new RegExp(
        `^https://acct\\.r2\\.cloudflarestorage\\.com/countersign-test/tenants/${tenantA}/content/ba/${ABC}\\?`,
      ),
    );
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("X-Amz-Signature=");
    expect(url).not.toContain("wJalrXUtnFEMI");
    await expect(signer.signedGetUrl("k", { expiresInSeconds: 0 })).rejects.toThrow();
  });
});
