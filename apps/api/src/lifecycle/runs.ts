// Starting live runs by hand outside the operator's manual run (docs/plan.md §1.36):
// - **a past event, live** (ARCHITECTURE §10.9): the operator starts a client agent in trial,
//   signoff or live on one of its client's past events. The router's own matching decides which
//   workflows start and the run ids are the router's (uuid v5 of event, agent and workflow), so an
//   event that already started that agent starts nothing again (409 `already_ran`);
// - **Run now** (§11.5): the client admin or a signing client user starts a workflow whose manual
//   trigger has `client.canRun`, with the trigger's form, checked on the server.
// Writes behave as in any live run: behind approval, and in trial or signoff every one is signed.

import { checkAgainst } from "@countersign/agents";
import {
  type AnyAgentBundle,
  allTriggers,
  isUuid,
  type Role,
  type RunForm,
  uuidv7,
} from "@countersign/core";
import { agent, agentChange, agentVersion, event, run, type Tx } from "@countersign/db";
import { type RoutableAgent, type RunRequest, routeEvent } from "@countersign/workflows";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { withCanSign } from "../inbox";
import { createRunRow } from "../runs/dispatch";
import { type AgentRow, stageOf } from "./stages";

const RUNNING_STAGES = new Set(["trial", "signoff", "live"]);

async function clientAgent(tx: Tx, tenantId: string, agentId: string): Promise<AgentRow> {
  const [row] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.id, agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
  if (!row || row.testCopy || row.status !== "active") throw notFound("agent");
  return row;
}

export async function liveBundleOf(tx: Tx, row: AgentRow): Promise<AnyAgentBundle | null> {
  if (!row.liveVersionId) return null;
  const [v] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(
      and(
        eq(agentVersion.id, row.liveVersionId),
        eq(agentVersion.tenantId, row.tenantId as string),
      ),
    );
  return v?.bundle ?? null;
}

function routable(row: AgentRow, bundle: AnyAgentBundle | null): RoutableAgent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    status: row.status,
    runStatus: row.runStatus,
    liveVersionId: row.liveVersionId,
    liveBundle: bundle,
  };
}

/** Refuses an agent that isn't running live: on the bench, paused, retired or not activated. */
function ensureRunsLive(row: AgentRow): void {
  if (!RUNNING_STAGES.has(stageOf(row) ?? "")) {
    throw new HttpError(409, "not_live", "the agent is on the bench: start its trial first");
  }
  if (row.runStatus !== "active") {
    throw new HttpError(409, "not_running", `the agent is ${row.runStatus ?? "not activated"}`);
  }
}

/**
 * The live runs of `agentId` on one of its client's past events, written in the caller's
 * transaction; start their instances after the commit.
 */
export async function runOnEvent(
  tx: Tx,
  input: { tenantId: string; agentId: string; eventId: string; userId: string },
): Promise<RunRequest[]> {
  const row = await clientAgent(tx, input.tenantId, input.agentId);
  ensureRunsLive(row);
  const [e] = await tx
    .select()
    .from(event)
    .where(and(eq(event.id, input.eventId), eq(event.tenantId, input.tenantId)));
  if (!e) throw notFound("event");
  // Never a test run's event (the picker leaves them out too: ops-events.ts).
  const payload = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof payload.runId === "string") {
    const [r] = await tx
      .select({ mode: run.mode })
      .from(run)
      .where(and(eq(run.tenantId, input.tenantId), sql`${run.id}::text = ${payload.runId}`));
    if (r?.mode === "test") {
      throw new HttpError(422, "test_event", "a test run's event never starts a live run");
    }
  }
  const bundle = await liveBundleOf(tx, row);
  const { runs, problems } = await routeEvent(
    { id: e.id, tenantId: e.tenantId, type: e.type, payload: e.payload },
    [routable(row, bundle)],
  );
  if (runs.length === 0) {
    const why = problems[0]?.message;
    throw new HttpError(
      422,
      "no_workflow",
      why
        ? `the event could not be matched: ${why}`
        : `no workflow of this agent starts on ${e.type} with this event`,
    );
  }
  const existing = await tx
    .select({ id: run.id })
    .from(run)
    .where(
      and(
        eq(run.tenantId, input.tenantId),
        inArray(
          run.id,
          runs.map((r) => r.runId),
        ),
      ),
    );
  if (existing.length > 0) {
    throw new HttpError(409, "already_ran", "this event already started this agent");
  }
  const requests = runs.map(
    (r): RunRequest =>
      r.trigger.type === "event"
        ? { ...r, trigger: { ...r.trigger, replayedBy: input.userId } }
        : r,
  );
  for (const r of requests) await createRunRow(tx, r);
  await tx.insert(agentChange).values({
    tenantId: input.tenantId,
    agentId: row.id,
    actorId: input.userId,
    change: {
      kind: "run_event",
      eventId: e.id,
      eventType: e.type,
      runIds: requests.map((r) => r.runId),
    },
  });
  return requests;
}

