// builder-plan.md B1: the examples an operator tried in a build's POC test, as the build page
// shows them. A try is a shared test case marked `try:<build id>` (testbench/partial.ts) that runs
// alone as a partial suite run; what it got is what the agent would do. Read live, like the rest of
// the phase's work.

import { BUILD_TRIES_SHOWN, type BuildTryView, type TestTargetKind } from "@countersign/core";
import { type Tx, tenant, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { iso } from "../http";
import { partialCaseIds, partialSuiteRun, staleRun, tryRef } from "../testbench/partial";
import { failureWhy } from "./why";

/** Partial runs looked at for a build's tries. */
const RUNS_READ = 50;

/** The build's tries not kept or discarded yet, newest first, each with its latest result. */
export async function tryViews(
  tx: Tx,
  target: { kind: TestTargetKind; id: string },
  buildId: string,
  versionId: string | null,
  /** One try only, shown or not. */
  only?: string,
): Promise<BuildTryView[]> {
  const cases = await tx
    .select({ id: testCase.id, name: testCase.name, createdAt: testCase.createdAt })
    .from(testCase)
    .where(
      and(
        eq(testCase.targetKind, target.kind),
        eq(testCase.targetId, target.id),
        eq(testCase.sourceRef, tryRef(buildId)),
        isNull(testCase.tenantId),
        isNull(testCase.archivedAt),
        only ? eq(testCase.id, only) : undefined,
      ),
    )
    .orderBy(desc(testCase.createdAt), desc(testCase.id))
    .limit(BUILD_TRIES_SHOWN);
  if (cases.length === 0) return [];
  const runs = await tx
    .select({
      id: testSuiteRun.id,
      status: testSuiteRun.status,
      versionId: testSuiteRun.versionId,
      metrics: testSuiteRun.metrics,
      createdAt: testSuiteRun.createdAt,
    })
    .from(testSuiteRun)
    .where(
      and(
        eq(testSuiteRun.targetKind, target.kind),
        eq(testSuiteRun.targetId, target.id),
        isNull(testSuiteRun.tenantId),
        partialSuiteRun(),
      ),
    )
    .orderBy(desc(testSuiteRun.createdAt), desc(testSuiteRun.id))
    .limit(RUNS_READ);
  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    for (const caseId of partialCaseIds(r.metrics)) {
      if (!latestRun.has(caseId)) latestRun.set(caseId, r);
    }
  }
  const runIds = [...new Set([...latestRun.values()].map((r) => r.id))];
  const results = runIds.length
    ? await tx
        .select({
          suiteRunId: testCaseResult.suiteRunId,
          caseId: testCaseResult.testCaseId,
          status: testCaseResult.status,
          got: testCaseResult.got,
          diff: testCaseResult.diff,
          runId: testCaseResult.runId,
          createdAt: testCaseResult.createdAt,
        })
        .from(testCaseResult)
        .where(
          and(
            inArray(testCaseResult.suiteRunId, runIds),
            inArray(
              testCaseResult.testCaseId,
              cases.map((c) => c.id),
            ),
            isNull(testCaseResult.tenantId),
          ),
        )
    : [];
  return cases.map((c): BuildTryView => {
    const r = latestRun.get(c.id);
    const result = r ? results.find((x) => x.suiteRunId === r.id && x.caseId === c.id) : undefined;
    const base = {
      caseId: c.id,
      name: c.name,
      output: null,
      runId: null,
      current: !!r && (versionId === null || r.versionId === versionId),
      at: iso(result?.createdAt ?? r?.createdAt ?? c.createdAt) as string,
    };
    if (result) {
      return result.status === "error"
        ? {
            ...base,
            status: "error",
            why: failureWhy(result.diff) ?? "It stopped with an error.",
            runId: result.runId,
          }
        : { ...base, status: "done", output: result.got, why: null, runId: result.runId };
    }
    // INTEG-2: a run past its case's timeout never finishes; it is shown stopped, to try again.
    if (r?.status === "running" && !staleRun(r, 1))
      return { ...base, status: "running", why: null };
    return {
      ...base,
      status: "error",
      why: r ? "The test didn't finish: try it again." : "It hasn't run yet: try it again.",
    };
  });
}

/** The Sandbox client a template's try document goes to: the one its shared tests run in. */
// DECISION (builder-plan.md B1): the earliest Sandbox the operator serves, as the test bench picks
// it for a shared template case (routes/testbench.ts `sandboxClient`), so the document and the run
// are in the same client.
export async function trySandbox(tx: Tx): Promise<{ id: string; name: string } | null> {
  const [row] = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(
      and(
        sql`${tenant.id} = any(app_tenant_ids())`,
        sql`(${tenant.settings}->>'sandbox')::boolean`,
      ),
    )
    .orderBy(asc(tenant.createdAt))
    .limit(1);
  return row ?? null;
}

/** When the latest run of one try started: what its result is told apart from (build/kept.ts). */
export async function tryStartedAt(
  tx: Tx,
  target: { kind: TestTargetKind; id: string },
  caseId: string,
): Promise<Date | null> {
  const runs = await tx
    .select({ metrics: testSuiteRun.metrics, createdAt: testSuiteRun.createdAt })
    .from(testSuiteRun)
    .where(
      and(
        eq(testSuiteRun.targetKind, target.kind),
        eq(testSuiteRun.targetId, target.id),
        isNull(testSuiteRun.tenantId),
        partialSuiteRun(),
      ),
    )
    .orderBy(desc(testSuiteRun.createdAt), desc(testSuiteRun.id))
    .limit(RUNS_READ);
  return runs.find((r) => partialCaseIds(r.metrics).includes(caseId))?.createdAt ?? null;
}
