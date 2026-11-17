// The public inbound route's limit, without a database: one address is held to its allowance, and
// no address can use up a site's (there is no per-site limit until it has a binding of its own).

import { describe, expect, it } from "vitest";
import { memoryRateLimiter } from "../mcp/limits";
import { droppedReporter, withinInboundLimits } from "./pack-inbound";

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