// ── Audit 4.2: events that came in while the agent was paused ──────────────────────────────────

/** How far back a pause's events are looked for. */
export const MISSED_LOOK_BACK_MS = 30 * 24 * 60 * 60_000;
/** The most events of a pause read at once (oldest first); `more` says when there were others. */
export const MISSED_SCAN_MAX = 2000;
/** The most of them one "run them now" starts. */
export const MISSED_RUN_MAX = 50;

/** Whether an `agent_change` paused the agent, resumed it, or neither. */
function pauseEdge(change: unknown): "pause" | "resume" | null {
  const c = (change ?? {}) as { kind?: unknown; before?: unknown; after?: unknown };
  if (c.kind === "pause") return "pause";
  if (c.kind === "resume") return "resume";
  if (c.kind === "run_status" && c.after === "paused") return "pause";
  if (c.kind === "run_status" && c.before === "paused" && c.after === "active") return "resume";
  return null;
}

/**
 * The agent's last pause that has ended: from its pause to its resume, as `agent_change` records
 * them (the client's or the operator's pause, the cron's resume at a pause's end, Activate).
 */
export async function lastPause(
  tx: Tx,
  row: AgentRow,
  now: Date,
): Promise<{ from: Date; to: Date } | null> {
  if (row.runStatus !== "active") return null;
  const changes = await tx
    .select({ change: agentChange.change, at: agentChange.createdAt })
    .from(agentChange)
    .where(
      and(
        eq(agentChange.tenantId, row.tenantId as string),
        eq(agentChange.agentId, row.id),
        gte(agentChange.createdAt, new Date(now.getTime() - MISSED_LOOK_BACK_MS)),
      ),
    )
    .orderBy(desc(agentChange.createdAt), desc(agentChange.id));
  let to: Date | null = null;
  for (const c of changes) {
    const edge = pauseEdge(c.change);
    if (!to) {
      if (edge === "resume") to = c.at;
      else if (edge === "pause") return null;
      continue;
    }
    if (edge === "pause") return { from: c.at, to };
  }
  // Resumed in the look-back, paused before it: the look-back's start.
  return to ? { from: new Date(now.getTime() - MISSED_LOOK_BACK_MS), to } : null;
}

export interface MissedEvents {
  from: Date;
  to: Date;
  /** Events of the pause that would have started this agent, and haven't: oldest first. */
  events: (typeof event.$inferSelect)[];
  /** More events came in during the pause than were read (MISSED_SCAN_MAX). */
  more: boolean;
}

/**
 * The events that came in during the agent's last pause (within MISSED_LOOK_BACK_MS) that its
 * live version's triggers match, by the router's own matching, and that started no run of it.
 * Never a test run's event. Null when the agent doesn't run live now or had no pause.
 */
