// The matching golden set (ARCHITECTURE §12.3, docs/plan.md §4 M8): labeled pairs from
// fixtures/matching, heavy on near-misses. The deterministic stage decides "same" when its
// confidence reaches the auto threshold (match_confidence_auto, 0.90). Target: precision on
// "same" of at least 95%. Recall is reported: pairs below the threshold go to the model and then
// to a person, so a miss here costs a review, never a wrong match.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLine, scorePair } from "./keys";
import { MATCH_CONFIDENCE_AUTO } from "./settings";

interface Pair {
  a: string;
  b: string;
  label: "same" | "different";
  note?: string;
}

const dir = new URL("../../../../fixtures/matching/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const sets = files.map((f) => ({
  file: f,
  pairs: (JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { pairs: Pair[] }).pairs,
}));

function evaluate(pairs: readonly Pair[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const falsePositives: string[] = [];
  for (const p of pairs) {
    const score = scorePair(parseLine(p.a), parseLine(p.b));
    const predicted = score.confidence >= MATCH_CONFIDENCE_AUTO;
    if (predicted && p.label === "same") tp += 1;
    else if (predicted) {
      fp += 1;
      falsePositives.push(`${p.a} | ${p.b} (${p.note ?? ""})`);
    } else if (p.label === "same") fn += 1;
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { tp, fp, fn, precision, recall, falsePositives };
}

describe("matching golden set", () => {
  const all = sets.flatMap((s) => s.pairs);

  it("has at least 150 labeled pairs, most of them near-misses", () => {
    expect(all.length).toBeGreaterThanOrEqual(150);
    const different = all.filter((p) => p.label === "different").length;
    expect(different / all.length).toBeGreaterThan(0.5);
  });

  it("reaches 95% precision on 'same' at the auto threshold (recall reported)", () => {
    const result = evaluate(all);
    const lines = sets.map((s) => {
      const r = evaluate(s.pairs);
      return `${s.file}: precision ${(r.precision * 100).toFixed(1)}%, recall ${(r.recall * 100).toFixed(1)}% (${r.tp} auto, ${r.fp} wrong, ${r.fn} to review)`;
    });
    console.info(
      [
        `golden: ${all.length} pairs; precision ${(result.precision * 100).toFixed(1)}%, recall ${(result.recall * 100).toFixed(1)}%`,
        ...lines,
        ...result.falsePositives.map((f) => `  false positive: ${f}`),
      ].join("\n"),
    );
    expect(result.precision).toBeGreaterThanOrEqual(0.95);
    // Recall is reported, not targeted; this floor only catches a parser that stopped working.
    expect(result.recall).toBeGreaterThan(0.5);
  });

  it("never auto-matches a pair whose labeled near-miss is a key attribute", () => {
    for (const p of all.filter((x) => x.label === "different")) {
      const score = scorePair(parseLine(p.a), parseLine(p.b));
      expect(score.confidence, `${p.a} | ${p.b}`).toBeLessThan(MATCH_CONFIDENCE_AUTO);
    }
  });
});
