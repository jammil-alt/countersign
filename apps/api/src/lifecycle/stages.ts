// Go-live stages (ARCHITECTURE §10.9; docs/plan.md §1.36): a client agent goes bench → trial →
// signoff → live. Starting the trial is today's Activate; the hourly pass moves a trial that has
// met both its minimums to signoff and asks the client admin on the Desk; the client admin's
// approval makes it live, a rejection sends it back to trial with a new start. The operator may
// move an agent forward past a stage with a reason, or back at any time. Every move is an
// `agent_change` row (`kind: 'stage'`) and an audit row. Each function runs in the caller's
// transaction, scoped to the agent's client (invariant 1).

import { activate, type RegistryContext, skillContext } from "@countersign/agents";
import {
  type AgentBundle,
  type AgentStage,
  clientLanguage,
  GO_LIVE_SUBJECT,
  type GoLive,
  GoLivePayload,
  goLiveItem,
  isExternalTool,
  NO_WRITES_REASON,
  readPause,
  readStageState,
  type SignoffSummary,
  type StageState,
  skillTools,
  stageMove,
  stagesPassed,
  startTrial,
  trialProgress,
  walkSteps,
} from "@countersign/core";
import {
  agent,
  agentChange,
  agentVersion,
  externalAction,
  inboxItem,
  run,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { type AuditEntry, auditInTx } from "../audit";
import { HttpError } from "../http";

export type AgentRow = typeof agent.$inferSelect;
type InboxRow = typeof inboxItem.$inferSelect;

/** Who moved a stage, for the audit row. */
export type StageActor = Pick<
  AuditEntry,
  "actorKind" | "actorUserId" | "actorEmail" | "actorRole"
>;

export const SYSTEM_ACTOR: StageActor = { actorKind: "system" };

/** The subject of the operator's item when a client rejects a go-live (until W1-C's lead thread). */
export const GO_LIVE_REJECTED_SUBJECT = "go_live_rejected";

/**
 * A client agent's stage. A client agent with no stage yet is on the bench.
 */
// DECISION: migration 0019 adds `agent.stage` with no default, so client agents made after it
// (fork, copy, create, a template's test copy) have none until they move; a client agent without
// one is read as `bench` everywhere here, and the gate treats it as not live (core effectiveMode).
export function stageOf(row: Pick<AgentRow, "kind" | "stage">): AgentStage | null {
  if (row.kind !== "client") return null;
  const s = row.stage;
  return s === "bench" || s === "trial" || s === "signoff" || s === "live" ? s : "bench";
}

/**
 * Whether a bundle writes to a client's tool: an `external` tool anywhere (action steps, its
 * skills' tools, extra tools), or a skill that reaches people (each attempt of a reach-out is a
 * write through the client's channels).
 */
// DECISION: reaching people counts as a write, though `comms.reach_out` itself is `internal`: its
// attempts are external actions on the client's own channels (docs/plan.md §1.25). Automations
// (W2-B) don't exist yet; their steps join this walk when they do.
export async function bundleWrites(
  tx: Tx,
  tenantId: string,
  bundle: AgentBundle,
  ctx: RegistryContext,
): Promise<boolean> {
  const { skills } = await skillContext(tx, { tenantId, bundle, catalog: ctx.catalog });
  const toolIds = new Set(bundle.definition.extraTools);
  let reaches = false;
  const addSkill = (ref: string) => {
    const def = skills[ref] ?? skills[ref.split("@")[0] ?? ref];
    if (!def) return;
    if (def.reachesPeople) reaches = true;
    for (const t of skillTools(def)) toolIds.add(t);
  };
  for (const s of bundle.definition.skills) addSkill(s.skill);
  for (const w of bundle.workflows) {
    if (!w.enabled) continue;
    walkSteps(w.workflow, ({ step }) => {
      if (step.kind === "skill") addSkill(step.skill);
      if (step.kind === "action") toolIds.add(step.tool);
    });
  }
  if (reaches) return true;
  for (const id of toolIds) {
    const t = ctx.tools.get(id);
    if (t && isExternalTool(t.spec)) return true;
  }
  return false;
}

async function liveBundle(tx: Tx, row: AgentRow): Promise<AgentBundle | null> {
  if (!row.liveVersionId) return null;
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(eq(agentVersion.id, row.liveVersionId));
  return v?.bundle ?? null;
}

/** Whether the agent's live version writes to a client's tool (no live version: no). */
export async function liveVersionWrites(
  tx: Tx,
  row: AgentRow,
  ctx: RegistryContext,
): Promise<boolean> {
  const bundle = await liveBundle(tx, row);
  if (!bundle || !row.tenantId) return false;
  return bundleWrites(tx, row.tenantId, bundle, ctx);
}

async function lockAgent(tx: Tx, agentId: string): Promise<AgentRow> {
  const [row] = await tx.select().from(agent).where(eq(agent.id, agentId)).for("update");
  if (!row) throw new HttpError(404, "not_found", "agent not found");
  return row;
}

/** Writes a stage, its state, the `agent_change` row and the audit row. */
async function writeStage(
  tx: Tx,
  row: AgentRow,
  input: {
    to: AgentStage;
    state: StageState;
    reason: string | null;
    actorId: string | null;
    actor: StageActor;
    via?: string;
    extra?: Partial<Pick<AgentRow, "runStatus" | "pause">>;
  },
): Promise<AgentRow> {
  const from = stageOf(row);
  const [updated] = await tx
    .update(agent)
    .set({ stage: input.to, stageState: input.state, ...(input.extra ?? {}) })
    .where(eq(agent.id, row.id))
    .returning();
  if (!updated) throw new Error("agent update returned nothing");
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actorId,
    change: {
      kind: "stage",
      from,
      to: input.to,
      reason: input.reason,
      ...(input.via ? { via: input.via } : {}),
    },
  });
  await auditInTx(tx, null, {
    ...input.actor,
    tenantId: row.tenantId,
    action: "agent.stage",
    outcome: "ok",
    target: { agent: row.id, from: from ?? "", to: input.to, ...(input.via ? { via: input.via } : {}) },
  });
  return updated;
}

