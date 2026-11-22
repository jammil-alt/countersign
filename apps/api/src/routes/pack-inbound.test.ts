// The public inbound route's limits, without a database: one address is held to its allowance,
// one site to its own (§1.198), and no address can use up a site's. The limiters are the
// isolate's windows, as the route uses where the Rate Limiting bindings aren't bound.

import { describe, expect, it } from "vitest";
import { INBOUND_TARGET_PER_MINUTE, MCP_CALLS_PER_MINUTE, memoryRateLimiter } from "../mcp/limits";
import {
  addressScope,
  droppedReporter,
  type InboundLimiters,
  inboundLimitHit,
} from "./pack-inbound";

const T = "0b6f1f0e-7a3c-4d6e-9b1a-2c3d4e5f6a7b";
const S = "1c7a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const S2 = "2d8b3c4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const req = (ip: string, target = S) => ({ pack: "marketing", tenantId: T, target, ip });

const limiters = (targetLimit = INBOUND_TARGET_PER_MINUTE): InboundLimiters => ({
  address: memoryRateLimiter(),
  target: memoryRateLimiter(targetLimit),
});
const within = async (l: InboundLimiters, r: Parameters<typeof inboundLimitHit>[1]) =>
  (await inboundLimitHit(l, r)) === null;
/** A different IPv4 address for each i, each well under its own allowance. */
const nth = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

describe("the inbound limit per address", () => {
  it("holds one address to its allowance, and leaves the site's other readers alone", async () => {
    const l = limiters();
    let one = 0;
    for (let i = 0; i < 200; i++) if (await within(l, req("203.0.113.9"))) one++;
    expect(one).toBe(MCP_CALLS_PER_MINUTE);
    expect(await inboundLimitHit(l, req("203.0.113.9"))).toBe("address");
    let others = 0;
    for (let i = 0; i < 50; i++) {
      if (await within(l, req(`198.51.100.${i}`))) others++;
    }
    expect(others).toBe(50);
  });
});

describe("the inbound limit per site", () => {
  it("is set well above the address limit", () => {
    expect(INBOUND_TARGET_PER_MINUTE).toBeGreaterThanOrEqual(20 * MCP_CALLS_PER_MINUTE);
  });

  it("refuses a site over its limit, while another site still passes", async () => {
    const l = limiters();
    let passed = 0;
    for (let i = 0; i < INBOUND_TARGET_PER_MINUTE + 100; i++) {
      if (await within(l, req(nth(i)))) passed++;
    }
    expect(passed).toBe(INBOUND_TARGET_PER_MINUTE);
    // A fresh address for the full site is refused by the site's limit, not its own.
    expect(await inboundLimitHit(l, req("192.0.2.1"))).toBe("target");
    // Another site, and the same site id under another client, have their own allowance.
    expect(await inboundLimitHit(l, req("192.0.2.1", S2))).toBe(null);
    expect(await inboundLimitHit(l, { ...req("192.0.2.2"), tenantId: crypto.randomUUID() })).toBe(
      null,
    );
  });

  it("is not used up by one address over its own limit", async () => {
    const l = limiters(150);
    let one = 0;
    for (let i = 0; i < 1000; i++) if (await within(l, req("203.0.113.9"))) one++;
    expect(one).toBe(MCP_CALLS_PER_MINUTE);
    // Only the address's 120 counted toward the site: 30 more readers still get through.
    let others = 0;
    for (let i = 0; i < 40; i++) if (await within(l, req(nth(i)))) others++;
    expect(others).toBe(150 - MCP_CALLS_PER_MINUTE);
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
    const l = limiters();
    let passed = 0;
    for (let i = 0; i < 1000; i++) {
      const ip = `2001:db8:1:2:${(i >> 12).toString(16)}:${(i & 0xfff).toString(16)}:0:1`;
      const one = { pack: "marketing", tenantId: crypto.randomUUID(), target: crypto.randomUUID() };
      if (await within(l, { ...one, ip })) passed++;
    }
    expect(passed).toBe(120);
    // Another /64 has its own allowance.
    expect(await within(l, req("2001:db8:1:3::1"))).toBe(true);
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
