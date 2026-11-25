// The executor's ports (packages/workflows) over the database and the agents runtime: step_run rows,
// skill and action steps through runAgent / callTool (the permission gate, external actions),
// person steps' inbox items, and notify steps as thread messages. Every method is one short
// withTenant() transaction for the run's own client (invariant 1).

import {
  // R3
  addSignerItemTx,
  approveForRunTx,
  callTool,
  executeAction,
  // S4.5
  expireForRunTx,
  keepBrowseHelp,
  type RuntimeDeps,
  resolveApprover,
  runAgent,
  type StepContext,
  type SubjectToolLookup,
  signerItemsTx,
  unsignedRefusal,
} from "@countersign/agents";
import { actionIsOn, mergedOutput, resolveMergedCall } from "@countersign/connectors";
import {
  type Approval,
  type ApprovalAssignee,
  actionWrote,
  approverFromSetting,
  assigneeOf,
  // P-4
  CONVERSE_SKILL,
  DEFAULT_APPROVAL,
  // §1.121
  FORMS_REQUEST_SKILL,
  isPlainObject,
  type JsonObject,
  LEAD_ASSIGNEE,
  parseSkillRef,
  processes,
  REACH_OUT_SKILL,
  steps,
} from "@countersign/core";
import {
  type Db,
  externalAction,
  inboxItem,
  membership,
  stepRun,
  type Tx,
  toolCall,
  withTenant,
} from "@countersign/db";
import { leadOf } from "@countersign/threads";
import {
  type AgentPort,
  type InboxPort,
  LOOP_SKILL,
  type NotifyPort,
  type RunInfo,
  type StepLog,
  type StepOutcome,
  type StepRunUpdate,
} from "@countersign/workflows";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterReleaseWait,
  releaseWaitDone,
  releaseWaitOf,
  releaseWaitOutcome,
  stepInputOf,
} from "../access/release";
// Skill model (2026-11-10): a message action sends on the agent's channel, else the account's.
import { channelFor } from "../channels/resolve";
// P-4
import { type ConversePort, converseState } from "../converse/service";
// §1.121: forms, "Request info"
import { type FormsPort, formsState } from "../forms/service";
import { toRunResolution } from "../inbox";
import { type NotifyDeps, sendQueued } from "../notify/outbox";
import { queueUrgent } from "../notify/urgent";
import { reportHandled } from "../observability/report";
import { type ReachPort, reachOutState } from "../reach/service";
import { leaseWaitDone, leaseWaitOf, leaseWaitOutcome, MAX_LEASE_WAITS } from "./lease-wait";
import { boundWithActionOn, channelFallback, pickMerged } from "./merged-pick";
import { keepStepSubjects } from "./subject-log";

const TERMINAL = new Set(["succeeded", "failed", "skipped", "cancelled"]);

/**
 * `step_run` rows for one run. `start` is an upsert on (run_id, node_id): a retried step (or a
 * step's failure record) gets the row its first attempt wrote, never a second one.
 */
export function dbStepLog(
  db: Db,
  run: RunInfo,
  // docs/plan.md §1.188: what a finished step was about, kept beside its row; absent, nothing is.
  subjects?: { tools: SubjectToolLookup; visible: (nodeId: string) => boolean },
): StepLog {
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
        // R3: a write that went ahead with nobody's answer says so on its row (R5's late answers).
        const marked = u.proceededWithoutAnswer ? await proceededMark(tx, run, u, output) : output;
        await tx
          .update(stepRun)
          .set({
            status: u.status,
            ...(marked === undefined ? {} : { output: marked as Record<string, unknown> | null }),
            ...(u.summary === undefined ? {} : { summary: u.summary }),
            ...(TERMINAL.has(u.status) ? { finishedAt: new Date() } : {}),
          })
          .where(and(eq(stepRun.id, stepRunId), eq(stepRun.tenantId, run.tenantId)));
        // A step that finished (done or failed) keeps what it was about, in its own savepoint.
        if (subjects && (u.status === "succeeded" || u.status === "failed")) {
          await keepStepSubjects(tx, { tenantId: run.tenantId, stepRunId, ...subjects });
        }
      });
    },
  };
}

