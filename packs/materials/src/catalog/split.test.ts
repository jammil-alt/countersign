// Skill model (2026-11-10): Check matches, the deterministic veto over Match the unmatched. No
// database, no model.

import { describe, expect, it } from "vitest";
import { parseLine } from "./keys";
import {
  type CandidateItem,
  checkMatches,
  checkSummary,
  decideByRules,
  type LookedUpLine,
  openLines,
} from "./split";

const item = (id: string, text: string): CandidateItem => {
  const p = parseLine(text);
  return {
    catalogItemId: id,
    name: text,
    category: p.category,
    attributes: p.attributes,
    standardUom: p.standardUom,
    similarity: null,
  };
};

const line = (text: string, items: CandidateItem[]): LookedUpLine =>
  decideByRules({ docLineId: "l1", lineNo: 1, description: text }, parseLine(text), items);

describe("Look up existing and Check matches", () => {
  it("settles an exact match by the rules and keeps it through the check", () => {
    const l = line("3/4 BB/BB BALTIC BIRCH 5X5", [item("i1", "3/4 BALTIC BIRCH BB/BB 60X60")]);
    expect(l.decision).toBe("matched");
    const [c] = checkMatches([l], []);
    expect(c).toMatchObject({ decision: "matched", catalogItemId: "i1", method: "rules" });
    expect(openLines([l])).toEqual([]);
  });

  it("an open line with no answer goes to a person", () => {
    const l = line("BLUM 71B3550 HINGE", [item("i1", "BLUM 71B3550 CLIP TOP HINGE SATIN NICKEL")]);
    if (l.decision !== "open") return;
    const [c] = checkMatches([l], []);
    expect(c).toMatchObject({ decision: "unsure", needsReview: true });
  });

  it("refuses an item that wasn't a candidate, and one below the threshold", () => {
    const l: LookedUpLine = {
      ...line("BLUM 71B3550 HINGE", []),
      decision: "open",
      candidates: [],
    };
    const [made] = checkMatches(
      [l],
      [{ lineNo: 1, decision: "matched", catalogItemId: "x", confidence: 1, hingeAttribute: null }],
    );
    expect(made).toMatchObject({ decision: "unsure", confidence: 0 });
    expect(made?.vetoed).toMatch(/wasn't one of the candidates/);
  });

  it("refuses a new item when an equal item exists or a required attribute is missing", () => {
    const equal = line("BLUM 71B3550 CLIP TOP HINGE", [
      item("i1", "BLUM 71B3550 CLIP TOP HINGE"),
      item("i2", "BLUM 71B3550 CLIP TOP HINGE"),
    ]);
    expect(equal.decision).toBe("open");
    const [c] = checkMatches(
      [equal],
      [
        {
          lineNo: 1,
          decision: "new_item",
          catalogItemId: null,
          confidence: 1,
          hingeAttribute: null,
        },
      ],
    );
    expect(c).toMatchObject({ decision: "unsure", needsReview: true });
    expect(c?.vetoed).toMatch(/every key attribute/);

    const vague = line("PLYWOOD SHEET", []);
    const [v] = checkMatches(
      [{ ...vague, decision: "open" }],
      [
        {
          lineNo: 1,
          decision: "new_item",
          catalogItemId: null,
          confidence: 1,
          hingeAttribute: null,
        },
      ],
    );
    expect(v).toMatchObject({ decision: "unsure" });
    expect(v?.vetoed).toMatch(/a new item needs/);
  });

  it("counts what needs a person, for an If step", () => {
    const l = line("PLYWOOD SHEET", []);
    const lines = checkMatches([{ ...l, decision: "open" }], []);
    expect(checkSummary(lines)).toMatchObject({ total: 1, needsReview: 1, anyNeedsReview: true });
  });
});
