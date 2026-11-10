import { evaluateSkillRules, type SkillCondition, type SkillRule } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  blankOutput,
  blankValue,
  listFrom,
  literalFrom,
  newCondition,
  newRowId,
  type RuleScope,
  ruleOutputs,
  ruleRowText,
  withOp,
  withOutputs,
} from "./rule-rows";

const scope: RuleScope = {
  inputs: ["dueDate", "status", "amount", "previous"],
  parameters: [
    { name: "aging", label: "Aging buckets", type: "buckets" },
    { name: "floor", label: "Lowest amount", type: "number" },
  ],
};

describe("rule rows in the editor", () => {
  it("types literals and lists as they are typed", () => {
    expect(literalFrom("12.5")).toBe(12.5);
    expect(literalFrom("true")).toBe(true);
    expect(literalFrom("Past due")).toBe("Past due");
    expect(listFrom("paid, void, 3")).toEqual(["paid", "void", 3]);
  });

  it("changes a condition's operator keeping its operands", () => {
    const c = newCondition(scope);
    expect(c).toEqual({ left: { input: "dueDate" }, op: "=", right: { value: "" } });
    const between = withOp({ ...c, right: { value: 1 } } as SkillCondition, "between");
    expect(between).toEqual({
      left: { input: "dueDate" },
      op: "between",
      from: { value: 1 },
      to: { value: "" },
    });
    expect(withOp(between, "in")).toEqual({
      left: { input: "dueDate" },
      op: "in",
      list: { value: [] },
    });
    expect(withOp(between, ">")).toMatchObject({ op: ">", right: { value: 1 } });
  });

  it("keeps fixed values and calculations apart, in the skill's output order", () => {
    const row = withOutputs({ id: "row-1", when: { match: "all", rules: [] } } as SkillRule, [
      blankOutput("bucket", "bucket", scope),
      { field: "note", how: "fixed", value: "late" },
    ]);
    expect(row.set).toEqual({ note: "late" });
    expect(row.compute).toEqual({
      bucket: {
        bucket: {
          value: { daysBetween: { from: { input: "dueDate" }, to: { today: true } } },
          by: "aging",
        },
      },
    });
    expect(ruleOutputs(row, ["bucket", "note"]).map((o) => o.field)).toEqual(["bucket", "note"]);
    expect(ruleOutputs(row, ["note", "bucket"]).map((o) => o.field)).toEqual(["note", "bucket"]);
    expect(newRowId([row])).toBe("row-2");
    expect(ruleRowText(row, scope)).toBe(
      'always, then note = "late"; bucket = the Aging buckets bucket of days from dueDate to today',
    );
  });

  it("builds rows core runs: today, days between, between, one of, sums and changes", () => {
    const rows: SkillRule[] = [
      {
        id: "void",
        when: { match: "all", rules: [] },
        conditions: [
          { left: { input: "status" }, op: "in", list: { value: listFrom("paid, void") } },
        ],
        set: { bucket: "Closed" },
      },
      {
        id: "small",
        when: { match: "all", rules: [] },
        conditions: [
          {
            left: { input: "amount" },
            op: "between",
            from: { value: 0 },
            to: { parameter: "floor" },
          },
        ],
        set: { bucket: "Small" },
      },
      withOutputs(
        {
          id: "aged",
          when: { match: "all", rules: [] },
          conditions: [{ left: { input: "dueDate" }, op: "<", right: blankValue("today", scope) }],
        } as SkillRule,
        [
          blankOutput("bucket", "bucket", scope),
          {
            field: "change",
            how: "percentChange",
            compute: { percentChange: { from: { input: "previous" }, to: { input: "amount" } } },
          },
          {
            field: "total",
            how: "sum",
            compute: { sum: [{ input: "amount" }, { input: "previous" }] },
          },
        ],
      ),
    ];
    const parameters = {
      floor: 50,
      aging: [
        { from: 0, to: 15, label: "Current" },
        { from: 16, label: "Late" },
      ],
    };
    const run = (input: Record<string, unknown>) =>
      evaluateSkillRules(rows, { input, parameters, today: "2026-11-10" });
    expect(run({ status: "void", amount: 900 })?.output).toEqual({ bucket: "Closed" });
    expect(run({ status: "open", amount: 20 })?.output).toEqual({ bucket: "Small" });
    expect(
      run({ status: "open", amount: 300, previous: 200, dueDate: "2026-10-01" })?.output,
    ).toEqual({ bucket: "Late", change: 50, total: 500 });
  });
});