/**
 * The mark a write that went ahead with nobody's answer leaves on its step's row, R5's contract
 * (packages/agents `proceededWriteTx`): `proceededWithoutAnswer`, the write's `externalActionId`
 * and every approval item that asked for it (`inboxItemIds`), beside what the step put out.
 */
// DECISION: the mark goes in `step_run.output` (no new column, as R5 reads it); an output that
// isn't an object is kept under `output`, as an error is kept beside it.
async function proceededMark(
  tx: Tx,
  run: RunInfo,
  u: StepRunUpdate,
  output: unknown,
): Promise<unknown> {
  const base = isPlainObject(output) ? output : output === undefined ? {} : { output };
  const actionId = u.externalActionId;
  const items = actionId
    ? await signerItemsTx(tx, run.tenantId, { id: actionId, inboxItemId: null })
    : [];
  return {
    ...base,
    proceededWithoutAnswer: true,
    ...(actionId ? { externalActionId: actionId } : {}),
    ...(items.length ? { inboxItemIds: items.map((i) => i.id) } : {}),
  };
}

/**
 * Who an item asked of `who` goes to: a role, the client's lead (as an operator's item), or a
 * person of this client by user id. A test run's items go to the operator (test runs are hidden
 * from the portal).
 */
// DECISION: an id that isn't a member of this client (a directory contact, who can't sign in to
// the portal, or anyone else) is the client admin's, as the approver rules send a rule naming a
// non-member: an item is never left with nobody able to answer it.
export async function personAssignee(
  tx: Tx,
  run: Pick<RunInfo, "tenantId" | "mode">,
  who: string,
): Promise<ApprovalAssignee> {
  if (run.mode === "test") return { assigneeRole: "operator", assigneeUserId: null };
  if (who === LEAD_ASSIGNEE) {
    const lead = await leadOf(tx, run.tenantId);
    return { assigneeRole: "operator", assigneeUserId: lead?.userId ?? null };
  }
  const target = approverFromSetting(who);
  if (target?.kind === "user") {
    const [m] = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.tenantId, run.tenantId), eq(membership.userId, target.userId)));
    if (!m) return { assigneeRole: "client_admin", assigneeUserId: null };
  }
  return assigneeOf(target ?? { kind: "client_admin" });
}

/** What a step waiting on approvals carries between durable steps. Small: ids only. */
const PendingState = z.object({
  actions: z.array(z.object({ actionId: z.string(), inboxItemId: z.string().nullable() })),
  output: z.unknown().optional(),
  // Audit 3.7: one of the step's changes was rejected though the run read a yes: the step ends
  // as declined once its other changes are settled.
  declined: z.boolean().optional(),
});
type PendingState = z.infer<typeof PendingState>;

