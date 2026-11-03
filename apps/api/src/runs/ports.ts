// The executor's ports (packages/workflows) over the database and the agents runtime: step_run rows,
// skill and action steps through runAgent / callTool (the permission gate, external actions),
// person steps' inbox items, and notify steps as thread messages. Every method is one short
// withTenant() transaction for the run's own client (invariant 1).

import {
  callTool,
  executeAction,
  type RuntimeDeps,
  resolveApprover,
  runAgent,
  type StepContext,
} from "@countersign/agents";
import { isPlainObject, type JsonObject } from "@countersign/core";
import { type Db, inboxItem, stepRun, withTenant } from "@countersign/db";
import type {
  AgentPort,
  InboxPort,
  NotifyPort,
  RunInfo,
  StepLog,
  StepOutcome,
} from "@countersign/workflows";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { toRunResolution } from "../inbox";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "cancelled"]);

/** `step_run` rows for one run. `start` returns the existing row for a node on a retry. */
export function dbStepLog(db: Db, run: RunInfo): StepLog {
  return {
    start(entry) {
      return withTenant(db, run.tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: stepRun.id })
          .from(stepRun)
          .where(
            and(
              eq(stepRun.tenantId, run.tenantId),
              eq(stepRun.runId, run.id),
              eq(stepRun.nodeId, entry.nodeId),
            ),
          )
          .limit(1);
        if (existing) return existing.id;
        const [row] = await tx
          .insert(stepRun)
          .values({
            tenantId: run.tenantId,
            runId: run.id,
            nodeId: entry.nodeId,
            nodeType: entry.nodeType,
            skillRef: entry.skillRef ?? null,
            agentVersionId: run.agentVersionId,
            input: (entry.input ?? null) as Record<string, unknown> | null,
            status: "running",
            attempts: 1,
            startedAt: new Date(),
          })
          .returning({ id: stepRun.id });
        if (!row) throw new Error("step_run insert returned nothing");
        return row.id;
      });
    },
    update(stepRunId, u) {
      // Cost and tokens are not set here: runAgent adds each model call's usage as it returns.
      const output =
        u.error === undefined
          ? u.output
          : { ...(isPlainObject(u.output) ? u.output : {}), error: u.error };
      return withTenant(db, run.tenantId, async (tx) => {
        await tx
          .update(stepRun)
          .set({
            status: u.status,
            ...(output === undefined ? {} : { output: output as Record<string, unknown> | null }),
            ...(u.summary === undefined ? {} : { summary: u.summary }),
            ...(TERMINAL.has(u.status) ? { finishedAt: new Date() } : {}),
          })
          .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, run.tenantId)));
      });
    },
  };
}

/** What a step waiting on approvals carries between durable steps. Small: ids only. */
const PendingState = z.object({
  actions: z.array(z.object({ actionId: z.string(), inboxItemId: z.string().nullable() })),
  output: z.unknown().optional(),
});
type PendingState = z.infer<typeof PendingState>;

function firstWaiting(state: PendingState, after = -1): StepOutcome | null {
  const next = state.actions.slice(after + 1).find((a) => a.inboxItemId);
  return next?.inboxItemId
    ? { kind: "approval", pending: { inboxItemId: next.inboxItemId, state } }
    : null;
}

