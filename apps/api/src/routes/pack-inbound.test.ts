// The public inbound route's limit, without a database: one address is held to its allowance, and
// no address can use up a site's (there is no per-site limit until it has a binding of its own).

import { describe, expect, it } from "vitest";
import { memoryRateLimiter } from "../mcp/limits";
import { addressScope, droppedReporter, withinInboundLimits } from "./pack-inbound";

const T = "0b6f1f0e-7a3c-4d6e-9b1a-2c3d4e5f6a7b";
const S = "1c7a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const req = (ip: string) => ({ pack: "marketing", tenantId: T, target: S, ip });

describe("the inbound limit", () => {
  it("holds one address to its allowance, and leaves the site's other readers alone", async () => {
    const limiter = memoryRateLimiter();
    let one = 0;
    for (let i = 0; i < 200; i++) if (await withinInboundLimits(limiter, req("203.0.113.9"))) one++;
    expect(one).toBe(120);
    let others = 0;
    for (let i = 0; i < 50; i++) {
      if (await withinInboundLimits(limiter, req(`198.51.100.${i}`))) others++;
    }
    expect(others).toBe(50);
  });
});

describe("requests over the limit", () => {
  it("are counted and reported at most once a minute, with the count", () => {
    let t = 0;
    const reports: number[] = [];
    const dropped = droppedReporter(
      (count) => reports.push(count),
      () => t,
    );
    dropped();
    expect(reports).toEqual([1]);
    for (let i = 0; i < 40; i++) dropped();
    t = 59_999;
    dropped();
    expect(reports).toEqual([1]);
    t = 60_000;
    dropped();
    expect(reports).toEqual([1, 42]);
  });
});

describe("an IPv6 address", () => {
  it("is limited by its /64, so rotating within one network gets past nothing", async () => {
    const limiter = memoryRateLimiter();
    let passed = 0;
    for (let i = 0; i < 1000; i++) {
      const ip = `2001:db8:1:2:${(i >> 12).toString(16)}:${(i & 0xfff).toString(16)}:0:1`;
      const one = { pack: "marketing", tenantId: crypto.randomUUID(), target: crypto.randomUUID() };
      if (await withinInboundLimits(limiter, { ...one, ip })) passed++;
    }
    expect(passed).toBe(120);
    // Another /64 has its own allowance.
    expect(await withinInboundLimits(limiter, req("2001:db8:1:3::1"))).toBe(true);
  });

  it("is keyed by its network, written any way; IPv4 by the whole address", () => {
    expect(addressScope("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressScope("2001:0DB8:0001:0002:ffff:0:0:9")).toBe("2001:db8:1:2::/64");
    expect(addressScope("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(addressScope("::1")).toBe("0:0:0:0::/64");
    expect(addressScope("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressScope("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressScope("203.0.113.9")).toBe("203.0.113.9");
    expect(addressScope("")).toBe("");
    expect(addressScope("not:an::address::x")).toBe("not:an::address::x");
  });
});
