// Skill model (2026-11-10; ARCHITECTURE §10.14, §12.3): item matching split into its parts.
// `materials.match_line` did all of it in one tool, the model inside (hidden AI) and writes after.
// Here it is three skills and a write:
//
//   Look up existing (deterministic): normalize, the vendor's aliases, the category parsers,
//     candidates equal on key attributes (then trigram names); a line the rules settle is decided.
//   Match the unmatched (AI): the open lines and their candidates → matched / new item / unsure,
//     with a confidence (and the attributes it read, for a line the parsers couldn't finish).
//   Check matches (deterministic): the hard rules veto the model. Never a match when a key
//     attribute differs, never a candidate the lookup didn't offer, never a new item when an
//     equal item exists or a required attribute is missing; below the threshold a person decides.
//   Save to records: record the matches (item_match rows, new items, aliases, events).
//
// This file is the pure part (no database, no model): the rules' decision for a line and its
// candidates, and the check. The lookup's reads and the recording are in ./split-store.ts.

import type { Category } from "../schema";
import { type ParsedLine, RULE_CONFIDENCE, scorePair, withCompleteness } from "./keys";
import { RULE_NEW_ITEM_CONFIDENCE } from "./match";
import { type Attributes, CATEGORY_SPECS } from "./parsers";
import { MATCH_CONFIDENCE_AUTO } from "./settings";

/** How many candidates an open line goes to the model with. */
export const OPEN_CANDIDATES = 5;

/** A model answer is never trusted above this when the hard rules vetoed it (as match_line). */
export const VETOED_CONFIDENCE = 0.5;

/** A catalog item as the lookup offers it. */
export interface CandidateItem {
  catalogItemId: string;
  name: string;
  category: Category;
  attributes: Attributes;
  standardUom: string;
  /** Trigram similarity of names, when found by name. */
  similarity: number | null;
}

/** A candidate with the rules' score for the line. */
export interface ScoredCandidate extends CandidateItem {
  confidence: number;
  hinge: string | null;
  vetoed: boolean;
}

/** One line after Look up existing. */
export interface LookedUpLine {
  docLineId: string;
  /** The line's number on the document (1-based, printed order): how the model names it. */
  lineNo: number;
  description: string;
  category: Category;
  attributes: Attributes;
  missing: string[];
  /** `open`: the rules didn't settle it; it goes to Match the unmatched. */
  decision: "matched" | "new_item" | "open";
  catalogItemId: string | null;
  catalogItemName: string | null;
  method: "alias" | "rules" | "recalled" | null;
  confidence: number;
  hinge: string | null;
  candidates: ScoredCandidate[];
}

/** An open line as Match the unmatched reads it: no scores, only what the model needs. */
export interface OpenLine {
  lineNo: number;
  description: string;
  category: Category;
  attributes: Attributes;
  missing: string[];
  candidates: { catalogItemId: string; name: string; attributes: Attributes }[];
}

/** What Match the unmatched answers for a line. */
export interface MatchAnswer {
  lineNo: number;
  decision: "matched" | "new_item" | "unsure";
  catalogItemId: string | null;
  confidence: number;
  hingeAttribute: string | null;
  /** The key attributes the model read, for a line the parsers couldn't finish (optional). */
  attributes?: Attributes | undefined;
}

/** One line after Check matches: what Save to records records. */
export interface CheckedLine {
  docLineId: string;
  lineNo: number;
  decision: "matched" | "new_item" | "unsure";
  catalogItemId: string | null;
  confidence: number;
  method: "alias" | "rules" | "llm" | "recalled";
  hingeAttribute: string | null;
  needsReview: boolean;
  /** Why the check overruled the model, in plain words; null when it didn't. */
  vetoed: string | null;
  category: Category;
  attributes: Attributes;
  candidates: ScoredCandidate[];
}

/** Scores candidates for a parsed line, best first, the vetoed ones after the plausible ones. */
export function scoreCandidates(
  parsed: Pick<ParsedLine, "category" | "attributes">,
  items: readonly CandidateItem[],
): ScoredCandidate[] {
  return items
    .map((c) => {
      const s = scorePair(parsed, { category: c.category, attributes: c.attributes });
      return {
        ...c,
        confidence: s.confidence,
        hinge: s.hinge,
        vetoed: s.comparison.differ.length > 0,
      };
    })
    .sort(
      (a, b) =>
        Number(a.vetoed) - Number(b.vetoed) ||
        b.confidence - a.confidence ||
        (b.similarity ?? 1) - (a.similarity ?? 1),
    );
}

