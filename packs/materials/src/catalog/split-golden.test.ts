// Skill model (2026-11-10): the matching golden set (fixtures/matching) through the split chain,
//   Look up existing (deterministic) → Match the unmatched (AI) → Check matches (deterministic),
// each pair as a line (a) and the one catalog item it could be (b). Target, as for the old skill:
// precision on "same" of at least 95%.
//
// The old golden test judges the rules alone (`scorePair` at the auto threshold). Here the
// deterministic stages must decide exactly what the old rules decided, and the whole chain must
// hold 95% precision whatever the model says about the lines the rules leave open: a model that
// answers "matched, confidence 1" for every one (the worst case, which only the hard-rule veto in
// Check matches stands against), one that is never sure, and one that agrees with the labels. The
// model's answers are written by hand here (no API key); `apps/api`'s split test runs the AI skill
// itself through the runtime on a recorded, hand-written replay.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLine, scorePair } from "./keys";
import { MATCH_CONFIDENCE_AUTO } from "./settings";
import { checkMatches, decideByRules, type LookedUpLine, type MatchAnswer } from "./split";

interface Pair {
  a: string;
  b: string;
  label: "same" | "different";
  note?: string;
}

const dir = new URL("../../../../fixtures/matching/", import.meta.url);
const all = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => (JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { pairs: Pair[] }).pairs);

/** Look up existing for a pair: the line `a`, with `b` as its only candidate. */
function lookUp(p: Pair, i: number): LookedUpLine {
  const a = parseLine(p.a);
  const b = parseLine(p.b);
  return decideByRules({ docLineId: `line-${i}`, lineNo: i + 1, description: p.a }, a, [
    {
      catalogItemId: `item-${i}`,
      name: p.b,
      category: b.category,
      attributes: b.attributes,
      standardUom: b.standardUom,
      similarity: null,
    },
  ]);
}

type Model = (line: LookedUpLine, p: Pair) => MatchAnswer;

const answer = (line: LookedUpLine, decision: MatchAnswer["decision"]): MatchAnswer => ({
  lineNo: line.lineNo,
  decision,
  catalogItemId: decision === "matched" ? (line.candidates[0]?.catalogItemId ?? null) : null,
  confidence: 1,
  hingeAttribute: null,
});

const MODELS: Record<string, Model> = {
  "always matched": (line) => answer(line, "matched"),
  "never sure": (line) => answer(line, "unsure"),
  "agrees with the label": (line, p) => answer(line, p.label === "same" ? "matched" : "new_item"),
};

function chain(model: Model) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const falsePositives: string[] = [];
  all.forEach((p, i) => {
    const line = lookUp(p, i);
    const answers = line.decision === "open" ? [model(line, p)] : [];
    const [checked] = checkMatches([line], answers, MATCH_CONFIDENCE_AUTO);
    const same = checked?.decision === "matched" && checked.catalogItemId === `item-${i}`;
    if (same && p.label === "same") tp += 1;
    else if (same) {
      fp += 1;
      falsePositives.push(`${p.a} | ${p.b}`);
    } else if (p.label === "same") fn += 1;
  });
  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    falsePositives,
  };
}

describe("matching golden set through the split chain", () => {
  it("Look up existing decides exactly what the old rules decided", () => {
    all.forEach((p, i) => {
      const old = scorePair(parseLine(p.a), parseLine(p.b)).confidence >= MATCH_CONFIDENCE_AUTO;
      const line = lookUp(p, i);
      expect(line.decision === "matched", `${p.a} | ${p.b}`).toBe(old);
    });
  });

  it("holds 95% precision on 'same' whatever the model answers for the open lines", () => {
    const report: string[] = [];
    for (const [name, model] of Object.entries(MODELS)) {
      const r = chain(model);
      report.push(
        `${name}: precision ${(r.precision * 100).toFixed(1)}%, recall ${(r.recall * 100).toFixed(1)}% (${r.tp} same, ${r.fp} wrong, ${r.fn} to a person)`,
        ...r.falsePositives.map((f) => `  false positive: ${f}`),
      );
      expect(r.precision, name).toBeGreaterThanOrEqual(0.95);
      expect(r.recall, name).toBeGreaterThan(0.5);
    }
    console.info([`golden through the chain: ${all.length} pairs`, ...report].join("\n"));
  });

  it("does at least as well as the old rules, with a model that is never sure", () => {
    let oldTp = 0;
    let oldFp = 0;
    for (const p of all) {
      const same = scorePair(parseLine(p.a), parseLine(p.b)).confidence >= MATCH_CONFIDENCE_AUTO;
      if (same && p.label === "same") oldTp += 1;
      else if (same) oldFp += 1;
    }
    const r = chain(MODELS["never sure"] as Model);
    expect(r.tp).toBe(oldTp);
    expect(r.fp).toBe(oldFp);
  });

  it("vetoes every model match on a pair whose key attributes differ", () => {
    all.forEach((p, i) => {
      const a = parseLine(p.a);
      const b = parseLine(p.b);
      if (scorePair(a, b).comparison.differ.length === 0) return;
      const line = lookUp(p, i);
      if (line.decision !== "open") return;
      const [checked] = checkMatches([line], [answer(line, "matched")]);
      expect(checked?.decision, `${p.a} | ${p.b}`).toBe("unsure");
      expect(checked?.vetoed).toMatch(/differs/);
    });
  });
});