function firstWaiting(state: PendingState, after = -1): StepOutcome | null {
  const next = state.actions.slice(after + 1).find((a) => a.inboxItemId);
  // R3: the action the item signs, so the step's row can name a write that went ahead unsigned.
  return next?.inboxItemId
    ? {
        kind: "approval",
        pending: { inboxItemId: next.inboxItemId, state, actionId: next.actionId },
      }
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
  /**
   * The database, for steps that wait on a person's release (docs/plan.md §1.26), and (R3) for a
   * write's further signers and the run's decision on it.
   */
  release?: { db: Db },
  // P-4: conversations (docs/plan.md §1.66)
  converse?: ConversePort,
  // §1.121: forms, "Request info"
  forms?: FormsPort,
): AgentPort {
  const now = () => deps.now?.() ?? new Date();
  // The step model (§10c): whether the operator has a connector's action on for agents.
  const actionOn = async (connector: string, tool: string): Promise<boolean> => {
    const manifest = deps.tools.connectors.get(connector)?.manifest;
    if (!manifest) return true;
    const switches = (await deps.ports.store.actionSwitches?.(connector)) ?? null;
    return actionIsOn(manifest, tool, switches);
  };
  const connectorName = (id: string) => deps.tools.connectors.get(id)?.manifest.name ?? id;
  // A call the platform makes for a step (an action step's tool, the lead's answer kept).
  const platformStep = async (
    run: RunInfo,
    stepRunId: string,
    stepId: string,
    approval: Approval,
  ): Promise<StepContext> => ({
    tenantId: run.tenantId,
    agent: await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId),
    runId: run.id,
    stepRunId,
    stepId,
    mode: run.mode,
    approval,
    externalIndex: { next: 0 },
    // v0.12 W1-E: a retry carries the run retried's approved, not-done writes (§10.10).
    ...(run.retryOf ? { retryOf: run.retryOf } : {}),
  });
  /**
   * What an approved change's execution means for the step (its resume, or the run again once a
   * claim on it ran out): the step's next card, its end, or why it can't go on.
   */
  const afterExecuted = (
    step: { kind: string },
    state: PendingState,
    index: number,
    r: Awaited<ReturnType<typeof executeAction>> | null,
    waited: number,
  ): StepOutcome => {
    if (r) {
      if (r.status === "failed") return { kind: "failed", error: r.error };
      if (r.status === "awaiting_approval") {
        return { kind: "failed", error: "the approval was not recorded on the change" };
      }
      // Audit 3.2, follow-up 1: an earlier try claimed it and may have stopped mid-write. This
      // one never sends it too: it waits for the claim's lease, then executes it again.
      if (r.status === "busy") {
        return leaseWaitOutcome(
          { actionId: r.action.id, leaseEndsAt: r.leaseEndsAt },
          now(),
          waited,
          { state, index },
        );
      }
      // Audit 3.7: the change was turned down after all (one signer's no rejects it at once,
      // whatever another's yes said): nothing was written, and the step takes it as a person's
      // no (`declined`, its onReject), never as done.
      if (r.status === "rejected") state.declined = true;
      if (r.status === "done" && step.kind === "action") state.output = r.output;
    }
    return (
      firstWaiting(state, index) ?? {
        kind: "done",
        output: state.output ?? null,
        ...(state.declined ? { declined: true } : {}),
      }
    );
  };
  const port: AgentPort = {
    async runSkill(request) {
      const { run, step, nodeId, stepRunId, input, approval } = request;
      if (parseSkillRef(step.skill).id === REACH_OUT_SKILL) {
        if (!reach) return { kind: "failed", error: "comms.reach-out needs the reach-out service" };
        return reach.start(request);
      }
      // §1.121: the built-in form request goes to the forms service, which sends through reach out.
      if (parseSkillRef(step.skill).id === FORMS_REQUEST_SKILL) {
        if (!forms) return { kind: "failed", error: "forms.request needs its service" };
        return forms.start(request);
      }
      // P-4: the built-in conversation step goes to the conversation service (§1.66).
      if (parseSkillRef(step.skill).id === CONVERSE_SKILL) {
        if (!converse) return { kind: "failed", error: "comms.converse needs its service" };
        return converse.start(request);
      }
      // The step model (§8): a Loop written in the step runs on its own goal and reads, no skill.
      const writtenLoop = request.loop !== undefined && step.skill === LOOP_SKILL;
      const r = await runAgent(deps, {
        tenantId: run.tenantId,
        agentVersionId: run.agentVersionId,
        ...(writtenLoop ? {} : { skill: step.skill }),
        ...(request.loop ? { loop: request.loop } : {}),
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
        // Owner, 2026-11-11: rule skills read "today" in the client's time zone.
        ...(run.timeZone ? { timeZone: run.timeZone } : {}),
        // v0.12 W1-E: a retry carries the run retried's approved, not-done writes (§10.10).
        ...(run.retryOf ? { retryOf: run.retryOf } : {}),
        // v0.12 W2-B: a step of an automation runs with the automation's skills.
        ...(request.automation ? { automation: request.automation } : {}),
        // R3: a v4 step's customization of its skill (its added instructions).
        ...(request.customize ? { customize: request.customize } : {}),
        // Follow-up 2: the platform's retry of this work: its budgets go on from the earlier try.
        ...(request.retried ? { retried: true } : {}),
        // Reshape data (2026-11-11): the step's mapping, run by the skill's pure handler.
        ...(request.reshape ? { reshape: request.reshape } : {}),
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
        // Follow-up 1: a change an earlier try claimed: wait for its lease, then run again.
        case "awaiting_lease":
          return leaseWaitOutcome(r, now(), 0);
        case "escalated":
          return { kind: "escalated", reason: r.reason, inboxItemId: r.inboxItemId };
        case "failed":
          return { kind: "failed", error: r.error };
      }
    },

    async runAction({
      run,
      step,
      nodeId,
      stepRunId,
      input,
      approval,
      keyNode,
      binding,
      afterUnwritten,
    }) {
      const base = await platformStep(run, stepRunId, keyNode ?? nodeId, approval);
      const ctx: StepContext = {
        // v0.13 W2-I: an oversight retry with a corrected input keys its own write.
        ...base,
        // Skill model: an action's channel connection is the agent's binding for this call (the
        // account's channel is the agent's when it has none of its own, §10.14); the gate reads
        // that connection's matrix, the agent's grant and its mode as for any binding.
        ...(binding
          ? {
              agent: {
                ...base.agent,
                bindings: { ...base.agent.bindings, [binding.connector]: binding.connectionId },
              },
            }
          : {}),
        // The step as written in the version: fixed inputs are checked against it, not `input`.
        literalInput: step.input,
        // A test run's write on what an unmade write would have returned (callTool skips its
        // before state; outside a test run it is ignored).
        ...(afterUnwritten && run.mode === "test" ? { afterUnwritten: true } : {}),
      };
      // Review 2, item 5: the step's own input: another one under its key fails the step.
      const o = await callTool(deps, ctx, { toolId: step.tool, input, ownInput: true });
      switch (o.status) {
        case "done":
          return { kind: "done", output: o.output };
        case "would_have_done": {
          // A test run: recorded as proposed, never executed (ARCHITECTURE §10.4).
          const proposed = {
            wouldHaveDone: true,
            actionId: o.actionId,
            before: o.before ?? null,
            // §1.212: the verifier's outcome on it, for the eval harness.
            ...(o.verification ? { verification: o.verification } : {}),
          };
          // §1.94: the tool's stand-in output, its fields where later steps read the real ones.
          if (!isPlainObject(o.standIn))
            return { kind: "done", output: proposed, notWritten: true };
          return {
            kind: "done",
            output: { ...proposed, ...o.standIn, standIn: true },
            notWritten: true,
            standIn: true,
          };
        }
        case "awaiting_approval":
          return (
            firstWaiting({
              actions: [{ actionId: o.actionId, inboxItemId: o.inboxItemId }],
              output: null,
            }) ?? { kind: "failed", error: "a change waits with no approval card" }
          );
        case "awaiting_release":
          return releaseWaitOutcome(o, null, now());
        // Follow-up 1: a change an earlier try claimed: wait for its lease, then run again.
        case "busy":
          return leaseWaitOutcome(o, now(), 0);
        // Follow-up 3: an action's input is the step's own, so another input under its key is no
        // model's rewording: the step fails, naming the change it has.
        case "recorded":
          return {
            kind: "failed",
            error: `this step's change ${o.actionId} was made with another input than this try's: check the step's changes before trying again`,
          };
        case "refused":
          return { kind: "failed", error: `refused: ${o.reason}` };
        case "failed":
          return { kind: "failed", error: o.error };
      }
    },

    // Skill model (2026-11-10): an action write step's tool, for this run's agent.
    // DECISION: an accounting action resolves from the pinned version's bindings (the connection
    // the gate then reads fresh); a message action from `channelFor` (the agent's own channel,
    // else the account's), read now, in the run's own client. Neither is guessed: no connection,
    // or two accounting connections without `via`, is refused (nothing written).
    // The step model (§10c): a merged action that isn't one of today's write actions (Team chat,
    // Spreadsheets), from the connectors the pinned version is bound to, in the merge's order,
    // skipping one whose action the operator switched off (`connector_setting.actions`), so an
    // off action is refused before the gate and another bound connector of the merge still runs.
    // DECISION: never guessed: no bound connector of the merge with the action on is refused,
    // saying whether it was off or not connected (nothing written).
    async resolveMerged({ run, action }) {
      const pinned = await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId);
      return pickMerged(action, Object.keys(pinned.bindings), actionOn, connectorName);
    },

    mergedInput(action, connector, input) {
      return resolveMergedCall(action, [connector], input)?.input ?? input;
    },

    mergedOutput(action, connector, output) {
      return mergedOutput(action, connector, output);
    },

    async resolveAction({ run, action, via }) {
      const spec = processes.ACTION_SPECS[action];
      if ("channel" in spec.from) {
        const kind = spec.from.channel;
        if (!release) return { refused: `${spec.label} needs the database to find its channel` };
        const line = await withTenant(release.db, run.tenantId, (tx) =>
          channelFor(tx, run.tenantId, run.agentId, kind),
        );
        const r = processes.resolveActionConnector(action, via, {
          bound: [],
          channels: { [kind]: line ? { connector: line.connector } : null },
        });
        if (!r?.ok || !line) return { refused: r && !r.ok ? r.message : "no channel" };
        if (await actionOn(r.connector, r.tool)) {
          return { tool: r.tool, connector: r.connector, connectionId: line.connectionId };
        }
        // The step model (§10c): the channel's action is switched off; another of the merge's
        // connectors the agent is bound to, with it on, sends instead (Gmail when Resend's is off).
        const pinned = await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId);
        const other = await channelFallback(
          action,
          r.connector,
          Object.keys(pinned.bindings),
          actionOn,
        );
        return (
          other ?? { refused: `${spec.label} is switched off for ${connectorName(r.connector)}` }
        );
      }
      const pinned = await deps.ports.store.loadAgentVersion(run.tenantId, run.agentVersionId);
      // The step model (§10c): a bound connector whose action is switched off isn't a candidate.
      const { bound, off } = await boundWithActionOn(
        action,
        Object.keys(pinned.bindings),
        actionOn,
      );
      const r = processes.resolveActionConnector(action, via, { bound });
      if (!r || !r.ok) {
        if (off.length > 0 && (via === undefined || off.includes(via))) {
          return {
            refused: `${spec.label} is switched off for ${off.map(connectorName).join(" and ")}`,
          };
        }
        return { refused: r && !r.ok ? r.message : `${spec.label} doesn't resolve here` };
      }
      return { tool: r.tool, connector: r.connector };
    },

    async waitDone(request) {
      // Follow-up 1: a claim an earlier try holds: done once it is released or has run out.
      const lease = leaseWaitOf(request.wait.state);
      if (lease) {
        return release ? leaseWaitDone(release.db, request.run.tenantId, lease.actionId) : true;
      }
      const waiting = releaseWaitOf(request.wait.state);
      if (waiting) {
        if (!release) return true;
        return releaseWaitDone(release.db, request.run.tenantId, waiting, now());
      }
      // §1.121: a form request's state wraps its reach-out's while the link is sending.
      if (forms && formsState(request.wait.state)) return forms.waitDone(request);
      // P-4
      if (converse && converseState(request.wait.state)) return converse.waitDone(request);
      if (!reach) return true;
      return reach.waitDone(request);
    },

    async afterWait(request) {
      // Follow-up 1: the claim has run out (or is gone): take the change over.
      const lease = leaseWaitOf(request.wait.state);
      if (lease) {
        const { tenantId } = request.run;
        if (lease.resume) {
          // An approved change: executed again here (claimed again once its lease ran out).
          const state = PendingState.parse(lease.resume.state);
          const r = await executeAction(deps, { tenantId, actionId: lease.actionId });
          return afterExecuted(request.step, state, lease.resume.index, r, lease.tries);
        }
        // The step runs again from the start with the input it first ran with, as after a
        // release: its changes are found by their keys, and the claimed one is taken over.
        if (!release) return { kind: "failed", error: "a claimed change: nothing to wait with" };
        const input = await stepInputOf(release.db, tenantId, request.stepRunId);
        const { step } = request;
        const again = { ...request, input };
        const next =
          step.kind === "skill"
            ? await port.runSkill({ ...again, step, approval: step.approval ?? DEFAULT_APPROVAL })
            : await port.runAction({ ...again, step, approval: step.approval });
        // Claimed still (or another of its changes is): the waits so far count.
        const still = next.kind === "waiting" ? leaseWaitOf(next.wait.state) : null;
        if (!still || next.kind !== "waiting") return next;
        if (lease.tries >= MAX_LEASE_WAITS) {
          return leaseWaitOutcome(
            { actionId: still.actionId, leaseEndsAt: null },
            now(),
            lease.tries,
          );
        }
        return {
          ...next,
          wait: { ...next.wait, state: { lease: { ...still, tries: lease.tries + 1 } } },
        };
      }
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
        // Review: a message action runs again through the channel it resolved to (carried on the
        // wait's request), not the agent's own bindings alone.
        return step.kind === "skill"
          ? port.runSkill({ ...again, step, approval: step.approval ?? DEFAULT_APPROVAL })
          : port.runAction({ ...again, step, approval: step.approval });
      }
      // §1.121
      if (forms && formsState(request.wait.state)) return forms.afterWait(request);
      // P-4
      if (converse && converseState(request.wait.state)) return converse.afterWait(request);
      if (!reach) return { kind: "failed", error: "nothing to wait for" };
      return reach.afterWait(request);
    },

    async resume(request) {
      const { run, step, pending, resolution } = request;
      // §1.121: a form request's link plan (its state wraps the reach-out's).
      if (forms && formsState(pending.state)) return forms.resume(request);
      // P-4: a conversation's approvals and hand-over first: its state also names a reach-out.
      if (converse && converseState(pending.state)) return converse.resume(request);
      if (reach && reachOutState(pending.state)) return reach.resume(request);
      const state = PendingState.parse(pending.state ?? { actions: [] });
      const index = state.actions.findIndex((a) => a.inboxItemId === pending.inboxItemId);
      const current = state.actions[index];
      if (current && resolution.approved === true && release) {
        // R3: the run's decision on a change several people (or, in time, nobody) were asked to
        // sign. Nobody answering goes ahead only where the gate, asked again now, would let the
        // write run unsigned (invariant 8); then the change is approved by its deadline.
        if (resolution.proceeded === true) {
          const refused = await unsignedRefusal(deps, {
            tenantId: run.tenantId,
            actionId: current.actionId,
          });
          if (refused) {
            return { kind: "failed", error: `nobody answered in time, and ${refused}` };
          }
        }
        await withTenant(release.db, run.tenantId, (tx) =>
          approveForRunTx(tx, run.tenantId, {
            actionId: current.actionId,
            by: resolution.by,
            proceeded: resolution.proceeded === true,
          }),
        );
      }
      if (current && resolution.approved === true) {
        // Executed once by its idempotency key, in this durable step (docs/plan.md §1.2).
        const r = await executeAction(deps, { tenantId: run.tenantId, actionId: current.actionId });
        return afterExecuted(step, state, index, r, 0);
      }
      // S4.5: nobody answered in time (no person's answer: `by` null, not withdrawn). The change
      // is closed as not made, so it never reads "Waiting for approval" once nothing waits on it.
      // A person's no already rejected it; then this changes nothing.
      if (
        current &&
        release &&
        resolution.approved === false &&
        resolution.by === null &&
        resolution.withdrawn !== true
      ) {
        await withTenant(release.db, run.tenantId, (tx) =>
          expireForRunTx(tx, run.tenantId, { actionId: current.actionId }),
        );
      }
      return afterExecuted(step, state, index, null, 0);
    },

    // Wave 5 review (docs/plan.md §1.86 "Forks (wave 5)"): whether the step made a write, or may
    // have: its actions done or executing, or failed without the runtime's `notWritten` (an older
    // failure, recorded before the mark existed, counts as may-have).
    ...(release
      ? {
          stepWrites({ run, nodeId }: { run: RunInfo; nodeId: string }) {
            const prefix = `${run.id}:${nodeId}:`;
            return withTenant(release.db, run.tenantId, async (tx) => {
              const rows = await tx
                .select({ status: externalAction.status, error: externalAction.error })
                .from(externalAction)
                .where(
                  and(
                    eq(externalAction.tenantId, run.tenantId),
                    eq(externalAction.runId, run.id),
                    sql`starts_with(${externalAction.idempotencyKey}, ${prefix})`,
                  ),
                );
              if (rows.some((r) => actionWrote(r))) return true;
              // Fix 3: a retry's carried writes run on the run retried's actions (their run id and
              // key), so they are found by this run's tool calls at the step, which name them.
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
                    eq(toolCall.tenantId, run.tenantId),
                    eq(stepRun.runId, run.id),
                    or(
                      eq(stepRun.nodeId, nodeId),
                      sql`starts_with(${stepRun.nodeId}, ${`${nodeId}:`})`,
                    ),
                  ),
                );
              return carried.some((r) => actionWrote(r));
            });
          },
        }
      : {}),

    // R3 (docs/plan.md §1.86): approval modes and escalation on a write.
    async askApprover(request) {
      const { run, pending, who } = request;
      if (!release) throw new Error("asking another approver needs the database");
      if (converseState(pending.state) || reachOutState(pending.state)) {
        // DECISION: a conversation's or a reach-out's signature is one person's (its own card and
        // route); asking more people to sign it is refused, so the step fails closed.
        throw new Error("a message's signature can't be asked of more than one person");
      }
      const state = PendingState.parse(pending.state ?? { actions: [] });
      const actionId =
        pending.actionId ??
        state.actions.find((a) => a.inboxItemId === pending.inboxItemId)?.actionId;
      if (!actionId) throw new Error("the approval names no change to sign");
      return withTenant(release.db, run.tenantId, async (tx) => {
        const assignee = await personAssignee(tx, run, who);
        const item = await addSignerItemTx(tx, run.tenantId, {
          actionId,
          runId: run.id,
          nodeId: request.nodeId,
          ...assignee,
          dueAt: new Date(request.dueAt),
          remindAt: request.remindAt,
        });
        return { inboxItemId: item.id };
      });
    },
    // R3: runSkill passes `customize` on to runAgent, which applies its added instructions (and
    // refuses rule rows it can't run yet), so a customized step never runs without them.
    appliesCustomization: true,

    // v0.16 (docs/plan.md §1.86): the lead's answer to a browsing skill's help request, kept as
    // the platform's own note (never the model's memory), logged on the step's row.
    async keepHelp({ run, stepRunId, nodeId, remember, question, answer }) {
      const ctx = await platformStep(run, stepRunId, nodeId, DEFAULT_APPROVAL);
      await keepBrowseHelp(deps, ctx, { remember, question, answer });
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
    // Audit 3.7: what is left of a resolved item's undo window, by the database's clock (as the
    // window itself and `resolution` read it).
    heldFor(inboxItemId) {
      return withTenant(db, run.tenantId, async (tx) => {
        const [row] = await tx
          .select({
            status: inboxItem.status,
            seconds: sql<number>`greatest(0, coalesce(extract(epoch from (${inboxItem.deliverAfter} - now())), 0))::float8`,
          })
          .from(inboxItem)
          .where(and(eq(inboxItem.id, inboxItemId), eq(inboxItem.tenantId, run.tenantId)));
        return row?.status === "resolved" ? Number(row.seconds) : null;
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
export function threadNotifyPort(
  deps: RuntimeDeps,
  /** R3: the database, for a v4 notice's "Seen" item and a deadline's `tell` (who is who). */
  db?: Db,
  /** Wave 2c: email and texts, so an urgent notice's person is told at once. */
  notifyDeps?: NotifyDeps,
): NotifyPort {
  const { platform } = deps.ports;
  const port: NotifyPort = {
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
  if (!db) return port;

  // ── R3 (docs/plan.md §1.86): v4 notifications and deadlines' `tell` ──────────────────────────

  // DECISION: a v4 notice is one message on the run's thread naming who it is for and how (the
  // channel), as v3's notices are until free text goes out by email or text: client-facing when a
  // live run's notice is for anyone on the client's side. An urgent one also opens a "Seen" item
  // (a request) for its first recipient, due by `dueAt`, which the run waits on.
  // DECISION (wave 2c): the Seen item is made before the message is posted, and found again by
  // its run, step and kind (`payload.notice`), so a retried step neither posts twice after a
  // failed insert nor takes another item of the same step for its own. Its person is told at once
  // (notify/urgent.ts), whatever the hours, by text too; never for a test run.
  port.notify = async ({ run, nodeId, to, channel, text, sources, urgent }) => {
    const ours = to.every((w) => w === "operator" || w === LEAD_ASSIGNEE);
    const first = to[0];
    const seen =
      urgent && first
        ? await seenItem(run, nodeId, first, { text, channel, sources, dueAt: urgent.dueAt })
        : null;
    await platform.postMessage(run.tenantId, {
      subject: { type: "run", id: run.id, title: `Run of ${run.workflowSlug}` },
      agentVersionId: run.agentVersionId,
      body: { text, channel, to: [...to], nodeId, ...(urgent ? { urgent: true } : {}) },
      sources,
      audience: run.mode === "live" && !ours ? "client" : "operator",
    });
    if (seen && notifyDeps && run.mode !== "test") {
      const deliver = notifyDeps;
      const now = new Date();
      // C4.10: queued in the outbox as `urgent`, then sent at once, outside that transaction;
      // what doesn't go now (a failed send, a pass cut off) the outbox's next pass sends.
      const queued = await withTenant(db, run.tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(inboxItem)
          .where(and(eq(inboxItem.id, seen), eq(inboxItem.tenantId, run.tenantId)));
        return row?.status === "open" ? queueUrgent(tx, deliver.origin, row, now) : [];
      });
      if (queued.length > 0) {
        await sendQueued(db, deliver, run.tenantId, now, queued.length, queued).catch(
          (error: unknown) =>
            reportHandled(
              "sending an urgent notice failed; the outbox's next pass sends it",
              error,
              {
                job: "notify",
                client: run.tenantId,
              },
            ),
        );
      }
    }
    return { ackItemId: seen };
  };

  /** The urgent notice's Seen item for this step: found again on a retry, else made. */
  const seenItem = (
    run: RunInfo,
    nodeId: string,
    who: string,
    notice: { text: string; channel: string; sources: readonly string[]; dueAt: string },
  ) =>
    withTenant(db, run.tenantId, async (tx) => {
      const [existing] = await tx
        .select({ id: inboxItem.id })
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, run.tenantId),
            eq(inboxItem.runId, run.id),
            eq(inboxItem.kind, "request"),
            sql`${inboxItem.payload}->>'nodeId' = ${nodeId}`,
            sql`${inboxItem.payload}->'notice' is not null`,
          ),
        )
        .limit(1);
      if (existing) return existing.id;
      const [row] = await tx
        .insert(inboxItem)
        .values({
          tenantId: run.tenantId,
          kind: "request",
          agentId: run.agentId,
          subjectType: "run",
          subjectId: run.id,
          runId: run.id,
          ...(await personAssignee(tx, run, who)),
          title: notice.text.slice(0, 200),
          payload: {
            nodeId,
            mode: "ask",
            question: "Seen?",
            notice: { text: notice.text, channel: notice.channel, urgent: true },
            sources: [...notice.sources],
            ...(run.mode === "test" ? { testRun: true } : {}),
          },
          dueAt: new Date(notice.dueAt),
        })
        .returning({ id: inboxItem.id });
      if (!row) throw new Error("inbox item insert returned nothing");
      return row.id;
    });

  // DECISION: a deadline's `tell` is a `review` item for each person or role it names (the
  // operator's as `notifyOperator` makes it), saying what passed; a test run's tell only us.
  // DECISION (wave 2c): one per (run, step, who told), so a retried step tells nobody twice.
  port.tell = async ({ run, nodeId, to, inboxItemId, reason }) => {
    const told = run.mode === "test" ? ["operator"] : [...new Set(to)];
    await withTenant(db, run.tenantId, async (tx) => {
      for (const who of told) {
        const [already] = await tx
          .select({ id: inboxItem.id })
          .from(inboxItem)
          .where(
            and(
              eq(inboxItem.tenantId, run.tenantId),
              eq(inboxItem.runId, run.id),
              eq(inboxItem.kind, "review"),
              sql`${inboxItem.payload}->>'nodeId' = ${nodeId}`,
              sql`${inboxItem.payload}->>'told' = ${who}`,
            ),
          )
          .limit(1);
        if (already) continue;
        const assignee =
          who === "operator"
            ? { assigneeRole: "operator" as const, assigneeUserId: null }
            : await personAssignee(tx, run, who);
        await tx.insert(inboxItem).values({
          tenantId: run.tenantId,
          kind: "review",
          agentId: run.agentId,
          runId: run.id,
          ...assignee,
          title: reason.slice(0, 200),
          payload: {
            nodeId,
            inboxItemId,
            reason,
            told: who,
            ...(run.mode === "test" ? { testRun: true } : {}),
          },
        });
      }
    });
  };
  return port;
}
