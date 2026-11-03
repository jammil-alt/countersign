// What ran, as rows (ARCHITECTURE §5.3, §13): runs, step runs with cost and tokens written as each
// model call returns, and tool calls. Each write is one short client-scoped transaction.

import { agent, type Db, run, stepRun, type Tx, toolCall, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";
import type { RunLog } from "../runtime/ports";
import type { RunMode } from "../tools/types";

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
 * approver (ARCHITECTURE §9.3 "Runs and evidence"). Starting the same id twice returns the first.
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
  const [row] = await tx
    .insert(run)
    .values({
      ...(input.id ? { id: input.id } : {}),
      tenantId: input.tenantId,
      agentId: a.id,
      agentVersionId: versionId,
      workflowSlug: input.workflowSlug,
      config: { bindings: a.bindings, approver: a.approver },
      mode: input.mode,
      trigger: input.trigger ?? {},
      status: "running",
      startedAt: new Date(),
    })
    .returning();
  if (!row) throw new Error("run insert returned nothing");
  return row;
}

export async function finishRun(
  tx: Tx,
  input: { tenantId: string; runId: string; status: RunStatus; error?: unknown },
): Promise<void> {
  const terminal = ["succeeded", "failed", "cancelled"].includes(input.status);
  await tx
    .update(run)
    .set({
      status: input.status,
      ...(terminal ? { finishedAt: new Date() } : {}),
      ...(input.error === undefined ? {} : { error: input.error as Record<string, unknown> }),
    })
    .where(and(eq(run.id, input.runId), eq(run.tenantId, input.tenantId)));
}

export function dbRunLog(db: Db): RunLog {
  return {
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
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .update(stepRun)
          .set({
            costUsd: sql`${stepRun.costUsd} + ${usage.costUsd}::numeric`,
            tokensIn: sql`${stepRun.tokensIn} + ${usage.tokensIn}`,
            tokensOut: sql`${stepRun.tokensOut} + ${usage.tokensOut}`,
          })
          .where(and(eq(stepRun.id, ids.stepRunId), eq(stepRun.tenantId, tenantId)));
        await tx
          .update(run)
          .set({ costUsd: sql`${run.costUsd} + ${usage.costUsd}::numeric` })
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
            input: input.input as Record<string, unknown>,
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
            output: (result.output ?? null) as Record<string, unknown> | null,
            durationMs: result.durationMs,
            externalActionId: result.externalActionId ?? null,
          })
          .where(and(eq(toolCall.id, toolCallId), eq(toolCall.tenantId, tenantId)));
      });
    },
  };
}
