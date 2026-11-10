// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the run audit's rows. The owner's check on each
// attempt at a v4 step (the executor's `OwnerCheckLog`), a finished run queued for a person's audit
// by its client's rule, and a reviewer's marks. All insert only; back office only (invariant 11).

import {
  AppliedAuditRule,
  type AuditMarkView,
  actionWrote,
  chooseForAudit,
  effectiveAuditRule,
  type OwnerCheckEntry,
  type OwnerCheckView,
  ownerCheckWords,
  type RunAuditState,
  runAuditSettingsOf,
  signalsOf,
} from "@countersign/core";
import {
  appUser,
  type Db,
  externalAction,
  oversightDecision,
  ownerCheck,
  type run,
  runAudit,
  runAuditMark,
  stepRun,
  type Tx,
  tenant,
  toolCall,
  withTenant,
} from "@countersign/db";
import type { OwnerCheckLog, RunInfo } from "@countersign/workflows";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { reportHandled } from "../observability/report";

// ── The owner's check ───────────────────────────────────────────────────────────────────────────

/**
 * The executor's `OwnerCheckLog` on the run's client: one row per run, node and attempt (a repeat
 * is a no-op), with the decision a review recorded for the same run, node and seq. A loop's checks
 * come at once (`recordMany`), in one transaction and one insert.
 */
export function dbOwnerCheckLog(db: Db, info: RunInfo): OwnerCheckLog {
  const recordMany = (entries: readonly OwnerCheckEntry[]) =>
    withTenant(db, info.tenantId, async (tx) => {
      if (entries.length === 0) return;
      const reviewed = entries.filter((e) => e.result === "reviewed");
      const decisions = reviewed.length
        ? await tx
            .select({
              id: oversightDecision.id,
              runId: oversightDecision.runId,
              nodeId: oversightDecision.nodeId,
              seq: oversightDecision.seq,
            })
            .from(oversightDecision)
            .where(
              and(
                eq(oversightDecision.tenantId, info.tenantId),
                inArray(oversightDecision.runId, [...new Set(reviewed.map((e) => e.runId))]),
                inArray(oversightDecision.nodeId, [...new Set(reviewed.map((e) => e.nodeId))]),
              ),
            )
        : [];
      const decisionOf = (e: OwnerCheckEntry) =>
        e.result === "reviewed"
          ? (decisions.find(
              (d) => d.runId === e.runId && d.nodeId === e.nodeId && d.seq === e.attempt,
            )?.id ?? null)
          : null;
      await tx
        .insert(ownerCheck)
        .values(
          entries.map((entry) => ({
            tenantId: info.tenantId,
            runId: entry.runId,
            nodeId: entry.nodeId,
            attempt: entry.attempt,
            result: entry.result,
            attemptOutcome: entry.attemptOutcome,
            signals: [...entry.signals],
            reason: entry.reason ?? null,
            cause: entry.cause ?? null,
            verdict: entry.verdict ?? null,
            reviewDue: entry.reviewDue ?? null,
            decisionId: decisionOf(entry),
            agentVersionId: info.agentVersionId,
          })),
        )
        .onConflictDoNothing({
          target: [ownerCheck.runId, ownerCheck.nodeId, ownerCheck.attempt],
        });
    });
  return {
    record: (entry) => recordMany([entry]),
    recordMany,
  };
}

type CheckRow = typeof ownerCheck.$inferSelect;

export function ownerCheckView(row: CheckRow): OwnerCheckView {
  const signals = signalsOf(row.signals);
  const verdict = row.verdict as OwnerCheckView["verdict"];
  return {
    id: row.id,
    nodeId: row.nodeId,
    attempt: row.attempt,
    result: row.result,
    attemptOutcome: row.attemptOutcome,
    signals,
    reason: row.reason ?? null,
    cause: row.cause ?? null,
    verdict: verdict ?? null,
    reviewDue: row.reviewDue ?? null,
    decisionId: row.decisionId,
    words: ownerCheckWords({ ...row, signals, verdict }),
    createdAt: row.createdAt.toISOString(),
  };
}

