// The AP mailbox parameter: an address or nothing, read in one pass (CodeQL's polynomial-regex
// finding on PR #298, 2026-11-15).

import { describe, expect, it } from "vitest";
import { apEmailOf } from "./tools";

describe("the AP mailbox parameter", () => {
  it("takes an address and refuses anything else", () => {
    expect(apEmailOf({ ap_email: " ap@millwork-a.example " })).toBe("ap@millwork-a.example");
    expect(apEmailOf({ ap_email: "ap@mail.millwork-a.co.uk" })).toBe("ap@mail.millwork-a.co.uk");
    expect(apEmailOf({ ap_email: "ap@localhost" })).toBeNull();
    expect(apEmailOf({ ap_email: "ap@@millwork.example" })).toBeNull();
    expect(apEmailOf({ ap_email: "not an address" })).toBeNull();
    expect(apEmailOf({})).toBeNull();
  });

  it("stays quick on a long run of dots", () => {
    const started = Date.now();
    expect(apEmailOf({ ap_email: `!@!.${"!.".repeat(50_000)}` })).toBeNull();
    expect(apEmailOf({ ap_email: `a@b${".c".repeat(150)}` })).toBe(`a@b${".c".repeat(150)}`);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
