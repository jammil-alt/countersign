// What ran, as rows (ARCHITECTURE §5.3, §13): runs, step runs with cost and tokens written as each
// model call returns, and tool calls. Each write is one short client-scoped transaction.

import { Decimal, readApproverRuleSet, redactCardNumbersDeep } from "@countersign/core";
import {
  agent,
  type Db,
  run,
  stepRun,
  type Tx,
  tenant,
  toolCall,
  withTenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { RunLog } from "../runtime/ports";
import type { RunMode } from "../tools/types";
import { closeRunApprovalsTx } from "./external-actions";
import { keepSubjects, triggerSubjectIds, writeTriggerSubjectsTx } from "./run-subjects";
import { rollupUsageForRun } from "./usage";

type RunStatus = (typeof run.$inferSelect)["status"];

export interface CreateRunInput {
  tenantId: string;
  agentId: string;
  /** The version the run is pinned to; defaults to the agent's live version. */
  agentVersionId?: string;
  workflowSlug: string;
  mode: RunMode;
  trigger?: Record<string, unknown>;
  /** A deterministic id for triggered runs (core's eventRunId / scheduleRunId). */
  id?: string;
}

/**
 * Creates a run of a client agent, pinned to a version, with a snapshot of its bindings and
 * approver, and the client's approver rules as they stood (ARCHITECTURE §9.3 "Runs and evidence";
 * docs/plan.md §1.20). Starting the same id twice returns the first.
 */
export async function createRun(tx: Tx, input: CreateRunInput): Promise<typeof run.$inferSelect> {
  if (input.id) {
    const [existing] = await tx.select().from(run).where(eq(run.id, input.id));
    if (existing) return existing;
  }
  const [a] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, input.agentId), eq(agent.tenantId, input.tenantId)));
  if (!a) throw notFound(`client agent ${input.agentId}`);
  // Test runs work on any client agent (that is how one becomes active); live runs need it active,
  // so a paused or retired agent starts nothing whoever asks (ARCHITECTURE §10.3).
  if (input.mode === "live" && a.runStatus !== "active") {
    throw new AgentsError(
      "invalid_state",
      `${a.slug} is ${a.runStatus ?? "not active"}: no live runs`,
    );
  }
  const versionId = input.agentVersionId ?? a.liveVersionId;
  if (!versionId) throw notFound(`a live version of ${a.slug}`);
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  // DECISION: the run keeps the rules it started under (revision and rules). Each approval is still
  // routed by the rules at the moment it is proposed, so a client's tightening applies at once,
  // and records what routed it (`approverRoute` in its payload).
  const approverRules = readApproverRuleSet(t?.settings ?? {});
  const [row] = await tx
    .insert(run)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: input.tenantId,
      agentId: a.id,
      agentVersionId: versionId,
      workflowSlug: input.workflowSlug,
      // Setup-plan §4.1: who sat in each seat when the run started (`agent.people`), so every
      // approval and question of the run goes to the same people, however the seats change after.
      config: { bindings: a.bindings, approver: a.approver, approverRules, people: a.people },
      mode: input.mode,
      trigger: input.trigger ?? {},
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("run insert returned nothing");
  // docs/plan.md §1.188: what started the run (its document or message) is its first subject,
  // kept in a savepoint so it never stops the run starting.
  const named = triggerSubjectIds(row.trigger);
  if (named.documentId || named.messageId) {
    await keepSubjects(tx, (sp) =>
      writeTriggerSubjectsTx(sp, {
        tenantId: input.tenantId,
        runId: row.id,
        trigger: row.trigger,
        mode: row.mode,
      }),
    );
  }
  return row;
}

/**
 * Records the run's status. Returns whether this call ended it: the run was not yet succeeded,
 * failed or cancelled and now is (audit 4.5: a finish step retried after it committed ends
 * nothing, so its events are emitted once). An ended run is never ended again. The call that ends
 * it also closes its approvals (audit 3.3, `closeRunApprovalsTx`): nobody signs for a run that is
 * over.
 */
export async function finishRun(
  tx: Tx,
  input: { tenantId: string; runId: string; status: RunStatus; error?: unknown },
): Promise<boolean> {
  const isTerminal = (status: string) => ["succeeded", "failed", "cancelled"].includes(status);
  const terminal = isTerminal(input.status);
  // Locked, so of two finishes at once only one reads the run as still open.
  const [before] = await tx
    .select({ status: run.status })
    .from(run)
    .where(and(eq(run.id, input.runId), eq(run.tenantId, input.tenantId)))
    .for("update");
  if (!before) return false;
  // Follow-up 8: a run already ended (cancelled, or failed by the reconciler) keeps its end; a
  // finish landing after it changes nothing, as the reconciler's `failOpenRun` changes only an
  // open run.
  if (terminal && isTerminal(before.status)) return false;
  await tx
    .update(run)
    .set({
      status: input.status,
      ...(terminal ? { finishedAt: new Date() } : {}),
      ...(input.error === undefined ? {} : { error: input.error as Record<string, unknown> }),
    })
    .where(and(eq(run.id, input.runId), eq(run.tenantId, input.tenantId)));
  const ended = terminal && !isTerminal(before.status);
  if (ended) {
    await closeRunApprovalsTx(tx, input.tenantId, input.runId, {
      code: "run_ended",
      message: `the run ${input.status === "succeeded" ? "finished" : input.status} before this change was signed`,
    });
  }
  return ended;
}