// ── The trial in numbers ─────────────────────────────────────────────────────────────────────────

/** Finished live runs (succeeded or failed) of the agent since `since`. */
// DECISION: "finished" is succeeded or failed: a cancelled run was stopped, not finished, and a
// run still waiting has not finished yet.
export async function finishedLiveRuns(
  tx: Tx,
  tenantId: string,
  agentId: string,
  since: Date,
): Promise<{ runs: number; succeeded: number; failed: number }> {
  const rows = await tx
    .select({ status: run.status, n: sql<number>`count(*)::int` })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.agentId, agentId),
        eq(run.mode, "live"),
        inArray(run.status, ["succeeded", "failed"]),
        gte(run.createdAt, since),
      ),
    )
    .groupBy(run.status);
  const succeeded = rows.find((r) => r.status === "succeeded")?.n ?? 0;
  const failed = rows.find((r) => r.status === "failed")?.n ?? 0;
  return { runs: succeeded + failed, succeeded, failed };
}

/** The trial in numbers, for the client admin's go-live item. */
export async function trialSummary(
  tx: Tx,
  row: AgentRow,
  startedAt: string,
): Promise<SignoffSummary> {
  const tenantId = row.tenantId as string;
  const since = new Date(startedAt);
  const counts = await finishedLiveRuns(tx, tenantId, row.id, since);
  const [a] = await tx
    .select({
      done: sql<number>`count(*) filter (where ${externalAction.status} = 'done')::int`,
      signed: sql<number>`count(*) filter (where ${externalAction.approvedBy} is not null and ${externalAction.status} in ('approved', 'executing', 'done', 'failed'))::int`,
      rejected: sql<number>`count(*) filter (where ${externalAction.status} = 'rejected' and ${externalAction.inboxItemId} is not null)::int`,
    })
    .from(externalAction)
    .innerJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(run.agentId, row.id),
        eq(run.mode, "live"),
        gte(run.createdAt, since),
      ),
    );
  return {
    trialStartedAt: startedAt,
    ...counts,
    changesMade: a?.done ?? 0,
    signed: a?.signed ?? 0,
    rejected: a?.rejected ?? 0,
  };
}

// ── Sign-off ─────────────────────────────────────────────────────────────────────────────────────

export function isGoLiveItem(item: Pick<InboxRow, "subjectType">): boolean {
  return item.subjectType === GO_LIVE_SUBJECT;
}

