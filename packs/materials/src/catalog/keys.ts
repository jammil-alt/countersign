// Parsing a line into its category and attributes, and comparing two items by their key
// attributes: the deterministic half of matching (ARCHITECTURE §12.3 steps 3, 4 and 7). The same
// comparison scores candidates, decides rule matches and vetoes the model.

import type { Category, StandardUom } from "../schema";
import { type NormalizeOptions, normalize } from "./normalize";
import { type Attributes, CATEGORY_SPECS, detectCategory } from "./parsers";

export interface ParsedLine {
  normalized: string;
  category: Category;
  attributes: Attributes;
  standardUom: StandardUom;
  /** Every required key attribute is stated. */
  complete: boolean;
  /** The required key attributes nobody stated. */
  missing: string[];
  /** Who read the attributes: the category parser, or the model's fallback reading. */
  parsedBy: "rules" | "model";
}

/** Parses an already-normalized description. */
export function parseNormalized(normalized: string, category?: Category): ParsedLine {
  const cat = category ?? detectCategory(normalized);
  const spec = CATEGORY_SPECS[cat];
  const attributes = spec.parse(normalized, normalized.split(" ").filter(Boolean));
  return withCompleteness(normalized, cat, attributes, "rules");
}

/** Normalizes and parses a vendor's description. */
export function parseLine(raw: string, options: NormalizeOptions = {}): ParsedLine {
  return parseNormalized(normalize(raw, options));
}

export function withCompleteness(
  normalized: string,
  category: Category,
  attributes: Attributes,
  parsedBy: ParsedLine["parsedBy"],
): ParsedLine {
  const spec = CATEGORY_SPECS[category];
  const missing = spec.required(attributes).filter((k) => !attributes[k]);
  return {
    normalized,
    category,
    attributes,
    standardUom: spec.standardUom(attributes),
    complete: missing.length === 0,
    missing,
    parsedBy,
  };
}

/** The key attributes a line states: what a candidate must contain (jsonb `@>`). */
export function statedKeys(category: Category, attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const k of CATEGORY_SPECS[category].keys) {
    const v = attributes[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * The category and every key attribute in order, `?` for an optional one nobody stated; null
 * unless every required one is stated. Unique per client among live items (migration 0006).
 */
export function keySignature(category: Category, attributes: Attributes): string | null {
  const spec = CATEGORY_SPECS[category];
  if (spec.required(attributes).some((k) => !attributes[k])) return null;
  return [category, ...spec.keys.map((k) => `${k}=${attributes[k] ?? "?"}`)].join("|");
}

export interface KeyComparison {
  sameCategory: boolean;
  /** Key attributes both state, with the same value. */
  equal: string[];
  /** Key attributes both state, with different values: a hard-rule veto. */
  differ: string[];
  /** Key attributes only one side states. */
  oneSided: string[];
  /** Required key attributes either side lacks. */
  missingRequired: string[];
}

export function compareKeys(
  a: { category: Category; attributes: Attributes },
  b: { category: Category; attributes: Attributes },
): KeyComparison {
  if (a.category !== b.category) {
    return {
      sameCategory: false,
      equal: [],
      differ: ["category"],
      oneSided: [],
      missingRequired: [],
    };
  }
  const spec = CATEGORY_SPECS[a.category];
  const out: KeyComparison = {
    sameCategory: true,
    equal: [],
    differ: [],
    oneSided: [],
    missingRequired: [],
  };
  for (const k of spec.keys) {
    const x = a.attributes[k];
    const y = b.attributes[k];
    if (x && y) (x === y ? out.equal : out.differ).push(k);
    else if (x || y) out.oneSided.push(k);
  }
  const required = new Set([...spec.required(a.attributes), ...spec.required(b.attributes)]);
  out.missingRequired = [...required].filter((k) => !a.attributes[k] || !b.attributes[k]);
  return out;
}

/** Hard rule (ARCHITECTURE §12.3 step 7): never match when any key attribute differs. */
export function vetoReason(comparison: KeyComparison): string | null {
  return comparison.differ[0] ?? null;
}

// DECISION: rule confidences. Every key attribute stated by both and equal: 0.97 (above the 0.90
// default threshold, so the match is automatic). A key attribute only one side states: 0.75,
// for the model or a person. A required one missing: 0.5. Any difference: 0, a veto.
export const RULE_CONFIDENCE = { exact: 0.97, oneSided: 0.75, incomplete: 0.5, veto: 0 } as const;

export interface PairScore {
  confidence: number;
  /** The attribute the score turned on, when one did. */
  hinge: string | null;
  comparison: KeyComparison;
}

/** How sure the rules alone are that two parsed lines are one item. */
export function scorePair(
  a: { category: Category; attributes: Attributes },
  b: { category: Category; attributes: Attributes },
): PairScore {
  const comparison = compareKeys(a, b);
  const veto = vetoReason(comparison);
  if (veto) return { confidence: RULE_CONFIDENCE.veto, hinge: veto, comparison };
  if (comparison.missingRequired.length > 0) {
    return {
      confidence: RULE_CONFIDENCE.incomplete,
      hinge: comparison.missingRequired[0] ?? null,
      comparison,
    };
  }
  if (comparison.oneSided.length > 0) {
    return {
      confidence: RULE_CONFIDENCE.oneSided,
      hinge: comparison.oneSided[0] ?? null,
      comparison,
    };
  }
  return { confidence: RULE_CONFIDENCE.exact, hinge: null, comparison };
}

/** The catalog's name for a parsed line. */
export function canonicalName(
  category: Category,
  attributes: Attributes,
  fallback: string,
): string {
  const name = CATEGORY_SPECS[category].name(attributes).trim();
  if (category === "other" || name.length < 3) {
    const text = fallback.toLowerCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return name;
}
