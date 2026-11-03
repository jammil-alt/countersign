import { describe, expect, it } from "vitest";
import { compileRule, compileRules, evaluateRules, RuleCompileError } from "./compile";

const f = "{{steps.s1.output.total}}";

describe("compileRule", () => {
  it.each([
    [">", 5, { ">": [{ var: "steps.s1.output.total" }, 5] }],
    [">=", 5, { ">=": [{ var: "steps.s1.output.total" }, 5] }],
    ["<", 5, { "<": [{ var: "steps.s1.output.total" }, 5] }],
    ["<=", 5, { "<=": [{ var: "steps.s1.output.total" }, 5] }],
    ["=", "x", { "==": [{ var: "steps.s1.output.total" }, "x"] }],
    ["!=", "x", { "!=": [{ var: "steps.s1.output.total" }, "x"] }],
    ["contains", "ply", { in: ["ply", { var: "steps.s1.output.total" }] }],
    ["in", ["a", "b"], { in: [{ var: "steps.s1.output.total" }, ["a", "b"]] }],
    ["is", true, { "===": [{ var: "steps.s1.output.total" }, true] }],
    ["exists", undefined, { "!=": [{ var: "steps.s1.output.total" }, null] }],
  ] as const)("%s compiles to JSONLogic", (op, value, expected) => {
    expect(compileRule({ field: f, op, value })).toEqual(expected);
  });

  it("compares against another field when the value is a reference", () => {
    expect(compileRule({ field: f, op: ">", value: "{{trigger.limit}}" })).toEqual({
      ">": [{ var: "steps.s1.output.total" }, { var: "trigger.limit" }],
    });
  });

  it("rejects a field that isn't one reference, and 'in' without a list", () => {
    expect(() => compileRule({ field: "total", op: ">", value: 1 })).toThrow(RuleCompileError);
    expect(() => compileRule({ field: "{{a}} {{b}}", op: ">", value: 1 })).toThrow(
      RuleCompileError,
    );
    expect(() => compileRule({ field: f, op: "in", value: "a" })).toThrow(/list/);
  });
});

describe("compileRules", () => {
  it("joins with and/or, and handles empty lists", () => {
    const r1 = { field: f, op: ">" as const, value: 1 };
    const r2 = { field: f, op: "<" as const, value: 9 };
    expect(compileRules({ match: "all", rules: [r1, r2] })).toEqual({
      and: [compileRule(r1), compileRule(r2)],
    });
    expect(compileRules({ match: "any", rules: [r1, r2] })).toEqual({
      or: [compileRule(r1), compileRule(r2)],
    });
    expect(compileRules({ match: "all", rules: [r1] })).toEqual(compileRule(r1));
    expect(compileRules({ match: "all", rules: [] })).toBe(true);
    expect(compileRules({ match: "any", rules: [] })).toBe(false);
  });
});

describe("evaluateRules", () => {
  const data = {
    trigger: { vendor: "Acme Plywood", tags: ["rush"], limit: 500, flag: false },
    steps: { s1: { output: { total: 750, pct: 15 } } },
  };
  const ev = (rules: Parameters<typeof evaluateRules>[0]) => evaluateRules(rules, data);

  it("matches the builder's 'Price change > 15% or Monthly impact > $500'", () => {
    expect(
      ev({
        match: "any",
        rules: [
          { field: "{{steps.s1.output.pct}}", op: ">", value: 15 },
          { field: "{{steps.s1.output.total}}", op: ">", value: "{{trigger.limit}}" },
        ],
      }),
    ).toBe(true);
    expect(
      ev({
        match: "all",
        rules: [
          { field: "{{steps.s1.output.pct}}", op: ">", value: 15 },
          { field: "{{steps.s1.output.total}}", op: ">", value: 500 },
        ],
      }),
    ).toBe(false);
  });

  it("handles contains, in, is and exists", () => {
    expect(
      ev({ match: "all", rules: [{ field: "{{trigger.vendor}}", op: "contains", value: "Ply" }] }),
    ).toBe(true);
    expect(
      ev({ match: "all", rules: [{ field: "{{trigger.tags}}", op: "contains", value: "rush" }] }),
    ).toBe(true);
    expect(
      ev({
        match: "all",
        rules: [{ field: "{{trigger.vendor}}", op: "in", value: ["Acme Plywood", "B"] }],
      }),
    ).toBe(true);
    expect(
      ev({ match: "all", rules: [{ field: "{{trigger.flag}}", op: "is", value: false }] }),
    ).toBe(true);
    expect(ev({ match: "all", rules: [{ field: "{{trigger.flag}}", op: "is", value: 0 }] })).toBe(
      false,
    );
    expect(ev({ match: "all", rules: [{ field: "{{trigger.flag}}", op: "exists" }] })).toBe(true);
    expect(ev({ match: "all", rules: [{ field: "{{trigger.nope}}", op: "exists" }] })).toBe(false);
  });

  it("compares '=' loosely", () => {
    expect(
      ev({ match: "all", rules: [{ field: "{{steps.s1.output.total}}", op: "=", value: "750" }] }),
    ).toBe(true);
  });
});
