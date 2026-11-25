// v0.12 W2-C: the skill publish gate (ARCHITECTURE §9.10, docs/plan.md §1.46). A skill with
// `require_tests` publishes a version only when the latest finished suite run of that exact
// version, in the skill's own scope, passed every required case. A shared skill is gated on shared
// cases only; a client's cases never count for it (invariant 1).

import { gatePasses, type SkillDefinition } from "@countersign/core";
import {
  type skill,
  skillVersion,
  type Tx,
  testCase,
  testCaseResult,
  testSuiteRun,
} from "@countersign/db";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { HttpError } from "../http";
import { fullSuiteRun, notPendingTry } from "./partial";

type SkillRow = typeof skill.$inferSelect;

export interface GateVerdict {
  pass: boolean;
  /** The suite run looked at; null when the version has none. */
  suiteRunId: string | null;
  /** Required case ids without a pass in it. */
  failing: string[];
}

export async function skillGate(
  tx: Tx,
  row: SkillRow,
  versionId: string,
  /** A Loop skill: every kept case is required, not only those marked so. */
  every = false,
): Promise<GateVerdict> {
  const scope = row.tenantId;
  const required = await tx
    .select({ id: testCase.id })
    .from(testCase)
    .where(
      and(
        eq(testCase.targetKind, "skill"),
        eq(testCase.targetId, row.id),
        every ? notPendingTry() : eq(testCase.required, true),
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
        // A run of some cases (a try) never opens or shuts the gate (builder-plan.md B1).
        fullSuiteRun(),
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

/**
 * Step model §8: a Loop skill can't be published until its test set passes in the lab. Unlike
 * `assertSkillTestsPass` it is not a switch: the skill's `require_tests` doesn't open it. The set
 * is every kept case in the skill's scope (at least one), and the latest full suite run of this
 * exact version must have passed all of them. A Loop reads and never writes, so the set is what
 * stands behind its judgment (invariant 9).
 */
export async function assertLoopTestsPass(tx: Tx, row: SkillRow, versionId: string): Promise<void> {
  if ((await caseCount(tx, row)) === 0) {
    throw new HttpError(422, "tests_failing", "a Loop needs a test set: add at least one case", {
      suiteRunId: null,
      failing: [],
    });
  }
  const verdict = await skillGate(tx, row, versionId, true);
  if (verdict.pass) return;
  throw new HttpError(
    422,
    "tests_failing",
    verdict.suiteRunId
      ? `${verdict.failing.length} test case(s) did not pass on this version`
      : "run the test set on this version before publishing it",
    { suiteRunId: verdict.suiteRunId, failing: verdict.failing },
  );
}

async function caseCount(tx: Tx, row: SkillRow): Promise<number> {
  const rows = await tx
    .select({ id: testCase.id })
    .from(testCase)
    .where(
      and(
        eq(testCase.targetKind, "skill"),
        eq(testCase.targetId, row.id),
        notPendingTry(),
        isNull(testCase.archivedAt),
        row.tenantId ? eq(testCase.tenantId, row.tenantId) : isNull(testCase.tenantId),
      ),
    );
  return rows.length;
}

/** Whether a stored skill definition is a Loop skill (§8). */
export const isLoopSkill = (def: unknown): boolean =>
  typeof def === "object" && def !== null && (def as Partial<SkillDefinition>).loop !== undefined;

/** Whether any version of the skill is a Loop (a skill that was one stays gated). */
export async function hasLoopVersion(tx: Tx, skillId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: skillVersion.id })
    .from(skillVersion)
    .where(
      and(eq(skillVersion.skillId, skillId), sql`${skillVersion.definition} -> 'loop' is not null`),
    )
    .limit(1);
  return rows.length > 0;
}