// DECISION (audit 4.2): they are only counted and offered, never started on resume: whoever paused
// it had a reason. "Run them now" is the past-event path (`runOnEvent`) for each, so run ids are
// the router's and running them twice starts nothing.
export async function missedWhilePaused(
  tx: Tx,
  row: AgentRow,
  now = new Date(),
): Promise<MissedEvents | null> {
  if (!RUNNING_STAGES.has(stageOf(row) ?? "") || row.runStatus !== "active") return null;
  const tenantId = row.tenantId as string;
  const pause = await lastPause(tx, row, now);
  if (!pause) return null;
  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.tenantId, tenantId),
        gte(event.createdAt, pause.from),
        lte(event.createdAt, pause.to),
      ),
    )
    .orderBy(asc(event.createdAt), asc(event.id))
    .limit(MISSED_SCAN_MAX + 1);
  const more = rows.length > MISSED_SCAN_MAX;
  const scanned = rows.slice(0, MISSED_SCAN_MAX);
  const testRuns = new Set(
    (
      await testRunsNamed(
        tx,
        tenantId,
        scanned.map((e) => (e.payload as { runId?: unknown } | null)?.runId),
      )
    ).map((r) => r.id),
  );
  const agentAsRouted = routable(row, await liveBundleOf(tx, row));
  const candidates: { e: (typeof scanned)[number]; runIds: string[] }[] = [];
  for (const e of scanned) {
    const runId = (e.payload as { runId?: unknown } | null)?.runId;
    if (typeof runId === "string" && testRuns.has(runId)) continue;
    const { runs } = await routeEvent(
      { id: e.id, tenantId: e.tenantId, type: e.type, payload: e.payload },
      [agentAsRouted],
    );
    if (runs.length > 0) candidates.push({ e, runIds: runs.map((r) => r.runId) });
  }
  const allIds = candidates.flatMap((c) => c.runIds);
  const ran = new Set<string>();
  for (let i = 0; i < allIds.length; i += 500) {
    const existing = await tx
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.tenantId, tenantId), inArray(run.id, allIds.slice(i, i + 500))));
    for (const r of existing) ran.add(r.id);
  }
  return {
    from: pause.from,
    to: pause.to,
    events: candidates.filter((c) => c.runIds.some((id) => !ran.has(id))).map((c) => c.e),
    more,
  };
}

/** The test runs among `ids` (payloads' `runId`s): their events never start a live run. */
async function testRunsNamed(tx: Tx, tenantId: string, ids: unknown[]) {
  const named = [...new Set(ids.filter((v): v is string => typeof v === "string" && isUuid(v)))];
  if (named.length === 0) return [];
  return tx
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.tenantId, tenantId), inArray(run.id, named), eq(run.mode, "test")));
}

/**
 * "Run them now": the live runs of the agent on the events its last pause held back, oldest
 * first, at most MISSED_RUN_MAX, each through the past-event path in its own savepoint (an event
 * that already started it, or no longer matches, is passed over). Start the instances after the
 * commit. `left` is how many are still waiting after these.
 */
