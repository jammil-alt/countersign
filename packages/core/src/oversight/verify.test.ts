// Round 4 D (docs/plan.md §1.211): the verifier's comparison, the thresholds and the evidence
// helpers, pure.

import { describe, expect, it } from "vitest";
import {
  compareDerived,
  confidenceIn,
  evidenceValues,
  readWriteThresholds,
  sameValue,
  stepsReferenced,
  thresholdLooseningProblems,
  thresholdReached,
  verificationOf,
  verifiesWrites,
} from "./verify";

describe("the verifier's comparison", () => {
  it("reads amounts as decimals and text without case or extra spaces", () => {
    expect(sameValue("1,250.00", 1250)).toBe(true);
    expect(sameValue("$1250", "1250.0")).toBe(true);
    expect(sameValue(0.1 + 0.2, "0.3")).toBe(false); // a float never passes for a decimal
    expect(sameValue("ACME  Supply ", "acme supply")).toBe(true);
    expect(sameValue("2026-11-03", "11/3/2026")).toBe(false);
  });

  it("compares only the fields the verifier gave", () => {
    const proposed = { vendor: "Acme", amount: "1250.00", lines: [{ amount: "1250.00" }], id: "9" };
    expect(compareDerived(proposed, { vendor: "acme", amount: 1250 })).toEqual({
      checked: 2,
      differences: [],
    });
    expect(compareDerived(proposed, { amount: "125.00", memo: "x" })).toEqual({
      checked: 2,
      differences: [
        { path: "amount", proposed: "1250.00", derived: "125.00" },
        { path: "memo", proposed: null, derived: "x" },
      ],
    });
  });

  it("agrees, disagrees or can't verify", () => {
    const proposed = { amount: "10.00" };
    const answer = (input?: Record<string, unknown>, derivable = true) => ({
      derivable,
      ...(input ? { input } : {}),
      note: "",
      sources: ["r1"],
    });
    expect(verificationOf(proposed, answer({ amount: "10" })).outcome).toBe("agreed");
    const no = verificationOf(proposed, answer({ amount: "100" }));
    expect(no.outcome).toBe("disagreed");
    expect(no.differences).toEqual([{ path: "amount", proposed: "10.00", derived: "100" }]);
    expect(verificationOf(proposed, answer(undefined, false))).toMatchObject({
      outcome: "cannot_verify",
      reason: "not_derivable",
    });
    expect(verificationOf(proposed, answer({}))).toMatchObject({ reason: "nothing_compared" });
    expect(verificationOf(proposed, null)).toMatchObject({ reason: "review_failed" });
  });

  it("is on only where an agent's oversight says `writes`", () => {
    expect(verifiesWrites(undefined)).toBe(false);
    expect(verifiesWrites({})).toBe(false);
    expect(verifiesWrites({ verify: "off" })).toBe(false);
    expect(verifiesWrites({ verify: "writes" })).toBe(true);
  });
});

describe("dollar thresholds", () => {
  const thresholds = [{ currency: "USD", approveFrom: "500.00" }];

  it("holds an amount at or over the threshold, in its own currency only", () => {
    expect(thresholdReached(thresholds, { value: "500", currency: "USD" })).toEqual(thresholds[0]);
    expect(thresholdReached(thresholds, { value: "-750", currency: "USD" })).not.toBeNull();
    expect(thresholdReached(thresholds, { value: "499.99", currency: "USD" })).toBeNull();
    expect(thresholdReached(thresholds, { value: "9000", currency: "EUR" })).toBeNull();
    expect(thresholdReached(thresholds, null)).toBeNull();
  });

  it("only tightens: lowering or adding passes, raising or removing doesn't", () => {
    expect(
      thresholdLooseningProblems(thresholds, [
        { currency: "USD", approveFrom: "250" },
        { currency: "EUR", approveFrom: "100" },
      ]),
    ).toEqual([]);
    expect(
      thresholdLooseningProblems(thresholds, [{ currency: "USD", approveFrom: "900" }]).map(
        (p) => p.code,
      ),
    ).toEqual(["raised"]);
    expect(thresholdLooseningProblems(thresholds, []).map((p) => p.code)).toEqual(["removed"]);
    expect(
      thresholdLooseningProblems(
        [],
        [
          { currency: "USD", approveFrom: "1" },
          { currency: "USD", approveFrom: "2" },
        ],
      ).map((p) => p.code),
    ).toEqual(["duplicate"]);
  });

  it("reads nothing unreadable", () => {
    expect(readWriteThresholds({ write_thresholds: { revision: "x" } }).thresholds).toEqual([]);
    expect(
      readWriteThresholds({ write_thresholds: { revision: 2, thresholds } }).thresholds,
    ).toEqual(thresholds);
  });
});

describe("evidence helpers", () => {
  it("puts each value beside what the record held", () => {
    expect(evidenceValues({ amount: "12.00", memo: "Fuel" }, { amount: "10.00" })).toEqual([
      { path: "amount", before: "10.00", after: "12.00" },
      { path: "memo", before: null, after: "Fuel" },
    ]);
  });

  it("finds the steps an input reads and a confidence in an output", () => {
    expect(
      stepsReferenced({ a: "{{steps.qin.output.purchase.amount}}", b: "{{ steps.read.output }}" }),
    ).toEqual(["qin", "read"]);
    expect(stepsReferenced({ a: "{{steps.qin.output.x}}", b: "{{steps.qin.output.y}}" })).toEqual([
      "qin",
    ]);
    expect(confidenceIn({ confidence: 0.82 })).toBe("0.82");
    expect(confidenceIn({ purchase: { confidence: "0.9" } })).toBe("0.9");
    expect(confidenceIn({ confidence: 7 })).toBeNull();
  });
});
