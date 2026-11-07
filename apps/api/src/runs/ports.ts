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
import {
  DEFAULT_APPROVAL,
  isPlainObject,
  type JsonObject,
  LEAD_ASSIGNEE,
  parseSkillRef,
  REACH_OUT_SKILL,
} from "@countersign/core";
import { type Db, inboxItem, stepRun, withTenant } from "@countersign/db";
import { leadOf } from "@countersign/threads";
import type {
  AgentPort,
  InboxPort,
  NotifyPort,
  RunInfo,
  StepLog,
  StepOutcome,
} from "@countersign/workflows";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterReleaseWait,
  releaseWaitDone,
  releaseWaitOf,
  releaseWaitOutcome,
  stepInputOf,
} from "../access/release";
import { toRunResolution } from "../inbox";
import { type ReachPort, reachOutState } from "../reach/service";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "cancelled"]);

/**
 * `step_run` rows for one run. `start` is an upsert on (run_id, node_id): a retried step (or a
 * step's failure record) gets the row its first attempt wrote, never a second one.
 */
export function dbStepLog(db: Db, run: RunInfo): StepLog {
  return {
    start(entry) {
      return withTenant(db, run.tenantId, async (tx) => {
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
            attempts: entry.attempt ?? 1,
            startedAt: new Date(),
          })
          // A no-op update, so the existing row's id comes back (DO NOTHING returns no row).
          .onConflictDoUpdate({
            target: [stepRun.runId, stepRun.nodeId],
            set:
              entry.attempt !== undefined
                ? // v0.13 W2-I: an oversight retry keeps the step's one row: its attempts rise and
                  // it holds the input the attempt runs with (ARCHITECTURE §5.6). v0.14 W4-B:
                  // by one at least, so platform retries before it stay counted.
                  {
                    attempts: sql`greatest(${stepRun.attempts} + 1, excluded.attempts)`,
                    input: sql`excluded.input`,
                    status: "running",
                  }
                : entry.retried
                  ? // v0.14 W4-B: the platform retried the step's work: one more attempt.
                    { attempts: sql`${stepRun.attempts} + 1`, status: "running" }
                  : { nodeId: sql`excluded.node_id` },
          })
          .returning({ id: stepRun.id });
        if (!row) throw new Error("step_run upsert returned nothing");
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

/**
 * Skill and action steps through packages/agents: the gate, external actions, approvals. The
 * built-in `comms.reach-out` goes to the reach-out service, which plans, sends and waits.
 */
// DECISION: the reach-out is a built-in skill the API carries out (it needs contacts, waits and the
// cron), routed here by its id; without the service (no database) it fails rather than run as a
// plain tool.
export function agentPort(
  deps: RuntimeDeps,
  reach?: ReachPort,
  /** The database, for steps that wait on a person's release (docs/plan.md §1.26). */
  release?: { db: Db },
): AgentPort {
  const now = () => deps.now?.() ?? new Date();
  const port: AgentPort = {
    async runSkill(request) {
      const { run, step, nodeId, stepRunId, input, approval } = request;
      if (parseSkillRef(step.skill).id === REACH_OUT_SKILL) {
        if (!reach) return { kind: "failed", error: "comms.reach-out needs the reach-out service" };
        return reach.start(request);
      }
      const r = await runAgent(deps, {
        tenantId: run.tenantId,
        agentVersionId: run.agentVersionId,
        skill: step.skill,
        input,
        ...(step.settings ? { settings: step.settings } : {}),
        ...(step.model ? { model: step.model } : {}),
        runId: run.id,
        // The durable name, so each for_each iteration keys its own external actions; v0.13 W2-I:
        // an oversight retry with a corrected input keys its own (`${nodeId}:o${seq}`).
        stepId: request.keyNode ?? nodeId,
        stepRunId,
        approval,
        mode: run.mode,
        language: run.language,
        // v0.12 W1-E: a retry carries the run retried's approved, not-done writes (§10.10).
        ...(run.retryOf ? { retryOf: run.retryOf } : {}),
        // v0.12 W2-B: a step of an automation runs with the automation's skills.
        ...(request.automation ? { automation: request.automation } : {}),
      });
      switch (r.status) {
        case "succeeded":
          return {
            kind: "done",
            output: r.output,
            // A test run's skill that proposed writes: recorded, never made.
            ...(r.pendingActions.some((p) => p.status === "would_have_done")
              ? { notWritten: true }
              : {}),
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
        case "awaiting_release":
          return releaseWaitOutcome(r, null, now());
        case "escalated":
          return { kind: "escalated", reason: r.reason, inboxItemId: r.inboxItemId };
        case "failed":
          return { kind: "failed", error: r.error };
      }
    },

    async runAction({ run, step, nodeId, stepRunId, input, approval, keyNode }) {
      const agent = await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId);
      const ctx: StepContext = {
        tenantId: run.tenantId,
        agent,
        runId: run.id,
        stepRunId,
        // v0.13 W2-I: an oversight retry with a corrected input keys its own write.
        stepId: keyNode ?? nodeId,
        mode: run.mode,
        approval,
        // The step as written in the version: fixed inputs are checked against it, not `input`.
        literalInput: step.input,
        externalIndex: { next: 0 },
        // v0.12 W1-E: a retry carries the run retried's approved, not-done writes (§10.10).
        ...(run.retryOf ? { retryOf: run.retryOf } : {}),
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
            notWritten: true,
          };
        case "awaiting_approval":
          return (
            firstWaiting({
              actions: [{ actionId: o.actionId, inboxItemId: o.inboxItemId }],
              output: null,
            }) ?? { kind: "failed", error: "a change waits with no approval card" }
          );
        case "awaiting_release":
          return releaseWaitOutcome(o, null, now());
        case "refused":
          return { kind: "failed", error: `refused: ${o.reason}` };
        case "failed":
          return { kind: "failed", error: o.error };
      }
    },

    async waitDone(request) {
      const waiting = releaseWaitOf(request.wait.state);
      if (waiting) {
        if (!release) return true;
        return releaseWaitDone(release.db, request.run.tenantId, waiting, now());
      }
      if (!reach) return true;
      return reach.waitDone(request);
    },

    async afterWait(request) {
      const waiting = releaseWaitOf(request.wait.state);
      if (waiting) {
        // DECISION: once released, the step runs again from the start with the input it first ran
        // with (its step_run row), in this durable step; the gate then finds the release.
        if (!release) return { kind: "failed", error: "access_not_released: nothing to wait with" };
        const { tenantId } = request.run;
        const after = await afterReleaseWait(release.db, tenantId, waiting, now());
        if (after.kind === "failed") return { kind: "failed", error: after.error };
        if (after.kind === "wait") return after.outcome;
        const input = await stepInputOf(release.db, tenantId, request.stepRunId);
        const { step } = request;
        const again = { ...request, input };
        return step.kind === "skill"
          ? port.runSkill({ ...again, step, approval: step.approval ?? DEFAULT_APPROVAL })
          : port.runAction({ ...again, step, approval: step.approval });
      }
      if (!reach) return { kind: "failed", error: "nothing to wait for" };
      return reach.afterWait(request);
    },

    async resume(request) {
      const { run, step, pending, resolution } = request;
      if (reach && reachOutState(pending.state)) return reach.resume(request);
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
  return port;
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
        // v0.12 W1-C: a lead check goes to the client's lead (as an operator's item), else to
        // the operator role (ARCHITECTURE §11.2).
        const lead =
          run.mode !== "test" && item.step.assignee === LEAD_ASSIGNEE
            ? await leadOf(tx, run.tenantId)
            : null;
        const assignee =
          run.mode === "test"
            ? { assigneeRole: "operator" as const, assigneeUserId: null }
            : item.step.assignee === LEAD_ASSIGNEE
              ? { assigneeRole: "operator" as const, assigneeUserId: lead?.userId ?? null }
              : resolveApprover([item.step.assignee]);
        const payload = {
          ...(isPlainObject(item.payload) ? (item.payload as JsonObject) : { value: item.payload }),
          nodeId: item.nodeId,
          mode: item.step.mode,
          ...(run.mode === "test" ? { testRun: true } : {}),
          // v0.12 W1-D: quick answers, from the version's step (the answer must be one of them).
          ...(item.step.mode === "ask" && item.step.choices ? { choices: item.step.choices } : {}),
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
          .select({
            item: inboxItem,
            // v0.12 W1-D: inside its undo window an approval is not yet the run's to take.
            held: sql<boolean>`coalesce(${inboxItem.deliverAfter} > now(), false)`,
          })
          .from(inboxItem)
          .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, run.tenantId)));
        return row?.item.status === "resolved" && !row.held ? toRunResolution(row.item) : null;
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
    async received(inboxItemId) {
      await withTenant(db, run.tenantId, (tx) =>
        tx
          .update(inboxItem)
          .set({ runReceivedAt: new Date() })
          .where(
            and(
              eq(inboxItem.id, inboxItemId),
              eq(inboxItem.tenantId, run.tenantId),
              isNull(inboxItem.runReceivedAt),
            ),
          ),
      );
    },
  };
}

/**
 * Notify steps. v1 has no email provider wired, so every channel posts to the run's thread. The
 * executor never sends a test run's notice; the audience check below stays as a second guard.
 */
// DECISION: until Resend is configured, `email` and `digest` notices are thread messages for the
// operator; only `thread` notices of live runs are client-facing. Test runs never message clients.
export function threadNotifyPort(deps: RuntimeDeps): NotifyPort {
  const { platform } = deps.ports;
  return {
    async send({ run, nodeId, channel, to, text, sources }) {
      await platform.postMessage(run.tenantId, {
        subject: { type: "run", id: run.id, title: `Run of ${run.workflowSlug}` },
        agentVersionId: run.agentVersionId,
        body: { text, channel, to, nodeId },
        sources,
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