/**
 * Look up existing, the rules' part (as match_line's steps 4 and 6): exactly one candidate with
 * every key attribute equal is a match; none that could be the line, with every required key
 * attribute stated, is a new item; anything else is open, for the model.
 */
export function decideByRules(
  line: { docLineId: string; lineNo: number; description: string },
  parsed: ParsedLine,
  items: readonly CandidateItem[],
  /** How many candidates the line keeps (§1.88: the vendor-first skills' shortlist size). */
  keep: number = OPEN_CANDIDATES,
): LookedUpLine {
  const scored = scoreCandidates(parsed, items);
  const exact = scored.filter((c) => c.confidence >= RULE_CONFIDENCE.exact);
  const possible = scored.filter((c) => c.confidence > RULE_CONFIDENCE.veto);
  const base = {
    docLineId: line.docLineId,
    lineNo: line.lineNo,
    description: line.description,
    category: parsed.category,
    attributes: parsed.attributes,
    missing: parsed.missing,
    candidates: scored.slice(0, keep),
  };
  const [only] = exact;
  if (exact.length === 1 && only) {
    return {
      ...base,
      decision: "matched",
      catalogItemId: only.catalogItemId,
      catalogItemName: only.name,
      method: "rules",
      confidence: RULE_CONFIDENCE.exact,
      hinge: null,
    };
  }
  if (possible.length === 0 && parsed.complete && parsed.category !== "other") {
    return {
      ...base,
      decision: "new_item",
      catalogItemId: null,
      catalogItemName: null,
      method: "rules",
      confidence: RULE_NEW_ITEM_CONFIDENCE,
      hinge: scored.find((c) => c.vetoed)?.hinge ?? null,
    };
  }
  return {
    ...base,
    decision: "open",
    catalogItemId: null,
    catalogItemName: null,
    method: null,
    confidence: Math.max(0, ...scored.map((c) => c.confidence)),
    hinge: parsed.missing[0] ?? scored.find((c) => !c.vetoed)?.hinge ?? null,
  };
}

/**
 * The open lines, as Match the unmatched reads them. `withoutVetoed` (the vendor-first skills,
 * §1.88) leaves out the candidates a key attribute rules out, so the model picks only from a
 * shortlist the rules allow; the line keeps them for a person's card.
 */
// DECISION (review of vendor/web3, finding 5): the vendor-first path filters its shortlist by code
// on the key attributes before the AI, as §1.88 says; Match the unmatched keeps sending them
// (sorted last) so its stored steps make the same requests and replay the same recorded answers.
export function openLines(
  lines: readonly LookedUpLine[],
  options: { withoutVetoed?: boolean } = {},
): OpenLine[] {
  return lines
    .filter((l) => l.decision === "open")
    .map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      category: l.category,
      attributes: l.attributes,
      missing: l.missing,
      candidates: l.candidates
        .filter((c) => !(options.withoutVetoed && c.vetoed))
        .map((c) => ({
          catalogItemId: c.catalogItemId,
          name: c.name,
          attributes: c.attributes,
        })),
    }));
}

/**
 * The line's attributes with what the model read added where the parsers stated nothing: only the
 * category's key attributes, lower case, never overriding a stated one.
 */
// DECISION: the model's reading fills only attributes the rules left unstated (as match_line's
// fallback reading did, which was used only when it stated more); it never changes a stated one.
export function withModelReading(
  line: Pick<LookedUpLine, "description" | "category" | "attributes">,
  reading: Attributes | undefined,
): ParsedLine {
  const keys = new Set(CATEGORY_SPECS[line.category].keys);
  const attributes: Attributes = { ...line.attributes };
  let added = false;
  for (const [name, value] of Object.entries(reading ?? {})) {
    const key = name.trim().toLowerCase();
    const clean = String(value).trim().toLowerCase().replace(/\s+/g, "_");
    if (keys.has(key) && clean && !attributes[key]) {
      attributes[key] = clean;
      added = true;
    }
  }
  return withCompleteness(
    line.description.toLowerCase(),
    line.category,
    attributes,
    added ? "model" : "rules",
  );
}

/** The threshold from a step's settings (`match_confidence_auto`), else the default. */
export function thresholdOf(value: unknown): number {
  const v = Number(value);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : MATCH_CONFIDENCE_AUTO;
}

/**
 * Check matches: the hard rules over the model's answers, then the threshold. A decided line keeps
 * its decision; an open line takes the model's answer only when the rules allow it.
 */
export function checkMatches(
  lines: readonly LookedUpLine[],
  answers: readonly MatchAnswer[],
  threshold: number = MATCH_CONFIDENCE_AUTO,
): CheckedLine[] {
  // DECISION: the model names a line by its number on the document, not its id: shorter, and
  // the same request (and so the same recorded answer) for the same document.
  const byLine = new Map(answers.map((a) => [a.lineNo, a]));
  return lines.map((line) => checkLine(line, byLine.get(line.lineNo), threshold));
}