/** Opens the client admin's go-live item, in the client's language. */
async function askSignoff(
  tx: Tx,
  row: AgentRow,
  state: StageState,
  now: Date,
): Promise<StageState> {
  const tenantId = row.tenantId as string;
  const startedAt = state.trial?.startedAt ?? now.toISOString();
  const summary = await trialSummary(tx, row, startedAt);
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const locale = clientLanguage(t?.settings ?? {}) ?? "en";
  const words = goLiveItem(row.serviceName ?? row.name, summary, locale);
  const payload: GoLivePayload = {
    goLive: { agentId: row.id, summary, text: words.text, ask: words.ask },
  };
  const [item] = await tx
    .insert(inboxItem)
    .values({
      tenantId,
      kind: "approval",
      agentId: row.id,
      subjectType: GO_LIVE_SUBJECT,
      subjectId: row.id,
      assigneeRole: "client_admin",
      title: words.title,
      payload,
    })
    .returning({ id: inboxItem.id });
  if (!item) throw new Error("inbox insert returned nothing");
  return { ...state, signoff: { inboxItemId: item.id, askedAt: now.toISOString() } };
}

/** Expires the open go-live item when the agent leaves signoff any other way. */
async function expireSignoff(tx: Tx, row: AgentRow, state: StageState): Promise<StageState> {
  const id = state.signoff?.inboxItemId;
  if (id) {
    await tx
      .update(inboxItem)
      .set({ status: "expired", resolvedAt: new Date() })
      .where(
        and(
          eq(inboxItem.id, id),
          eq(inboxItem.tenantId, row.tenantId as string),
          eq(inboxItem.status, "open"),
        ),
      );
  }
  const { signoff: _gone, ...rest } = state;
  return rest;
}

// ── Moves ────────────────────────────────────────────────────────────────────────────────────────

/** The state an agent has on arriving at `to` (trial restarts; signoff asks; others keep). */
async function arrive(
  tx: Tx,
  row: AgentRow,
  to: AgentStage,
  state: StageState,
  actorId: string | null,
  now: Date,
): Promise<StageState> {
  let next = to === "signoff" ? state : await expireSignoff(tx, row, state);
  if (to === "trial") next = { ...next, trial: startTrial(now, actorId, state.trial) };
  if (to === "signoff" && !state.signoff) next = await askSignoff(tx, row, next, now);
  return next;
}

/**
 * After Activate passed (the agent's run status is active now): an agent on the bench starts its
 * trial, or goes straight to live with "no writes" when its live version writes nothing to a
 * client's tool; an agent resumed from a pause keeps its stage. Either way the pause is lifted.
 */
export async function afterActivate(
  tx: Tx,
  input: {
    before: AgentRow;
    actorId: string | null;
    actor: StageActor;
    ctx: RegistryContext;
    now?: Date;
  },
): Promise<AgentRow> {
  const now = input.now ?? new Date();
  const row = await lockAgent(tx, input.before.id);
  const extra = { pause: null };
  if (stageOf(input.before) !== "bench") {
    if (row.pause === null) return row;
    const [updated] = await tx.update(agent).set(extra).where(eq(agent.id, row.id)).returning();
    return updated ?? row;
  }
  const state = readStageState(row.stageState);
  const writes = await liveVersionWrites(tx, row, input.ctx);
  if (!writes) {
    const at = now.toISOString();
    return writeStage(tx, row, {
      to: "live",
      state: {
        ...state,
        skipped: [
          ...(state.skipped ?? []),
          ...stagesPassed("bench", "live").map((stage) => ({
            stage,
            reason: NO_WRITES_REASON,
            by: input.actorId,
            at,
          })),
        ],
      },
      reason: NO_WRITES_REASON,
      actorId: input.actorId,
      actor: input.actor,
      extra,
    });
  }
  return writeStage(tx, row, {
    to: "trial",
    state: await arrive(tx, row, "trial", state, input.actorId, now),
    reason: null,
    actorId: input.actorId,
    actor: input.actor,
    extra,
  });
}

/**
 * The operator moves an agent to another stage: forward needs a reason (the stages cut short are
 * logged as skipped); back doesn't. Leaving the bench needs the activation check to pass, as
 * starting a trial does; going back to the bench stops its live runs.
 */
