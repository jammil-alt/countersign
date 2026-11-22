// The matching engine (docs/plan.md §1.215) on its two configurations' fixtures
// (fixtures/matching/reconcile): bank lines to the ledger, and one invoice in two systems (the
// ROMCO case), each match with the tier and rule expected; then the hard rules, the model tier's
// checks and the saved rules. The model's answers are replayed from the fixture (hand-written).

import { describe, expect, it } from "vitest";
import bankToLedger from "../../../../fixtures/matching/reconcile/bank-to-ledger.json";
import billToPo from "../../../../fixtures/matching/reconcile/bill-to-po.json";
import invoiceTwoSystems from "../../../../fixtures/matching/reconcile/invoice-two-systems.json";
import {
  BANK_TO_LEDGER,
  BILL_TO_PO,
  INVOICE_TWO_SYSTEMS,
  MATCH_CONFIGS,
  MatchConfig,
  type SavedMatchRule,
} from "./config";
import { decideRanked, type MatchItem, matchItems, nameSimilarity } from "./engine";
import { type ModelQuestion, withModel } from "./model";
import { alnumReference, invoiceNumber, normalizeCounterparty } from "./normalize";
import { ruleFromCorrection, ruleFromPair } from "./rules";

interface FixtureItem extends MatchItem {
  id: string;
}
interface Fixture {
  description: string;
  config: string;
  a: FixtureItem[];
  b: FixtureItem[];
  rules: SavedMatchRule[];
  model?: { a: string; b: string[] | null; confidence: number; reason: string }[];
  expect: {
    a: string[];
    b: string[];
    type: string;
    tier: string;
    rule: string;
    difference?: string;
  }[];
  unmatched: { a: string[]; b: string[] };
}

const fixtures = [
  { file: "bank-to-ledger.json", fx: bankToLedger as Fixture },
  { file: "invoice-two-systems.json", fx: invoiceTwoSystems as Fixture },
  // Plan entry §1.233: the AP pack's bills against purchase orders.
  { file: "bill-to-po.json", fx: billToPo as Fixture },
];

/** Replays the fixture's model answers, by item id. */
function replay(fx: Fixture, asked: ModelQuestion[][]) {
  return async (questions: ModelQuestion[]) => {
    asked.push(questions);
    return (fx.model ?? [])
      .map((m) => ({
        a: fx.a.findIndex((x) => x.id === m.a),
        b: m.b === null ? null : m.b.map((id) => fx.b.findIndex((x) => x.id === id)),
        confidence: m.confidence,
        reason: m.reason,
      }))
      .filter((m) => questions.some((q) => q.a === m.a));
  };
}

async function run(fx: Fixture, rules = fx.rules) {
  const config = MATCH_CONFIGS[fx.config];
  if (!config) throw new Error(`no configuration ${fx.config}`);
  const asked: ModelQuestion[][] = [];
  const first = matchItems(fx.a, fx.b, config, { rules });
  const outcome = await withModel(first, fx.a, fx.b, config, replay(fx, asked));
  const ids = (side: "a" | "b", xs: number[]) =>
    xs.map((i) => (side === "a" ? fx.a : fx.b)[i]?.id as string);
  return {
    outcome,
    asked,
    matches: outcome.matches.map((m) => ({
      a: ids("a", m.a),
      b: ids("b", m.b),
      type: m.type,
      tier: m.tier,
      rule: m.rule,
      difference: m.difference,
    })),
    unmatched: { a: ids("a", outcome.unmatched.a), b: ids("b", outcome.unmatched.b) },
  };
}

it("has each configuration, valid, and a fixture for each", () => {
  for (const c of Object.values(MATCH_CONFIGS)) expect(MatchConfig.parse(c)).toEqual(c);
  expect(fixtures.map((f) => f.fx.config).sort()).toEqual(
    [BANK_TO_LEDGER.id, INVOICE_TWO_SYSTEMS.id, BILL_TO_PO.id].sort(),
  );
});

