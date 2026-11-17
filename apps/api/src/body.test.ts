// Bounded body reads (audit 6.5): the limit exactly, chunk boundaries, text split mid-character,
// bytes and text the same as the platform's own reads, a declared length that is false, and the
// streamed form that fails past its limit.

import { describe, expect, it } from "vitest";
import { readableLimited, readBodyLimited, readTextLimited } from "./body";

function streamOf(chunks: Uint8Array[], onCancel?: () => void) {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const next = chunks[i++];
        if (next) c.enqueue(next);
        else c.close();
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 },
  );
}
const req = (body: BodyInit | null) =>
  new Request("https://x.test/", { method: "POST", body, duplex: "half" } as RequestInit);
/** The request with its headers replaced (a runtime keeps a client's Content-Length as sent). */
const withHeaders = (r: Request, headers: Record<string, string>) =>
  new Proxy(r, {
    get(t, p) {
      if (p === "headers") return new Headers(headers);
      const v = Reflect.get(t, p, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Request;

describe("readBodyLimited and readTextLimited", () => {
  it("take the limit exactly and refuse one byte more", async () => {
    expect((await readBodyLimited(req(new Uint8Array(10)), 10))?.length).toBe(10);
    expect(await readBodyLimited(req(new Uint8Array(11)), 10)).toBeNull();
  });

  it("stop at a chunk past the limit and cancel the stream", async () => {
    let cancelled = false;
    const over = streamOf([new Uint8Array(5), new Uint8Array(5), new Uint8Array(1)], () => {
      cancelled = true;
    });
    expect(await readBodyLimited(req(over), 10)).toBeNull();
    expect(cancelled).toBe(true);
    const exact = streamOf([new Uint8Array(5), new Uint8Array(5)]);
    expect((await readBodyLimited(req(exact), 10))?.length).toBe(10);
  });

  it("read text split mid-character, and match the platform's bytes and text", async () => {
    const bytes = new TextEncoder().encode("héllo €𝄞 ok");
    const parts = Array.from(bytes, (b) => new Uint8Array([b]));
    expect(await readTextLimited(req(streamOf(parts)), 1000)).toBe("héllo €𝄞 ok");
    const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xff, 0xfe, 0xc3, 0x28, 0x7b, 0x7d]);
    expect(await readBodyLimited(req(raw), 1000)).toEqual(
      new Uint8Array(await req(raw).arrayBuffer()),
    );
    expect(await readTextLimited(req(raw), 1000)).toBe(await req(raw).text());
    const form = "Body=Hello+World%21+%E2%82%AC&From=%2B15551234567";
    expect(await readTextLimited(req(form), 1000)).toBe(form);
  });

  it("read an empty or missing body as empty", async () => {
    expect((await readBodyLimited(req(null), 10))?.length).toBe(0);
    expect((await readBodyLimited(req(""), 10))?.length).toBe(0);
    expect(await readTextLimited(req(null), 10)).toBe("");
  });

  it("count what arrives whatever the declared length says", async () => {
    const small = streamOf([new Uint8Array(8), new Uint8Array(8)]);
    expect(
      await readBodyLimited(withHeaders(req(small), { "content-length": "4" }), 10),
    ).toBeNull();
    const big = withHeaders(req(new Uint8Array(2)), { "content-length": "999" });
    expect(await readBodyLimited(big, 10)).toBeNull();
    const garbage = withHeaders(req(new Uint8Array(2)), { "content-length": "abc" });
    expect((await readBodyLimited(garbage, 10))?.length).toBe(2);
  });
});

describe("readableLimited", () => {
  it("passes a body within the limit through unchanged", async () => {
    const limited = readableLimited(
      req(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])])),
      3,
    );
    if (!limited) throw new Error("refused");
    expect(new Uint8Array(await new Response(limited.body).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(limited.over()).toBe(false);
  });

  it("fails past the limit, says so, and stops reading", async () => {
    let cancelled = false;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(4));
    const limited = readableLimited(
      req(
        streamOf(chunks, () => {
          cancelled = true;
        }),
      ),
      10,
    );
    if (!limited) throw new Error("refused");
    await expect(new Response(limited.body).arrayBuffer()).rejects.toThrow();
    expect(limited.over()).toBe(true);
    expect(cancelled).toBe(true);
    expect(
      readableLimited(withHeaders(req(new Uint8Array(2)), { "content-length": "11" }), 10),
    ).toBeNull();
  });
});