export async function moveStage(
  tx: Tx,
  input: {
    agentId: string;
    to: AgentStage;
    reason: string | null;
    actorId: string;
    actor: StageActor;
    ctx: RegistryContext;
    now?: Date;
  },
): Promise<AgentRow> {
  const now = input.now ?? new Date();
  let row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client" || !row.tenantId) {
    throw new HttpError(422, "not_a_client_agent", "only a client agent has a stage");
  }
  if (row.testCopy) {
    throw new HttpError(422, "test_copy", "a template's test copy only test-runs");
  }
  if (row.runStatus === "retired") throw new HttpError(409, "retired", "the agent is retired");
  const from = stageOf(row) ?? "bench";
  const move = stageMove(from, input.to);
  if (move === "same") return row;
  const forward = move === "forward" || move === "skip";
  if (forward && !input.reason) {
    throw new HttpError(422, "reason_required", "say why it moves forward");
  }
  let extra: Partial<Pick<AgentRow, "runStatus" | "pause">> = {};
  if (from === "bench") {
    // Leaving the bench is starting it: the activation check must pass (§10.9).
    row = await activate(tx, { agentId: row.id, actorId: input.actorId, ctx: input.ctx });
    extra = { pause: null };
  }
  if (input.to === "bench" && (row.runStatus === "active" || row.runStatus === "paused")) {
    // DECISION: back on the bench an agent only test-runs (§10.9: run status draft or testing),
    // so its run status goes to `testing` and any pause is lifted; starting it again is Activate.
    extra = { runStatus: "testing", pause: null };
    await tx.insert(agentChange).values({
      tenantId: row.tenantId,
      agentId: row.id,
      actorId: input.actorId,
      change: { kind: "run_status", before: row.runStatus, after: "testing" },
    });
  }
  let state = readStageState(row.stageState);
  if (forward) {
    const at = now.toISOString();
    // The stage it leaves early (not the bench: the activation check stands for it) and the
    // stages it passes over.
    const cut = [...(from === "bench" ? [] : [from]), ...stagesPassed(from, input.to)];
    state = {
      ...state,
      skipped: [
        ...(state.skipped ?? []),
        ...cut.map((stage) => ({ stage, reason: input.reason as string, by: input.actorId, at })),
      ],
    };
  }
  state = await arrive(tx, row, input.to, state, input.actorId, now);
  return writeStage(tx, row, {
    to: input.to,
    state,
    reason: input.reason,
    actorId: input.actorId,
    actor: input.actor,
    extra,
  });
}

/** The operator changes the trial's minimums; logged. A trial that hasn't started keeps them. */
export async function setTrialMinimums(
  tx: Tx,
  input: {
    agentId: string;
    minDays?: number | undefined;
    minRuns?: number | undefined;
    actorId: string;
    actor: StageActor;
    now?: Date;
  },
): Promise<AgentRow> {
  const now = input.now ?? new Date();
  const row = await lockAgent(tx, input.agentId);
  if (row.kind !== "client" || !row.tenantId) {
    throw new HttpError(422, "not_a_client_agent", "only a client agent has a trial");
  }
  const state = readStageState(row.stageState);
  // DECISION: minimums set before the trial starts are kept for it (a trial on the bench that
  // hasn't started has its clock set when it does, startTrial keeping the numbers).
  const before = state.trial ?? startTrial(now, input.actorId);
  const trial = {
    ...before,
    minDays: input.minDays ?? before.minDays,
    minRuns: input.minRuns ?? before.minRuns,
    setBy: input.actorId,
  };
  const [updated] = await tx
    .update(agent)
    .set({ stageState: { ...state, trial } })
    .where(eq(agent.id, row.id))
    .returning();
  await tx.insert(agentChange).values({
    tenantId: row.tenantId,
    agentId: row.id,
    actorId: input.actorId,
    change: {
      kind: "trial",
      before: state.trial ? { minDays: before.minDays, minRuns: before.minRuns } : null,
      after: { minDays: trial.minDays, minRuns: trial.minRuns },
    },
  });
  await auditInTx(tx, null, {
    ...input.actor,
    tenantId: row.tenantId,
    action: "agent.trial",
    outcome: "ok",
    target: { agent: row.id, minDays: String(trial.minDays), minRuns: String(trial.minRuns) },
  });
  return updated ?? row;
}

// ── The hourly pass ──────────────────────────────────────────────────────────────────────────────

/**
 * Moves each running trial of this client that has met both its minimums to signoff and asks
 * the client admin. Answers the agents it moved.
 */
// DECISION: only trials of agents whose run status is active move: a paused trial gathers no runs
// and is not put before the client until it runs again.
export async function advanceTrials(tx: Tx, tenantId: string, now: Date): Promise<string[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.stage, "trial"),
        eq(agent.runStatus, "active"),
        eq(agent.testCopy, false),
        isNotNull(agent.liveVersionId),
      ),
    );
  const moved: string[] = [];
  for (const candidate of rows) {
    const state = readStageState(candidate.stageState);
    if (!state.trial) continue;
    const { runs } = await finishedLiveRuns(
      tx,
      tenantId,
      candidate.id,
      new Date(state.trial.startedAt),
    );
    if (!trialProgress(state.trial, runs, now).ready) continue;
    const row = await lockAgent(tx, candidate.id);
    if (row.stage !== "trial") continue;
    await writeStage(tx, row, {
      to: "signoff",
      state: await arrive(tx, row, "signoff", state, null, now),
      reason: "trial minimums met",
      actorId: null,
      actor: SYSTEM_ACTOR,
    });
    moved.push(row.id);
  }
  return moved;
}

