// builder-plan.md B1: trying a draft on one real example. A try is a test case marked by its
// source ref (`try:<build id>`) until the operator keeps it (`kept:<build id>`, required) or
// discards it (archived); it runs alone, as a suite run of some cases ("partial"). A partial run
// is marked in its metrics and never counts as a version's latest run for a gate.

import { testCase, testSuiteRun } from "@countersign/db";
import { sql } from "drizzle-orm";

/** A suite run of every case in its scope: the only kind a gate, the lab or a build's results read. */
export const fullSuiteRun = () =>
  sql`coalesce(${testSuiteRun.metrics}->>'partial', 'false') <> 'true'`;

/** A suite run of some cases. */
export const partialSuiteRun = () => sql`(${testSuiteRun.metrics}->>'partial') = 'true'`;

/** What a partial run's metrics hold besides the totals: the cases it ran. */
export function partialMarks(caseIds: readonly string[]): { partial: true; caseIds: string[] } {
  return { partial: true, caseIds: [...caseIds] };
}

/** The cases a partial run ran (none for a full run). */
export function partialCaseIds(metrics: unknown): string[] {
  const m = metrics as { partial?: unknown; caseIds?: unknown } | null;
  if (m?.partial !== true || !Array.isArray(m.caseIds)) return [];
  return m.caseIds.filter((x): x is string => typeof x === "string");
}

export const tryRef = (buildId: string) => `try:${buildId}`;
export const keptRef = (buildId: string) => `kept:${buildId}`;

/** A case that isn't a try waiting to be kept: what a full run, a count or a gate reads. */
export const notPendingTry = () => sql`coalesce(${testCase.sourceRef}, '') not like 'try:%'`;

export const isPendingTry = (sourceRef: string | null) => !!sourceRef?.startsWith("try:");

/** How long one case may run (TestSuiteWorkflow's step timeout, testbench/workflow.ts). */
export const CASE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * INTEG-2: a suite run still `running` after every case's step would have timed out (and a
 * minute more) never finishes: its job didn't start, or died. It is read as finished, unscored.
 */
export function staleRun(
  run: { status: string; createdAt: Date },
  cases: number,
  now: Date = new Date(),
): boolean {
  return (
    run.status === "running" &&
    now.getTime() - run.createdAt.getTime() > Math.max(1, cases) * CASE_TIMEOUT_MS + 60_000
  );
}