export async function runMissedEvents(
  tx: Tx,
  input: { tenantId: string; agentId: string; userId: string; now?: Date },
): Promise<{ requests: RunRequest[]; left: number }> {
  const row = await clientAgent(tx, input.tenantId, input.agentId);
  ensureRunsLive(row);
  const missed = await missedWhilePaused(tx, row, input.now);
  const events = missed?.events ?? [];
  const requests: RunRequest[] = [];
  for (const e of events.slice(0, MISSED_RUN_MAX)) {
    try {
      requests.push(
        ...(await tx.transaction((sp) =>
          runOnEvent(sp, {
            tenantId: input.tenantId,
            agentId: input.agentId,
            eventId: e.id,
            userId: input.userId,
          }),
        )),
      );
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
  }
  return { requests, left: Math.max(0, events.length - MISSED_RUN_MAX) };
}

/**
 * A workflow's first trigger. R9: a v4 process (a template's v4 version, or its fork) lists its
 * triggers in `triggers`, so its first is read the same way.
 */
const firstTrigger = (w: AnyAgentBundle["workflows"][number]) => allTriggers(w.workflow)[0];

/** The workflows of the agent's live version the client may start, with their forms. */
function clientRunnable(bundle: AnyAgentBundle | null): RunForm[] {
  const out: RunForm[] = [];
  for (const w of bundle?.workflows ?? []) {
    if (!w.enabled) continue;
    const on = firstTrigger(w)?.on;
    if (on?.type !== "manual" || on.client?.canRun !== true) continue;
    out.push({ workflow: w.slug, label: on.client.label ?? w.name, input: on.input });
  }
  return out;
}

/**
 * The agent starts from documents: an enabled workflow of its live bundle has a `document.*` event
 * among its triggers (an invoice read, a file uploaded). The portal's agent page offers upload for it.
 */
// DECISION (owner, 2026-11-11): any trigger counts, not only the first. AP bill clerk starts by
// hand first and on "a document arrives" second, and its page hid the upload and forwarding card.
export function readsDocuments(bundle: AnyAgentBundle | null): boolean {
  return (bundle?.workflows ?? []).some(
    (w) =>
      w.enabled &&
      allTriggers(w.workflow).some(
        (t) => t.on.type === "event" && t.on.event.startsWith("document."),
      ),
  );
}

/**
 * The workflow Run now starts, its form and the trigger it starts on (its first, which
 * `clientRunnable` read the form from). A workflow with no trigger is refused rather than started
 * with an empty trigger id; one the client may not start is not found.
 */
// DECISION (wave 3b): 422 `no_trigger` for a workflow with no trigger (a stored draft can hold
// one, though publishing refuses it), so no run is ever recorded without the trigger it started on.
export function startable(
  bundle: AnyAgentBundle | null,
  slug: string,
): { wf: AnyAgentBundle["workflows"][number]; form: RunForm; trigger: { id: string } } {
  const wf = bundle?.workflows.find((w) => w.slug === slug);
  if (!wf) throw notFound("workflow");
  const trigger = firstTrigger(wf);
  if (!trigger) throw new HttpError(422, "no_trigger", "this workflow has no trigger to start on");
  const form = clientRunnable(bundle).find((f) => f.workflow === slug);
  if (!form) throw notFound("workflow");
  return { wf, form, trigger };
}

/** Run now's forms: none unless the agent runs live (trial, signoff or live, and active). */
export async function runForms(tx: Tx, tenantId: string, agentId: string): Promise<RunForm[]> {
  const row = await clientAgent(tx, tenantId, agentId);
  if (!RUNNING_STAGES.has(stageOf(row) ?? "") || row.runStatus !== "active") return [];
  return clientRunnable(await liveBundleOf(tx, row));
}

/** Starts a client-runnable workflow with the person's form; checked against the trigger's schema. */
export async function runNow(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    slug: string;
    input: unknown;
    userId: string;
    role: Role;
  },
): Promise<RunRequest> {
  // v0.12 W1-D: only people who sign start a run (docs/plan.md §1.36 "Run now").
  // DECISION: a viewer still lists the forms (they see everything) but starting one is 403
  // `cannot_sign`, as on the Desk; the membership is read here, not in the session.
  const who = await withCanSign(tx, input.tenantId, { userId: input.userId, role: input.role });
  if (who.canSign === false) {
    throw new HttpError(
      403,
      "cannot_sign",
      "you can see this, but you don't approve for your team",
    );
  }
  const row = await clientAgent(tx, input.tenantId, input.agentId);
  ensureRunsLive(row);
  const bundle = await liveBundleOf(tx, row);
  const { wf, form, trigger } = startable(bundle, input.slug);
  if (!row.liveVersionId) throw notFound("workflow");
  // The same JSON Schema reader the runtime checks skills and tools with (invariant 5).
  const checked = checkAgainst(form.input, input.input ?? {});
  if (!checked.ok) throw new HttpError(422, "invalid_input", checked.message);
  const request: RunRequest = {
    runId: uuidv7(),
    tenantId: input.tenantId,
    agentId: row.id,
    agentVersionId: row.liveVersionId,
    workflowSlug: wf.slug,
    mode: "live",
    trigger: {
      triggerId: trigger.id,
      type: "manual",
      startedBy: { userId: input.userId },
    },
    payload: checked.value,
  };
  await createRunRow(tx, request);
  return request;
}
