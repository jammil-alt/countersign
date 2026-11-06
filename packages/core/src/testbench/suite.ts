// v0.12 W2-C: fixtures and suite metrics (docs/plan.md §1.46). Which fixture answers a tool call,
// and what a suite run reports: pass rate, precision on label fields, cost per case.

import { deepEqual, isPlainObject } from "../json";
import { Decimal } from "../money";
import type { Fixture, LabelField, TestResultStatus } from "./case";

/** The first fixture for `tool` whose input fields all equal the call's; null when none does. */
export function fixtureFor(
  fixtures: readonly Fixture[],
  tool: string,
  input: unknown,
): Fixture | null {
  for (const f of fixtures) {
    if (f.tool !== tool) continue;
    if (!f.input) return f;
    if (!isPlainObject(input)) continue;
    const wanted = f.input;
    const holds = Object.keys(wanted).every(
      (k) => Object.hasOwn(input, k) && deepEqual(wanted[k], input[k]),
    );
    if (holds) return f;
  }
  return null;
}

export interface CaseOutcome {
  status: TestResultStatus;
  /** What the case cost (decimal string, USD). */
  costUsd: string;
  /** From `labelOutcome`; null when the case has no label field or got nothing. */
  label: {
    field: string;
    positive: LabelField["positive"];
    predicted: boolean;
    actual: boolean;
  } | null;
}

export interface LabelPrecision {
  field: string;
  positive: LabelField["positive"];
  /** Cases where the skill said the positive label and the case expected it. */
  truePositives: number;
  /** Cases where the skill said the positive label and the case expected something else. */
  falsePositives: number;
  /** truePositives / (truePositives + falsePositives); null when it never said it. */
  precision: number | null;
}

export interface SuiteMetrics {
  /** passed / total, 0 to 1. */
  passRate: number;
  /** Precision over every labelled case (all label fields together); absent when none. */
  precision?: number | null;
  /** By label field and positive value. */
  labels?: LabelPrecision[];
  /** Total cost / cases, USD, 6 places. */
  costPerCase: string;
}

export interface SuiteTotals {
  total: number;
  passed: number;
  /** Failed and errored cases. */
  failed: number;
  costUsd: string;
  metrics: SuiteMetrics;
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10_000) / 10_000);

/** A suite run's totals and metrics from its cases' outcomes. */
export function suiteTotals(outcomes: readonly CaseOutcome[]): SuiteTotals {
  const total = outcomes.length;
  const passed = outcomes.filter((o) => o.status === "pass").length;
  const cost = outcomes.reduce((sum, o) => sum.plus(o.costUsd || "0"), new Decimal(0));
  const byLabel = new Map<string, LabelPrecision>();
  for (const o of outcomes) {
    if (!o.label || o.status === "error" || !o.label.predicted) continue;
    const key = JSON.stringify([o.label.field, o.label.positive]);
    const entry = byLabel.get(key) ?? {
      field: o.label.field,
      positive: o.label.positive,
      truePositives: 0,
      falsePositives: 0,
      precision: null,
    };
    if (o.label.actual) entry.truePositives += 1;
    else entry.falsePositives += 1;
    byLabel.set(key, entry);
  }
  const labelled = outcomes.some((o) => o.label !== null);
  const labels = [...byLabel.values()].map((l) => ({
    ...l,
    precision: ratio(l.truePositives, l.truePositives + l.falsePositives),
  }));
  const tp = labels.reduce((n, l) => n + l.truePositives, 0);
  const fp = labels.reduce((n, l) => n + l.falsePositives, 0);
  const metrics: SuiteMetrics = {
    passRate: ratio(passed, total),
    costPerCase: total === 0 ? "0.000000" : cost.div(total).toFixed(6),
    ...(labelled ? { precision: tp + fp === 0 ? null : ratio(tp, tp + fp), labels } : {}),
  };
  return { total, passed, failed: total - passed, costUsd: cost.toFixed(6), metrics };
}

/**
 * Whether a suite run lets a version publish: every required case passed in it. `results` are the
 * run's results by case id; `required` the case ids required now.
 */
export function gatePasses(
  required: readonly string[],
  results: ReadonlyMap<string, TestResultStatus>,
): { pass: boolean; failing: string[] } {
  const failing = required.filter((id) => results.get(id) !== "pass");
  return { pass: failing.length === 0, failing };
}
