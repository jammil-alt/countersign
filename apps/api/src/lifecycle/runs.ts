// Starting live runs by hand outside the operator's manual run (docs/plan.md §1.36):
// - **a past event, live** (ARCHITECTURE §10.9): the operator starts a client agent in trial,
//   signoff or live on one of its client's past events. The router's own matching decides which
//   workflows start and the run ids are the router's (uuid v5 of event, agent and workflow), so an
//   event that already started that agent starts nothing again (409 `already_ran`);
// - **Run now** (§11.5): the client admin or a signing client user starts a workflow whose manual
//   trigger has `client.canRun`, with the trigger's form, checked on the server.
// Writes behave as in any live run: behind approval, and in trial or signoff every one is signed.

import { checkAgainst } from "@countersign/agents";
import { type AgentBundle, type Role, type RunForm, uuidv7 } from "@countersign/core";
import { agent, agentChange, agentVersion, event, run, type Tx } from "@countersign/db";
import { type RoutableAgent, type RunRequest, routeEvent } from "@countersign/workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
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

async function liveBundleOf(tx: Tx, row: AgentRow): Promise<AgentBundle | null> {
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

function routable(row: AgentRow, bundle: AgentBundle | null): RoutableAgent {
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

/** The workflows of the agent's live version the client may start, with their forms. */
function clientRunnable(bundle: AgentBundle | null): RunForm[] {
  const out: RunForm[] = [];
  for (const w of bundle?.workflows ?? []) {
    if (!w.enabled) continue;
    const on = w.workflow.trigger.on;
    if (on.type !== "manual" || on.client?.canRun !== true) continue;
    out.push({ workflow: w.slug, label: on.client.label ?? w.name, input: on.input });
  }
  return out;
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
  const form = clientRunnable(bundle).find((f) => f.workflow === input.slug);
  const wf = bundle?.workflows.find((w) => w.slug === input.slug);
  if (!form || !wf || !row.liveVersionId) throw notFound("workflow");
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
      triggerId: wf.workflow.trigger.id,
      type: "manual",
      startedBy: { userId: input.userId },
    },
    payload: checked.value,
  };
  await createRunRow(tx, request);
  return request;
}
