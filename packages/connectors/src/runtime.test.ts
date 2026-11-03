import { describe, expect, it } from "vitest";
import { fromBase64, fromBase64Url, fromUtf8, toBase64, toBase64Url, utf8 } from "./runtime";

describe("base64", () => {
  it("matches the RFC 4648 vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
    ];
    for (const [plain, b64] of vectors) {
      expect(toBase64(utf8(plain))).toBe(b64);
      expect(fromUtf8(fromBase64(b64))).toBe(plain);
    }
  });

  it("round-trips every byte value, URL-safe too", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
    const url = toBase64Url(all);
    expect(url).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(url)).toEqual(all);
  });

  it("rejects invalid input", () => {
    expect(() => fromBase64("a")).toThrow();
    expect(() => fromBase64("ab!c")).toThrow();
    expect(() => fromBase64Url("ab+c")).toThrow();
  });
});
