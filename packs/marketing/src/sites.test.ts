// A measured site's domain, as the back office's "add a site" takes it.
import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./sites";

describe("a site's domain", () => {
  it("keeps the host without www, a scheme, a path or a trailing dot", () => {
    expect(normalizeDomain("https://www.Mezonas.com/terms")).toBe("mezonas.com");
    expect(normalizeDomain("mezonas.com/")).toBe("mezonas.com");
    expect(normalizeDomain("shop.example.co.uk.")).toBe("shop.example.co.uk");
  });

  it("refuses what is not a domain", () => {
    for (const bad of [
      "",
      "localhost",
      "not a domain",
      "-x.com",
      "x-.com",
      "a..com",
      `${"a".repeat(64)}.com`,
    ]) {
      expect({ bad, out: normalizeDomain(bad) }).toEqual({ bad, out: null });
    }
  });

  it("answers at once on a long run of slashes", () => {
    const started = performance.now();
    expect(normalizeDomain(`/${"/".repeat(100_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
