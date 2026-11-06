// v0.12 W2-C: the skill publish gate (ARCHITECTURE §9.10, docs/plan.md §1.46). A skill with
// `require_tests` publishes a version only when the latest finished suite run of that exact
// version, in the skill's own scope, passed every required case. A shared skill is gated on shared
// cases only; a client's cases never count for it (invariant 1).

import { gatePasses } from "@countersign/core";
import { type skill, type Tx, testCase, testCaseResult, testSuiteRun } from "@countersign/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { HttpError } from "../http";

type SkillRow = typeof skill.$inferSelect;

export interface GateVerdict {
  pass: boolean;
  /** The suite run looked at; null when the version has none. */
  suiteRunId: string | null;
  /** Required case ids without a pass in it. */
  failing: string[];
}

export async function skillGate(tx: Tx, row: SkillRow, versionId: string): Promise<GateVerdict> {
  const scope = row.tenantId;
  const required = await tx
    .select({ id: testCase.id })
    .from(testCase)
    .where(
      and(
        eq(testCase.targetKind, "skill"),
        eq(testCase.targetId, row.id),
        eq(testCase.required, true),
        isNull(testCase.archivedAt),
        scope ? eq(testCase.tenantId, scope) : isNull(testCase.tenantId),
      ),
    );
  // DECISION: "the latest suite run" is the latest finished one (done or failed); a suite still
  // running neither opens nor shuts the gate.
  const [latest] = await tx
    .select({ id: testSuiteRun.id })
    .from(testSuiteRun)
    .where(
      and(
        eq(testSuiteRun.targetKind, "skill"),
        eq(testSuiteRun.targetId, row.id),
        eq(testSuiteRun.versionId, versionId),
        ne(testSuiteRun.status, "running"),
        scope ? eq(testSuiteRun.tenantId, scope) : isNull(testSuiteRun.tenantId),
      ),
    )
    .orderBy(desc(testSuiteRun.createdAt), desc(testSuiteRun.id))
    .limit(1);
  const ids = required.map((r) => r.id);
  // DECISION: with the requirement on, a version needs a finished suite run even when no case is
  // marked required: "tested" means the bench ran on that version.
  if (!latest) return { pass: false, suiteRunId: null, failing: ids };
  const results = await tx
    .select({ caseId: testCaseResult.testCaseId, status: testCaseResult.status })
    .from(testCaseResult)
    .where(
      and(
        eq(testCaseResult.suiteRunId, latest.id),
        scope ? eq(testCaseResult.tenantId, scope) : isNull(testCaseResult.tenantId),
      ),
    );
  const verdict = gatePasses(ids, new Map(results.map((r) => [r.caseId, r.status])));
  return { ...verdict, suiteRunId: latest.id };
}

/** Refuses the publish with 422 `tests_failing` unless the gate is off or passes. */
export async function assertSkillTestsPass(
  tx: Tx,
  row: SkillRow,
  versionId: string,
): Promise<void> {
  if (!row.requireTests) return;
  const verdict = await skillGate(tx, row, versionId);
  if (verdict.pass) return;
  throw new HttpError(
    422,
    "tests_failing",
    verdict.suiteRunId
      ? `${verdict.failing.length} required test case(s) did not pass on this version`
      : "run the tests on this version before publishing it",
    { suiteRunId: verdict.suiteRunId, failing: verdict.failing },
  );
}
