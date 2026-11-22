// A client's saved match rules (docs/plan.md §1.215; packages/db's `match_rule`, migration 0085):
// an operator's correction kept so the same pair matches by itself next time, for that client
// only (invariant 1). A rule says a value on side A is side B's value, for references or
// counterparties; it never loosens the hard rules (amounts, dates, currencies stay checked).

import type { MatchConfig } from "./config";
import type { MatchItem } from "./engine";
import type { MatchCorrection, MatchRuleField } from "./fields";
import { normalizeCounterparty, normalizeReference } from "./normalize";

export function normalizeRuleValue(
  config: MatchConfig,
  field: MatchRuleField,
  v: string,
): string | null {
  return field === "reference" ? normalizeReference(config.reference, v) : normalizeCounterparty(v);
}

export interface RuleValues {
  field: MatchRuleField;
  aValue: string;
  bValue: string;
}

/** A correction as typed, normalised by its configuration; null when there is nothing to keep. */
export function ruleFromCorrection(
  config: MatchConfig,
  c: Pick<MatchCorrection, "field" | "a" | "b">,
): RuleValues | null {
  const aValue = normalizeRuleValue(config, c.field, c.a);
  const bValue = normalizeRuleValue(config, c.field, c.b);
  if (!aValue || !bValue || aValue === bValue) return null;
  return { field: c.field, aValue, bValue };
}

/**
 * The rule a person's match teaches: the references when both sides state different ones, else
 * the counterparties when both state different ones; null when the keys already agree (the
 * correction was about an amount or a date, which a rule never loosens).
 */
// DECISION: references first: an invoice number names one invoice, a name every one of a customer.
export function ruleFromPair(config: MatchConfig, a: MatchItem, b: MatchItem): RuleValues | null {
  for (const field of ["reference", "counterparty"] as const) {
    const x = a[field];
    const y = b[field];
    if (!x || !y) continue;
    const rule = ruleFromCorrection(config, { field, a: x, b: y });
    if (rule) return rule;
  }
  return null;
}