describe.each(fixtures)("$file", ({ fx }) => {
  it("matches each item with the tier and rule expected, and leaves the rest", async () => {
    const r = await run(fx);
    const key = (m: { a: string[] }) => m.a.join(",");
    expect(
      r.matches.map(({ difference: _, ...m }) => m).sort((x, y) => key(x).localeCompare(key(y))),
    ).toEqual(
      fx.expect.map(({ difference: _, ...m }) => m).sort((x, y) => key(x).localeCompare(key(y))),
    );
    for (const e of fx.expect.filter((x) => x.difference)) {
      expect(r.matches.find((m) => key(m) === key(e))?.difference).toBe(e.difference);
    }
    for (const m of r.matches.filter((x) => x.type !== "partial")) {
      expect(m.difference, m.a.join(",")).toMatch(/^-?0\.0\d{3}$/);
    }
    expect(r.unmatched).toEqual(fx.unmatched);
  });

  it("states a tier and a rule for every match", async () => {
    const r = await run(fx);
    for (const m of r.outcome.matches) {
      expect(m.tier).toBeTruthy();
      expect(m.rule).toBeTruthy();
      if (m.tier === "client_rule") expect(m.rule).toMatch(/^client_rule:/);
      if (m.tier === "model") expect(m.reason).toBeTruthy();
    }
  });
});

describe("the ROMCO case", () => {
  const fx = fixtures.find((f) => f.fx.config === "invoice_two_systems")?.fx as Fixture;

  it("without the saved rule leaves Rocky Mountain Coal for a person, and never asks the model", async () => {
    const r = await run(fx, []);
    expect(r.unmatched.a).toContain("A9");
    expect(r.unmatched.b).toContain("B9");
    // Two names this unlike are a hard rule: the model is never shown the pair.
    const a9 = fx.a.findIndex((x) => x.id === "A9");
    expect(r.asked.flat().some((q) => q.a === a9)).toBe(false);
  });

  it("asks the model only about what the tiers before it left, with candidates the hard rules allow", async () => {
    const r = await run(fx);
    const questions = r.asked.flat();
    const leftA = new Set(["A10", "A11"].map((id) => fx.a.findIndex((x) => x.id === id)));
    for (const q of questions) {
      expect(leftA.has(q.a)).toBe(true);
      expect(q.candidates.length).toBeLessThanOrEqual(INVOICE_TWO_SYSTEMS.model?.candidates ?? 0);
    }
  });

  it("never matches two invoice numbers both stated that differ, whatever else agrees", () => {
    const a = [
      { reference: "INV-2001", counterparty: "ROMCO", date: "2026-10-01", amount: "10.00" },
    ];
    const b = [{ reference: "2002", counterparty: "ROMCO", date: "2026-10-01", amount: "10.00" }];
    const out = matchItems(a, b, INVOICE_TWO_SYSTEMS);
    expect(out.matches).toEqual([]);
  });
});