/** A run's checks, by node then attempt. */
export async function runOwnerChecks(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<OwnerCheckView[]> {
  const rows = await tx
    .select()
    .from(ownerCheck)
    .where(and(eq(ownerCheck.tenantId, tenantId), eq(ownerCheck.runId, runId)))
    .orderBy(asc(ownerCheck.createdAt), asc(ownerCheck.nodeId), asc(ownerCheck.attempt));
  return rows.map(ownerCheckView);
}

// ── The queue ───────────────────────────────────────────────────────────────────────────────────

/**
 * When a live run finishes, in the transaction that finishes it (`run:finish`, or a cancel from
 * the back office): queue it for audit by its client's rule (the agent's override first). A run
 * that wrote is one with a change done in the client's tools, or one that may have been made
 * (`runWrote`). Idempotent (one row per run), and never fails the finish: a savepoint holds it,
 * and a failure is reported.
 */
// DECISION (wave 6): applied in `run:finish`'s own transaction, so a run is queued exactly when it
// is finished; the bucket is a hash of the run id (core `auditBucket`), so a replay agrees. A test
// run is never queued.
export async function queueFinishedRun(
  tx: Tx,
  info: Pick<RunInfo, "id" | "tenantId" | "agentId" | "mode">,
): Promise<void> {
  if (info.mode !== "live") return;
  try {
    await tx.transaction(async (sp) => {
      const [t] = await sp
        .select({ settings: tenant.settings })
        .from(tenant)
        .where(eq(tenant.id, info.tenantId));
      const { rule, source } = effectiveAuditRule(runAuditSettingsOf(t?.settings), info.agentId);
      const wrote = await runWrote(sp, info);
      const choice = chooseForAudit({ runId: info.id, wrote, rule, source });
      if (!choice.queued || !choice.reason) return;
      await sp
        .insert(runAudit)
        .values({
          tenantId: info.tenantId,
          runId: info.id,
          agentId: info.agentId,
          reason: choice.reason,
          rule: choice.applied,
        })
        .onConflictDoNothing({ target: runAudit.runId });
    });
  } catch (error) {
    reportHandled("run audit queue failed", error, { kind: "run_audit" });
  }
}

/**
 * Whether a run wrote to a client's tool, or may have: any of its external actions, or a carried
 * one its retry's tool calls name, done, executing, or failed after it reached the provider (core
 * `actionWrote`: a failure without the runtime's `notWritten` mark).
 */
// DECISION (wave 6 review): "wrote" is core's `actionWrote`, the rule `onError: continue` already
// goes by, not only `done`: a write that failed part-way may be in the client's books, and is
// exactly what a person should look at.
export async function runWrote(tx: Tx, info: Pick<RunInfo, "id" | "tenantId">): Promise<boolean> {
  const maybe = ["done", "executing", "failed"] as const;
  const own = await tx
    .select({ status: externalAction.status, error: externalAction.error })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, info.tenantId),
        eq(externalAction.runId, info.id),
        inArray(externalAction.status, [...maybe]),
      ),
    );
  if (own.some((a) => actionWrote(a))) return true;
  const carried = await tx
    .select({ status: externalAction.status, error: externalAction.error })
    .from(toolCall)
    .innerJoin(
      stepRun,
      and(eq(stepRun.id, toolCall.stepRunId), eq(stepRun.tenantId, toolCall.tenantId)),
    )
    .innerJoin(
      externalAction,
      and(
        eq(externalAction.id, toolCall.externalActionId),
        eq(externalAction.tenantId, toolCall.tenantId),
      ),
    )
    .where(
      and(
        eq(toolCall.tenantId, info.tenantId),
        eq(stepRun.runId, info.id),
        inArray(externalAction.status, [...maybe]),
      ),
    );
  return carried.some((a) => actionWrote(a));
}

/** Adds a run to the queue by hand (a reviewer marked one that wasn't queued). */
export async function queueByHand(
  tx: Tx,
  r: Pick<typeof run.$inferSelect, "id" | "tenantId" | "agentId">,
): Promise<void> {
  await tx
    .insert(runAudit)
    .values({ tenantId: r.tenantId, runId: r.id, agentId: r.agentId, reason: "by_hand", rule: {} })
    .onConflictDoNothing({ target: runAudit.runId });
}

// ── Marks ───────────────────────────────────────────────────────────────────────────────────────

type MarkRow = typeof runAuditMark.$inferSelect;

/** Marks with who made them, newest first. */
export async function marksOf(
  tx: Tx,
  tenantIds: readonly string[],
  runIds: readonly string[],
): Promise<AuditMarkView[]> {
  if (runIds.length === 0 || tenantIds.length === 0) return [];
  const rows = await tx
    .select({ mark: runAuditMark, name: appUser.name, email: appUser.email })
    .from(runAuditMark)
    .innerJoin(appUser, eq(appUser.id, runAuditMark.markedBy))
    .where(
      and(inArray(runAuditMark.tenantId, [...tenantIds]), inArray(runAuditMark.runId, [...runIds])),
    )
    .orderBy(desc(runAuditMark.createdAt), desc(runAuditMark.id));
  return rows.map((r) => markView(r.mark, { name: r.name, email: r.email }));
}

export function markView(row: MarkRow, by: { name: string | null; email: string }): AuditMarkView {
  return {
    id: row.id,
    runId: row.runId,
    verdict: row.verdict,
    note: row.note,
    markedBy: { id: row.markedBy, name: by.name, email: by.email },
    inboxItemId: row.inboxItemId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A run's place in the audit: queued (why, by which rule) and its marks, newest first. */
export async function runAuditState(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<RunAuditState> {
  const [q] = await tx
    .select()
    .from(runAudit)
    .where(and(eq(runAudit.tenantId, tenantId), eq(runAudit.runId, runId)));
  const marks = await marksOf(tx, [tenantId], [runId]);
  const rule = q ? AppliedAuditRule.safeParse(q.rule) : null;
  return {
    queued: q
      ? {
          reason: q.reason,
          rule: rule?.success ? rule.data : null,
          createdAt: q.createdAt.toISOString(),
        }
      : null,
    marks,
    latest: marks[0] ?? null,
  };
}
