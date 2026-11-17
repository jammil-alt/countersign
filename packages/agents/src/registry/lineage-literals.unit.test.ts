// The promotion scrub reads operator text with regular expressions: each must read a long input in
// linear time (CodeQL: polynomial regular expression on uncontrolled data).

import { describe, expect, it } from "vitest";
import { holdsClientLiteral } from "./lineage";

describe("client literals in text", () => {
  it("finds an email address, and none in plain words", () => {
    expect(holdsClientLiteral("Send it to maria.gomez@example.com today")).toBe(true);
    expect(holdsClientLiteral("Send it to the buyer today")).toBe(false);
  });

  it("reads a long run of address characters with no @ in linear time", () => {
    const started = Date.now();
    for (const run of ["%".repeat(50_000), "a.".repeat(25_000), `a@${"b.".repeat(25_000)}`]) {
      expect(holdsClientLiteral(run)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});