/** `run.workflow_slug` of an ask's test run (`agents.ask`): it runs no workflow. */
export const ASK_RUN_WORKFLOW = "agents.ask";

export function dbRunLog(db: Db): RunLog {
  return {
    startAskRun(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        // DECISION: an ask is recorded as the asked agent's own test run (ARCHITECTURE §10.4), so
        // the operator sees it with its steps and cost like any test; it never reaches the portal.
        const row = await createRun(tx, {
          tenantId,
          agentId: input.agentId,
          agentVersionId: input.agentVersionId,
          workflowSlug: ASK_RUN_WORKFLOW,
          mode: "test",
          trigger: {
            type: "ask",
            askedBy: { agentId: input.askedBy.agentId, runId: input.askedBy.runId },
          },
        });
        return row.id;
      });
    },
    finishAskRun(tenantId, runId, result) {
      return withTenant(db, tenantId, async (tx) => {
        await finishRun(tx, {
          tenantId,
          runId,
          status: result.status,
          ...(result.error ? { error: { reason: result.error, nodeId: "ask" } } : {}),
        });
        await rollupUsageForRun(tx, { tenantId, runId });
      });
    },
    startStepRun(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(stepRun)
          .values({
            tenantId,
            runId: input.runId,
            nodeId: input.nodeId,
            nodeType: input.nodeType,
            skillRef: input.skillRef,
            agentVersionId: input.agentVersionId,
            input: input.input as Record<string, unknown>,
            status: "running",
            attempts: 1,
            startedAt: new Date(),
          })
          // One row per (run, node): a retry gets the row its first attempt wrote.
          .onConflictDoUpdate({
            target: [stepRun.runId, stepRun.nodeId],
            set: { nodeId: sql`excluded.node_id` },
          })
          .returning({ id: stepRun.id });
        if (!row) throw new Error("step_run upsert returned nothing");
        return row.id;
      });
    },

    finishStepRun(tenantId, stepRunId, result) {
      // step_run has no error column: an error is kept in the output, next to any partial output.
      const output =
        result.error === undefined
          ? (result.output ?? null)
          : {
              ...(result.output !== null && typeof result.output === "object"
                ? (result.output as Record<string, unknown>)
                : result.output === undefined
                  ? {}
                  : { value: result.output }),
              error: result.error,
            };
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .update(stepRun)
          .set({
            status: result.status,
            output: output as Record<string, unknown> | null,
            ...(result.summary === undefined ? {} : { summary: result.summary }),
            ...(result.status === "waiting" || result.status === "running"
              ? {}
              : { finishedAt: new Date() }),
          })
          .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, tenantId)));
      });
    },

    addUsage(tenantId, ids, usage) {
      // The step's and run's cost are numeric(14,4), but a call's cost has 6 places: added as is,
      // each addition rounds to the nearest ten-thousandth, so a call under $0.00005 (a short
      // Haiku call) added nothing and a run of them read $0.00. Each call is rounded up to a
      // ten-thousandth first, as its model_call row is, so the run is the sum of its calls.
      // DECISION: round up per call, matching model_call, rather than widen the columns.
      const cost = new Decimal(usage.costUsd).toDecimalPlaces(4, Decimal.ROUND_UP).toFixed(4);
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .update(stepRun)
          .set({
            costUsd: sql`${stepRun.costUsd} + ${cost}::numeric`,
            tokensIn: sql`${stepRun.tokensIn} + ${usage.tokensIn}`,
            tokensOut: sql`${stepRun.tokensOut} + ${usage.tokensOut}`,
          })
          .where(and(eq(stepRun.id, ids.stepRunId), eq(stepRun.tenantId, tenantId)));
        await tx
          .update(run)
          .set({ costUsd: sql`${run.costUsd} + ${cost}::numeric` })
          .where(and(eq(run.id, ids.runId), eq(run.tenantId, tenantId)));
      });
    },

    startToolCall(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .insert(toolCall)
          .values({
            tenantId,
            stepRunId: input.stepRunId,
            tool: input.tool,
            // Card numbers are never stored (invariant 14): a call's input and output are its log,
            // never read back to run anything, so they keep `[card ending 1234]` (SEC-9).
            input: redactCardNumbersDeep(input.input) as Record<string, unknown>,
            status: "running",
          })
          .returning({ id: toolCall.id });
        if (!row) throw new Error("tool_call insert returned nothing");
        return row.id;
      });
    },

    finishToolCall(tenantId, toolCallId, result) {
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .update(toolCall)
          .set({
            status: result.status,
            output: redactCardNumbersDeep(result.output ?? null) as Record<string, unknown> | null,
            durationMs: result.durationMs,
            externalActionId: result.externalActionId ?? null,
          })
          .where(and(eq(toolCall.id, toolCallId), eq(toolCall.tenantId, tenantId)));
      });
    },
  };
}
