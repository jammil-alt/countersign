// R6 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Agents and their owner"): the owner's cheap
// watch. On every step of a v4 process the owner looks, without a model, for a result that is
// plainly off: an empty result, a total far outside what the step gave before, or a confer that
// disagreed. A signal only asks for the owner's review (the v0.13 checkpoint review, §10.11); it
// never changes the output, the plan, an approval or a permission.
//
// Pure, and free of runtime imports from the rest of oversight (decision.ts re-exports this file),
// so nothing here can start an import cycle.

import { Decimal } from "../money";
import type { ConferVerdict } from "../process/schema";

/** A total is "far outside" when it is this many times above, or below, the step's median. */
// DECISION: a factor of 10 each way, over at least 5 earlier results, at most 20 kept (the last 20
// succeeded runs of the step): a bill ten times a vendor's usual is worth a look, a 30% swing is
// not, and fewer than 5 results say nothing about "usual".
export const OWNER_OUTLIER_FACTOR = 10;
export const OWNER_OUTLIER_MIN_HISTORY = 5;
export const OWNER_HISTORY_MAX = 20;

/** Where a step's output carries its total, looked for in this order at the top level. */
// DECISION: the total is a top-level field by one of these names, as a decimal string or a money
// object (`{ amount, currency }`). JS numbers are not read: money is never a float (invariant 6).
export const OWNER_TOTAL_FIELDS = ["total", "totalAmount", "grandTotal", "amount"] as const;

/** One earlier total of the step. */
export interface TotalSample {
  amount: string;
  currency: string | null;
}

export type AnomalySignal =
  /** A read, a skill or a conversation that gave nothing back. */
  | { kind: "empty_output" }
  /** A total far outside the step's earlier totals in the same currency. */
  | {
      kind: "total_outlier";
      field: string;
      amount: string;
      currency: string | null;
      median: string;
      runs: number;
    }
  /** A confer check on the step whose reviewer disagreed (advice: the owner weighs it). */
  | { kind: "confer_disagreed"; count: number };

/** Kinds whose output is their result, so an empty one is a signal. A write's output is a receipt. */
// DECISION: a write's empty receipt is no signal (many write tools return nothing), else every
// write would cost a review.
const RESULT_KINDS: readonly string[] = ["skill", "read", "conversation"];

const DECIMAL = /^-?\d+(\.\d+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (isRecord(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Whether a result is empty: nothing, an empty string, list or object, or an object whose every
 * field is one of those (`{ "items": [] }`). A zero or `false` is an answer, not empty.
 */
export function isEmptyOutput(output: unknown): boolean {
  if (blank(output)) return true;
  return isRecord(output) && Object.values(output).every(blank);
}

/** A step output's total: the first of `OWNER_TOTAL_FIELDS` holding a decimal or a money object. */
export function outputTotal(output: unknown): (TotalSample & { field: string }) | null {
  if (!isRecord(output)) return null;
  for (const field of OWNER_TOTAL_FIELDS) {
    if (!Object.hasOwn(output, field)) continue;
    const v = output[field];
    if (typeof v === "string" && DECIMAL.test(v.trim())) {
      return { field, amount: v.trim(), currency: null };
    }
    if (isRecord(v) && typeof v.amount === "string" && DECIMAL.test(v.amount.trim())) {
      const currency = typeof v.currency === "string" ? v.currency : null;
      return { field, amount: v.amount.trim(), currency };
    }
  }
  return null;
}

function median(values: readonly Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] as Decimal;
  if (sorted.length % 2 === 1) return hi;
  return (sorted[mid - 1] as Decimal).plus(hi).dividedBy(2);
}

/**
 * The cheap watch on one step's result: no model, no database, only the result, the step's
 * earlier totals and its confer verdicts. Empty when nothing looks off.
 */
export function anomalySignals(input: {
  kind: string;
  output: unknown;
  /** The step's earlier totals, newest first (`historyTotals`). */
  history?: readonly TotalSample[] | undefined;
  /** The verdicts of the step's confer check, if it had one. */
  confer?: readonly ConferVerdict[] | undefined;
}): AnomalySignal[] {
  const out: AnomalySignal[] = [];
  if (RESULT_KINDS.includes(input.kind) && isEmptyOutput(input.output)) {
    out.push({ kind: "empty_output" });
  }
  const total = outputTotal(input.output);
  if (total) {
    const same = (input.history ?? [])
      .slice(0, OWNER_HISTORY_MAX)
      .filter((h) => h.currency === total.currency && DECIMAL.test(h.amount))
      .map((h) => new Decimal(h.amount));
    if (same.length >= OWNER_OUTLIER_MIN_HISTORY) {
      const m = median(same);
      const value = new Decimal(total.amount);
      // DECISION: only a positive median gives a ratio; a step whose totals are usually zero or
      // negative (credits) is not watched for size.
      if (
        m.gt(0) &&
        (value.gt(m.times(OWNER_OUTLIER_FACTOR)) || value.times(OWNER_OUTLIER_FACTOR).lt(m))
      ) {
        out.push({
          kind: "total_outlier",
          field: total.field,
          amount: total.amount,
          currency: total.currency,
          median: m.toFixed(),
          runs: same.length,
        });
      }
    }
  }
  const disagreed = (input.confer ?? []).filter((v) => v === "disagree").length;
  if (disagreed > 0) out.push({ kind: "confer_disagreed", count: disagreed });
  return out;
}

/**
 * Earlier outputs of an agent's steps, as totals by key (the caller's: a step path, `stepPathOf`),
 * newest first, at most `OWNER_HISTORY_MAX` each. Rows come newest first; those without a total
 * are left out.
 */
export function historyTotals(
  rows: readonly { key: string; output: unknown }[],
): Record<string, TotalSample[]> {
  const out = new Map<string, TotalSample[]>();
  for (const row of rows) {
    const total = outputTotal(row.output);
    if (!total) continue;
    const list = out.get(row.key) ?? [];
    if (list.length >= OWNER_HISTORY_MAX) continue;
    list.push({ amount: total.amount, currency: total.currency });
    out.set(row.key, list);
  }
  // fromEntries defines own properties, so a key like `__proto__` stays a key.
  return Object.fromEntries(out);
}