/**
 * The client admin's answer on the go-live item, in the resolve transaction: approved → live;
 * rejected → back to trial with a new start, the reason kept and passed to the operator.
 */
export async function resolveGoLive(
  tx: Tx,
  input: {
    tenantId: string;
    item: InboxRow;
    approved: boolean;
    by: { userId: string; role: string };
    note?: string | undefined;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const parsed = GoLivePayload.safeParse(input.item.payload);
  const agentId = parsed.success ? parsed.data.goLive.agentId : input.item.subjectId;
  if (!agentId) throw new HttpError(409, "invalid_item", "this item names no agent");
  const row = await lockAgent(tx, agentId);
  if (row.tenantId !== input.tenantId) throw new HttpError(404, "not_found", "agent not found");
  const state = readStageState(row.stageState);
  // An item the agent has moved on from (skipped, moved back) is answered but changes nothing.
  if (row.stage !== "signoff" || state.signoff?.inboxItemId !== input.item.id) return;
  const actor: StageActor = {
    actorKind: "user",
    actorUserId: input.by.userId,
    actorRole: input.by.role,
  };
  const { signoff: _asked, ...rest } = state;
  if (input.approved) {
    await writeStage(tx, row, {
      to: "live",
      state: rest,
      reason: null,
      actorId: input.by.userId,
      actor,
      via: input.item.id,
    });
    return;
  }
  // DECISION: a rejection without a note is still a rejection; its reason reads "no reason given".
  const reason = input.note?.trim() || "no reason given";
  const next: StageState = {
    ...rest,
    trial: startTrial(now, input.by.userId, state.trial),
    rejections: [
      ...(state.rejections ?? []),
      { reason, by: input.by.userId, at: now.toISOString(), inboxItemId: input.item.id },
    ],
  };
  await writeStage(tx, row, {
    to: "trial",
    state: next,
    reason,
    actorId: input.by.userId,
    actor,
    via: input.item.id,
  });
  // TODO(W1-C): post the reason to the client's lead thread instead, once threads exist.
  await tx.insert(inboxItem).values({
    tenantId: input.tenantId,
    kind: "review",
    agentId: row.id,
    subjectType: GO_LIVE_REJECTED_SUBJECT,
    subjectId: row.id,
    assigneeRole: "operator",
    title: `The client kept ${row.name} in trial`,
    payload: { goLiveRejected: { agentId: row.id, reason, by: input.by.userId } },
  });
}

// ── The back office's view ───────────────────────────────────────────────────────────────────────

/** Where the agent is on its way live, for its back-office page. */
export async function goLiveView(
  tx: Tx,
  row: AgentRow,
  ctx: RegistryContext,
  now = new Date(),
): Promise<GoLive> {
  const stage = stageOf(row);
  const state = readStageState(row.stageState);
  let trial: GoLive["trial"] = null;
  if (state.trial && row.tenantId && stage === "trial") {
    const { runs } = await finishedLiveRuns(
      tx,
      row.tenantId,
      row.id,
      new Date(state.trial.startedAt),
    );
    trial = trialProgress(state.trial, runs, now);
  } else if (state.trial && stage !== "live") {
    trial = trialProgress(state.trial, 0, now);
  }
  let signoff: GoLive["signoff"] = null;
  if (state.signoff && row.tenantId) {
    const [item] = await tx
      .select({ status: inboxItem.status, payload: inboxItem.payload })
      .from(inboxItem)
      .where(
        and(eq(inboxItem.id, state.signoff.inboxItemId), eq(inboxItem.tenantId, row.tenantId)),
      );
    const p = GoLivePayload.safeParse(item?.payload);
    signoff = {
      inboxItemId: state.signoff.inboxItemId,
      askedAt: state.signoff.askedAt,
      status: item?.status ?? null,
      summary: p.success ? p.data.goLive.summary : null,
    };
  }
  const pause = readPause(row.pause);
  return {
    stage,
    writes: row.kind === "client" ? await liveVersionWrites(tx, row, ctx) : false,
    trial,
    signoff,
    skipped: state.skipped ?? [],
    rejections: state.rejections ?? [],
    pause: pause
      ? {
          side: pause.side,
          reason: pause.reason,
          at: pause.at,
          until: pause.until ?? null,
          all: pause.all === true,
        }
      : null,
  };
}