/** Skill and action steps through packages/agents: the gate, external actions, approvals. */
export function agentPort(deps: RuntimeDeps): AgentPort {
  return {
    async runSkill({ run, step, nodeId, stepRunId, input, approval }) {
      const r = await runAgent(deps, {
        tenantId: run.tenantId,
        agentVersionId: run.agentVersionId,
        skill: step.skill,
        input,
        ...(step.settings ? { settings: step.settings } : {}),
        runId: run.id,
        // The durable name, so each for_each iteration keys its own external actions.
        stepId: nodeId,
        stepRunId,
        approval,
        mode: run.mode,
      });
      switch (r.status) {
        case "succeeded":
          return {
            kind: "done",
            output: r.output,
            costUsd: r.costUsd,
            tokensIn: r.tokensIn,
            tokensOut: r.tokensOut,
          };
        case "awaiting_approval": {
          const state: PendingState = {
            actions: r.pendingActions
              .filter((p) => p.status === "awaiting_approval")
              .map((p) => ({ actionId: p.actionId, inboxItemId: p.inboxItemId })),
            output: r.output,
          };
          return (
            firstWaiting(state) ?? { kind: "failed", error: "a change waits with no approval card" }
          );
        }
        case "escalated":
          return { kind: "escalated", reason: r.reason, inboxItemId: r.inboxItemId };
        case "failed":
          return { kind: "failed", error: r.error };
      }
    },

    async runAction({ run, step, nodeId, stepRunId, input, approval }) {
      const agent = await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId);
      const ctx: StepContext = {
        tenantId: run.tenantId,
        agent,
        runId: run.id,
        stepRunId,
        stepId: nodeId,
        mode: run.mode,
        approval,
        externalIndex: { next: 0 },
      };
      const o = await callTool(deps, ctx, { toolId: step.tool, input });
      switch (o.status) {
        case "done":
          return { kind: "done", output: o.output };
        case "would_have_done":
          // A test run: recorded as proposed, never executed (ARCHITECTURE §10.4).
          return {
            kind: "done",
            output: { wouldHaveDone: true, actionId: o.actionId, before: o.before ?? null },
          };
        case "awaiting_approval":
          return (
            firstWaiting({
              actions: [{ actionId: o.actionId, inboxItemId: o.inboxItemId }],
              output: null,
            }) ?? { kind: "failed", error: "a change waits with no approval card" }
          );
        case "refused":
          return { kind: "failed", error: `refused: ${o.reason}` };
        case "failed":
          return { kind: "failed", error: o.error };
      }
    },

    async resume({ run, step, pending, resolution }) {
      const state = PendingState.parse(pending.state ?? { actions: [] });
      const index = state.actions.findIndex((a) => a.inboxItemId === pending.inboxItemId);
      const current = state.actions[index];
      if (current && resolution.approved === true) {
        // Executed once by its idempotency key, in this durable step (docs/plan.md §1.2).
        const r = await executeAction(deps, { tenantId: run.tenantId, actionId: current.actionId });
        if (r.status === "failed") return { kind: "failed", error: r.error };
        if (r.status === "awaiting_approval") {
          return { kind: "failed", error: "the approval was not recorded on the change" };
        }
        if (r.status === "done" && step.kind === "action") state.output = r.output;
      }
      return firstWaiting(state, index) ?? { kind: "done", output: state.output ?? null };
    },
  };
}

/** Person steps' inbox items. */
export function dbInboxPort(db: Db, run: RunInfo): InboxPort {
  return {
    createForPerson(item) {
      return withTenant(db, run.tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: inboxItem.id })
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, run.tenantId),
              eq(inboxItem.runId, run.id),
              sql`${inboxItem.payload}->>'nodeId' = ${item.nodeId}`,
            ),
          )
          .limit(1);
        if (existing) return existing;
        // DECISION: a test run's person steps go to the operator, never to the client: test runs
        // are hidden from the portal (ARCHITECTURE §10.4).
        const assignee =
          run.mode === "test"
            ? { assigneeRole: "operator" as const, assigneeUserId: null }
            : resolveApprover([item.step.assignee]);
        const payload = {
          ...(isPlainObject(item.payload) ? (item.payload as JsonObject) : { value: item.payload }),
          nodeId: item.nodeId,
          mode: item.step.mode,
          ...(run.mode === "test" ? { testRun: true } : {}),
        };
        const [row] = await tx
          .insert(inboxItem)
          .values({
            tenantId: run.tenantId,
            kind: item.kind,
            agentId: run.agentId,
            subjectType: "run",
            subjectId: run.id,
            runId: run.id,
            ...assignee,
            title: item.title,
            payload,
            dueAt: new Date(item.dueAt),
          })
          .returning({ id: inboxItem.id });
        if (!row) throw new Error("inbox item insert returned nothing");
        return row;
      });
    },
    resolution(inboxItemId) {
      return withTenant(db, run.tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(inboxItem)
          .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, run.tenantId)));
        return row?.status === "resolved" ? toRunResolution(row) : null;
      });
    },
    async expire(inboxItemId) {
      await withTenant(db, run.tenantId, (tx) =>
        tx
          .update(inboxItem)
          .set({ status: "expired" })
          .where(
            and(
              eq(inboxItem.id, inboxItemId),
              eq(inboxItem.tenantId, run.tenantId),
              eq(inboxItem.status, "open"),
            ),
          ),
      );
    },
  };
}

/**
 * Notify steps. v1 has no email provider wired, so every channel posts to the run's thread.
 */
// DECISION: until Resend is configured, `email` and `digest` notices are thread messages for the
// operator; only `thread` notices of live runs are client-facing. Test runs never message clients.
export function threadNotifyPort(deps: RuntimeDeps): NotifyPort {
  const { platform } = deps.ports;
  return {
    async send({ run, nodeId, channel, to, text }) {
      await platform.postMessage(run.tenantId, {
        subject: { type: "run", id: run.id, title: `Run of ${run.workflowSlug}` },
        agentVersionId: run.agentVersionId,
        body: { text, channel, to, nodeId },
        sources: [],
        audience: run.mode === "live" && channel === "thread" ? "client" : "operator",
      });
    },
    async notifyOperator({ run, nodeId, inboxItemId, reason }) {
      await platform.createInboxItem(run.tenantId, {
        kind: "review",
        title: reason,
        payload: { nodeId, inboxItemId, reason, ...(run.mode === "test" ? { testRun: true } : {}) },
        agentId: run.agentId,
        runId: run.id,
        assigneeRole: "operator",
      });
    },
  };
}