// DECISION: Check matches keeps every rule of match_line and adds two: the model may match only a
// candidate Look up existing offered, and a new item needs every required key attribute stated
// (with what the model read). A vetoed answer's confidence is capped at VETOED_CONFIDENCE.
function checkLine(
  line: LookedUpLine,
  answer: MatchAnswer | undefined,
  threshold: number,
): CheckedLine {
  const base = {
    docLineId: line.docLineId,
    lineNo: line.lineNo,
    category: line.category,
    attributes: line.attributes,
    candidates: line.candidates,
  };
  const unsure = (
    confidence: number,
    hinge: string | null,
    vetoed: string | null,
    method: CheckedLine["method"],
    attributes: Attributes = line.attributes,
  ): CheckedLine => ({
    ...base,
    attributes,
    decision: "unsure",
    catalogItemId: null,
    confidence,
    method,
    hingeAttribute: hinge,
    needsReview: true,
    vetoed,
  });
  if (line.decision !== "open") {
    const method = line.method ?? "rules";
    if (line.confidence < threshold) return unsure(line.confidence, line.hinge, null, method);
    return {
      ...base,
      decision: line.decision,
      catalogItemId: line.catalogItemId,
      confidence: line.confidence,
      method,
      hingeAttribute: line.hinge,
      needsReview: false,
      vetoed: null,
    };
  }
  if (!answer) {
    return unsure(line.confidence, line.hinge, "the model gave no answer for this line", "rules");
  }
  const confidence = Math.min(1, Math.max(0, answer.confidence));
  const hinge = answer.hingeAttribute?.trim().toLowerCase() || null;
  const parsed = withModelReading(line, answer.attributes);
  if (answer.decision === "unsure")
    return unsure(confidence, hinge, null, "llm", parsed.attributes);
  if (answer.decision === "matched") {
    const chosen = line.candidates.find((c) => c.catalogItemId === answer.catalogItemId);
    if (!chosen) {
      return unsure(
        0,
        hinge,
        "the model named an item that wasn't one of the candidates",
        "llm",
        parsed.attributes,
      );
    }
    // The hard rule: never a match when a key attribute differs (the category included).
    const s = scorePair(parsed, { category: chosen.category, attributes: chosen.attributes });
    const differ = s.comparison.differ[0];
    if (differ) {
      return unsure(
        Math.min(confidence, VETOED_CONFIDENCE),
        differ,
        `${differ} differs from ${chosen.name}`,
        "llm",
        parsed.attributes,
      );
    }
    if (confidence < threshold) return unsure(confidence, hinge, null, "llm", parsed.attributes);
    return {
      ...base,
      attributes: parsed.attributes,
      decision: "matched",
      catalogItemId: chosen.catalogItemId,
      confidence,
      method: "llm",
      hingeAttribute: hinge,
      needsReview: false,
      vetoed: null,
    };
  }
  // new_item: not when an item with every key attribute equal exists, nor without what an item needs.
  const equal = line.candidates.find(
    (c) =>
      scorePair(parsed, { category: c.category, attributes: c.attributes }).confidence >=
      RULE_CONFIDENCE.exact,
  );
  if (equal) {
    return unsure(
      Math.min(confidence, VETOED_CONFIDENCE),
      hinge,
      `${equal.name} has every key attribute of this line`,
      "llm",
      parsed.attributes,
    );
  }
  if (!parsed.complete || parsed.category === "other") {
    return unsure(
      Math.min(confidence, VETOED_CONFIDENCE),
      parsed.missing[0] ?? hinge,
      parsed.complete
        ? "a new item needs a category"
        : `a new item needs ${parsed.missing.join(", ")}`,
      "llm",
      parsed.attributes,
    );
  }
  if (confidence < threshold) return unsure(confidence, hinge, null, "llm", parsed.attributes);
  return {
    ...base,
    attributes: parsed.attributes,
    decision: "new_item",
    catalogItemId: null,
    confidence,
    method: "llm",
    hingeAttribute: hinge,
    needsReview: false,
    vetoed: null,
  };
}

/** Counts for a step's summary and an If step's condition. */
export function checkSummary(lines: readonly CheckedLine[]) {
  const needsReview = lines.filter((l) => l.needsReview).length;
  return {
    total: lines.length,
    matched: lines.filter((l) => l.decision === "matched").length,
    newItems: lines.filter((l) => l.decision === "new_item").length,
    needsReview,
    anyNeedsReview: needsReview > 0,
  };
}