describe("the model tier", () => {
  const a: MatchItem[] = [
    { counterparty: "ROMCO", date: "2026-10-01", amount: "100.00", currency: "USD" },
  ];
  const b: MatchItem[] = [
    { counterparty: "Romco", date: "2026-10-02", amount: "100.00" },
    { counterparty: "Romco", date: "2026-10-03", amount: "100.00" },
    { counterparty: "Romco", date: "2026-10-03", amount: "-40.00" },
    { counterparty: "Romco", date: "2026-10-03", amount: "100.00", currency: "CAD" },
  ];
  const config = { ...INVOICE_TWO_SYSTEMS, rules: [] };
  const first = { ...matchItems(a, b, config) };
  const answer = (x: unknown) => async () => [x];

  it("has the two equal candidates open after the fuzzy tier", () => {
    expect(first.matches).toEqual([]);
  });

  it("matches at the threshold, proposes under it", async () => {
    const yes = await withModel(
      first,
      a,
      b,
      config,
      answer({ a: 0, b: [0], confidence: 0.95, reason: "nearer" }),
    );
    expect(yes.matches).toMatchObject([
      { tier: "model", rule: "model", a: [0], b: [0], score: 0.95 },
    ]);
    const maybe = await withModel(
      first,
      a,
      b,
      config,
      answer({ a: 0, b: [0], confidence: 0.6, reason: "?" }),
    );
    expect(maybe.matches).toEqual([]);
    expect(maybe.proposals).toMatchObject([{ tier: "model", a: [0], b: [0] }]);
    expect(maybe.unmatched.a).toEqual([0]);
  });

  it("drops answers that don't read or name a candidate it wasn't given", async () => {
    for (const bad of [
      { a: 0, b: [3], confidence: 0.99, reason: "the CAD one" },
      { a: 0, b: [9], confidence: 0.99, reason: "made up" },
      { a: 0, b: [0, 0], confidence: 0.99, reason: "twice" },
      { a: 0, b: [0], confidence: 1.5, reason: "too sure" },
      "match B1",
    ]) {
      const out = await withModel(first, a, b, config, answer(bad));
      expect(out.matches, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("refuses a sum that differs when the configuration allows no partial match", async () => {
    const out = await withModel(
      first,
      a,
      b,
      config,
      answer({ a: 0, b: [0, 1], confidence: 0.99, reason: "both" }),
    );
    expect(out.matches).toEqual([]);
    expect(out.refused).toEqual([{ a: 0, b: [0, 1], veto: "amount" }]);
    // With partial allowed, amounts of the other sign are still refused.
    const partial = { ...config, rules: ["partial" as const] };
    const mixed = await withModel(
      first,
      a,
      b,
      partial,
      answer({ a: 0, b: [0, 2], confidence: 0.99, reason: "x" }),
    );
    expect(mixed.refused).toMatchObject([{ veto: "amount" }]);
  });

  it("is never asked when the configuration has no model tier", async () => {
    let asked = false;
    await withModel(first, a, b, { ...config, model: null }, async () => {
      asked = true;
      return [];
    });
    expect(asked).toBe(false);
  });
});

describe("keys", () => {
  it("reads invoice numbers as two systems write them", () => {
    expect(invoiceNumber("INV-000042")).toBe("42");
    expect(invoiceNumber("Invoice #42")).toBe("42");
    expect(invoiceNumber("42")).toBe("42");
    expect(invoiceNumber("ROMCO-42")).toBe("romco42");
    expect(invoiceNumber("INV-0")).toBeNull();
    expect(alnumReference("CHK #1042")).toBe("chk1042");
    expect(alnumReference("12")).toBeNull();
  });

  it("reads names without their legal form", () => {
    expect(normalizeCounterparty("ROMCO, Inc.")).toBe("romco");
    expect(normalizeCounterparty("The Romco Company LLC")).toBe("romco");
    expect(nameSimilarity("romco", "romco industries")).toBeGreaterThanOrEqual(0.9);
    expect(nameSimilarity("romco", "rocky mountain coal")).toBeLessThan(0.5);
  });
});

describe("saved rules", () => {
  it("keeps a correction normalised, and nothing when the values already agree", () => {
    expect(
      ruleFromCorrection(INVOICE_TWO_SYSTEMS, {
        field: "counterparty",
        a: "Rocky Mountain Coal Co.",
        b: "ROMCO",
      }),
    ).toEqual({ field: "counterparty", aValue: "rocky mountain coal", bValue: "romco" });
    expect(
      ruleFromCorrection(INVOICE_TWO_SYSTEMS, { field: "reference", a: "INV-0042", b: "42" }),
    ).toBeNull();
  });

  it("learns the references first from a person's match, then the names", () => {
    expect(
      ruleFromPair(
        BANK_TO_LEDGER,
        { reference: "ACH 55102", counterparty: "x", amount: "1" },
        { reference: "TRF-55102", counterparty: "y", amount: "1" },
      ),
    ).toEqual({ field: "reference", aValue: "ach55102", bValue: "trf55102" });
    expect(
      ruleFromPair(
        INVOICE_TWO_SYSTEMS,
        { reference: "INV-7", counterparty: "Rocky Mountain Coal", amount: "1" },
        { reference: "7", counterparty: "ROMCO", amount: "1" },
      ),
    ).toEqual({ field: "counterparty", aValue: "rocky mountain coal", bValue: "romco" });
  });

  it("never loosens the amount: a rule-mapped pair that differs in amount stays open", () => {
    const rules: SavedMatchRule[] = [
      { id: "r", field: "reference", aValue: "ach1", bValue: "trf1" },
    ];
    const out = matchItems(
      [{ reference: "ACH 1", date: "2026-10-01", amount: "-10.00" }],
      [{ reference: "TRF 1", date: "2026-10-01", amount: "-10.01" }],
      BANK_TO_LEDGER,
      { rules },
    );
    expect(out.matches).toEqual([]);
  });
});

describe("decideRanked", () => {
  const read = (w: { s: number; v?: boolean }) => ({ score: w.s, vetoed: w.v ?? false });
  it("matches the one sure candidate; two sure, or none, stay open", () => {
    expect(decideRanked([{ s: 0.95 }, { s: 0.5 }], 0.9, read)).toEqual({
      kind: "matched",
      best: { s: 0.95 },
    });
    expect(decideRanked([{ s: 0.95 }, { s: 0.92 }], 0.9, read).kind).toBe("open");
    expect(decideRanked([{ s: 0.95, v: true }], 0.9, read).kind).toBe("nothing");
  });
});
