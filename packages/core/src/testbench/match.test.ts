import { describe, expect, it } from "vitest";
import { FieldPath, Matcher, TestCaseFields, testCaseProblems } from "./case";
import { labelOutcome, matchOutput, valueAt } from "./match";
import { fixtureFor, gatePasses, suiteTotals } from "./suite";

const m = (input: unknown) => Matcher.parse(input);

describe("matchers", () => {
  it("exact: equal JSON, no fields more or fewer", () => {
    expect(matchOutput(m({ kind: "exact" }), { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }).pass).toBe(
      true,
    );
    const extra = matchOutput(m({ kind: "exact" }), { a: 1 }, { a: 1, b: 2 });
    expect(extra.pass).toBe(false);
    expect(extra.diff).toEqual([{ path: "b", problem: "extra", got: 2 }]);
    const missing = matchOutput(m({ kind: "exact" }), { a: 1, b: 2 }, { a: 1 });
    expect(missing.diff).toEqual([{ path: "b", problem: "missing", expected: 2 }]);
  });

  it("subset: expected fields must be there; more are fine; list lengths must match", () => {
    expect(matchOutput(m({}), { a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }).pass).toBe(true);
    expect(matchOutput(m({}), { a: { b: 1 } }, { a: { b: 2 } }).diff).toEqual([
      { path: "a.b", problem: "different", expected: 1, got: 2 },
    ]);
    expect(matchOutput(m({}), { lines: [{ q: 1 }] }, { lines: [{ q: 1 }, { q: 2 }] }).pass).toBe(
      false,
    );
  });

  it("money tolerance compares with decimals, strings or numbers", () => {
    const matcher = m({ tolerances: { "lines.*.price": { kind: "money", abs: "0.01" } } });
    const expected = { lines: [{ price: "10.0000" }, { price: "2.50" }] };
    expect(matchOutput(matcher, expected, { lines: [{ price: "10.01" }, { price: 2.5 }] }).pass).toBe(
      true,
    );
    const off = matchOutput(matcher, expected, { lines: [{ price: "10.02" }, { price: "2.5" }] });
    expect(off.pass).toBe(false);
    expect(off.diff[0]).toMatchObject({ path: "lines.0.price", problem: "outside_tolerance" });
    // Without a tolerance, "10.0000" and "10" are different strings.
    expect(matchOutput(m({}), { p: "10.0000" }, { p: "10" }).pass).toBe(false);
  });

  it("number tolerance: absolute or percent, whichever allows more", () => {
    const matcher = m({ tolerances: { qty: { kind: "number", abs: "1", pct: "10" } } });
    expect(matchOutput(matcher, { qty: 100 }, { qty: 109 }).pass).toBe(true);
    expect(matchOutput(matcher, { qty: 100 }, { qty: 111 }).pass).toBe(false);
    expect(matchOutput(matcher, { qty: 5 }, { qty: 6 }).pass).toBe(true);
  });

  it("date tolerance in days", () => {
    const matcher = m({ tolerances: { due: { kind: "date", days: 2 } } });
    expect(matchOutput(matcher, { due: "2026-11-01" }, { due: "2026-11-03" }).pass).toBe(true);
    expect(matchOutput(matcher, { due: "2026-11-01" }, { due: "2026-11-04" }).pass).toBe(false);
    expect(matchOutput(matcher, { due: "2026-11-01" }, { due: "soon" }).pass).toBe(false);
  });

  it("fields: compares only the named fields", () => {
    const matcher = m({ kind: "fields", tolerances: { total: { kind: "money", abs: "0" } } });
    expect(matchOutput(matcher, { total: "5.00", vendor: "Acme" }, { total: "5" }).pass).toBe(true);
    expect(matchOutput(matcher, { total: "5.00" }, { total: "6" }).pass).toBe(false);
  });

  it("label: only the label field, and it counts for precision", () => {
    const matcher = m({ kind: "label", label: { field: "verdict", positive: "same" } });
    expect(matchOutput(matcher, { verdict: "same", why: "x" }, { verdict: "same" }).pass).toBe(true);
    expect(labelOutcome(matcher, { verdict: "different" }, { verdict: "same" })).toMatchObject({
      predicted: true,
      actual: false,
    });
    expect(labelOutcome(m({}), {}, {})).toBeNull();
  });

  it("never walks into a prototype", () => {
    expect(FieldPath.safeParse("a.__proto__.b").success).toBe(false);
    expect(FieldPath.safeParse("constructor").success).toBe(false);
    expect(FieldPath.safeParse("lines.*.price").success).toBe(true);
    expect(valueAt({}, "constructor")).toBeUndefined();
    expect(valueAt({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
    const evil = JSON.parse('{"__proto__": {"x": 1}}');
    expect(matchOutput(m({ kind: "exact" }), evil, {}).pass).toBe(true);
    expect(matchOutput(m({}), { toString: 1 }, {}).pass).toBe(false);
  });

  it("checks a template case's shape", () => {
    const fields = TestCaseFields.parse({ name: "x", input: { workflow: "w" }, expected: {} });
    expect(testCaseProblems("template", fields)).toHaveLength(1);
    expect(
      testCaseProblems("template", { ...fields, expected: { "step-1": { ok: true } } }),
    ).toEqual([]);
    expect(testCaseProblems("skill", fields)).toEqual([]);
  });
});

describe("fixtures and suite metrics", () => {
  const fixtures = [
    { tool: "qbo.vendor.list", input: { name: "Acme" }, output: { vendors: ["a"] } },
    { tool: "qbo.vendor.list", output: { vendors: [] } },
  ];

  it("answers by tool and input subset, first match wins", () => {
    expect(fixtureFor(fixtures, "qbo.vendor.list", { name: "Acme", limit: 5 })?.output).toEqual({
      vendors: ["a"],
    });
    expect(fixtureFor(fixtures, "qbo.vendor.list", { name: "Other" })?.output).toEqual({
      vendors: [],
    });
    expect(fixtureFor(fixtures, "qbo.bill.query", {})).toBeNull();
  });

  it("reports 7 of 8 with precision and cost per case", () => {
    const label = (predicted: boolean, actual: boolean) => ({
      field: "verdict",
      positive: "same",
      predicted,
      actual,
    });
    const outcomes = [
      ...Array.from({ length: 6 }, () => ({
        status: "pass" as const,
        costUsd: "0.01",
        label: label(true, true),
      })),
      { status: "pass" as const, costUsd: "0.01", label: label(false, false) },
      { status: "fail" as const, costUsd: "0.01", label: label(true, false) },
    ];
    const t = suiteTotals(outcomes);
    expect(t).toMatchObject({ total: 8, passed: 7, failed: 1, costUsd: "0.080000" });
    expect(t.metrics.passRate).toBe(0.875);
    expect(t.metrics.precision).toBe(0.8571);
    expect(t.metrics.costPerCase).toBe("0.010000");
    expect(t.metrics.labels?.[0]).toMatchObject({ truePositives: 6, falsePositives: 1 });
    expect(suiteTotals([]).metrics).toEqual({ passRate: 0, costPerCase: "0.000000" });
  });

  it("the gate needs a pass for every required case", () => {
    const results = new Map([
      ["a", "pass" as const],
      ["b", "fail" as const],
    ]);
    expect(gatePasses(["a"], results)).toEqual({ pass: true, failing: [] });
    expect(gatePasses(["a", "b", "c"], results)).toEqual({ pass: false, failing: ["b", "c"] });
  });
});
