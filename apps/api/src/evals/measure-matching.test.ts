import { Decimal, type ProfileChooser } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  crmSet,
  materialsSet,
  noSpend,
  PRECISION_TARGET,
  recommend,
  renderReport,
  runSetting,
  settingsGrid,
  similarity,
} from "./measure-matching";

// No model here: an answer is made up from the question, so `pnpm test` never calls one.
const answers =
  (confidence: number): ProfileChooser =>
  async (q) => {
    // Picks the closest candidate by the same similarity the shortlist uses (its first).
    const first = q.candidates[0];
    return { record_id: first?.id ?? null, confidence, reason: "test" };
  };

describe("measuring the Match settings", () => {
  it("measures the grid: sizes, thresholds and floors below them", () => {
    const grid = settingsGrid();
    expect(new Set(grid.map((g) => g.shortlist))).toEqual(new Set([5, 10, 20, 30, 50]));
    expect(new Set(grid.map((g) => g.threshold))).toEqual(new Set([80, 85, 90, 95]));
    expect(new Set(grid.map((g) => g.floor))).toEqual(new Set([60, 70, null]));
    expect(grid.every((g) => g.floor === null || g.floor < g.threshold)).toBe(true);
  });

  it("reads the goldens: the pairs' lines and the CRM's 65 rows", () => {
    const m = materialsSet();
    expect(m.cases.length).toBeGreaterThan(50);
    expect(m.cases.some((c) => c.right.length > 0)).toBe(true);
    expect(crmSet().cases).toHaveLength(65);
  });

  it("scores a shortlist by likeness", () => {
    expect(similarity("Blum hinge 71B3550", "BLUM 71B3550 HINGE")).toBeGreaterThan(
      similarity("Blum hinge 71B3550", "walnut plywood 3/4"),
    );
  });

  it("runs a setting with a fake model and counts what it spent", async () => {
    const spend = noSpend();
    const set = crmSet();
    const r = await runSetting(set, { shortlist: 5, threshold: 90, floor: 70 }, (s) => {
      const ask = answers(0.95);
      const counted: ProfileChooser = async (q) => {
        s.input += 10;
        s.cost = s.cost.plus(new Decimal("0.0001"));
        return ask(q);
      };
      spend.cost = s.cost;
      return { choose: counted, second: counted };
    });
    expect(r.items).toBe(65);
    expect(r.matched + r.toPerson).toBeGreaterThan(0);
    expect(r.precision).toBeGreaterThanOrEqual(0);
    expect(r.tokens.input).toBeGreaterThan(0);
    expect(new Decimal(r.cost).gt(0)).toBe(true);
  });

  it("recommends the most recall among settings at the precision target", () => {
    const base = {
      profile: "p",
      items: 10,
      withRight: 10,
      matched: 10,
      right: 10,
      wrong: 0,
      byModel: 0,
      rightByModel: 0,
      toPerson: 0,
      precision: 1,
      recall: 0.5,
      personShare: 0.5,
      tokens: { input: 0, output: 0 },
      cost: "1.0000",
      setting: { shortlist: 5, threshold: 90, floor: 70 },
    };
    const results = [
      base,
      { ...base, recall: 0.9, setting: { shortlist: 20, threshold: 90, floor: 70 } },
      { ...base, recall: 0.99, precision: PRECISION_TARGET - 0.01 },
    ];
    expect(recommend(results)?.setting.shortlist).toBe(20);
    expect(recommend([results[2] as never])).toBeNull();
    expect(renderReport({ model: "m", secondModel: "n", results })).toContain("Recommended");
  });
});
