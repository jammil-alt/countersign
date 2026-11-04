// The senses dispatcher and the run starter (docs/plan.md §1.2 "Senses outbox", "Starting runs").
// After a commit, each emitted event goes to the trigger router with its client's runnable agents;
// every matching workflow gets a run row and a RunWorkflow instance, both keyed by the router's
// deterministic run id, so dispatching an event twice starts nothing new. The cron sweeps up what
// the after-commit dispatch missed and starts schedule triggers. Each client is handled in its own
// withTenant() transaction: jobs act for exactly one client (ARCHITECTURE §16).

import { AgentsError, createRun, type Emit } from "@countersign/agents";
import { agent, agentVersion, type Db, type Tx, tenant, withTenant } from "@countersign/db";
import {
  type EventRow,
  type EventTypeRegistry,
  emit,
  markDispatched,
  undispatched,
} from "@countersign/senses";
import {
  dueSchedules,
  type RoutableAgent,
  type RunRequest,
  routeEvent,
} from "@countersign/workflows";
import { and, eq, isNotNull } from "drizzle-orm";
import { matchReplies, wakeAll } from "../reach/replies";
import type { RunInstances } from "./instances";
import { redeliverResolutions } from "./resume";

export interface DispatchDeps {
  db: Db;
  instances: RunInstances;
  /**
   * Reach-outs' escalation and timeouts for one client, each cron tick (it needs the runtime to
   * send); without it, replies still end reach-outs but nothing escalates.
   */
  reachTick?: (tenantId: string, at: Date) => Promise<unknown>;
}

/** A client's agents with their live bundles: what the router chooses from. */
export async function routableAgents(tx: Tx, tenantId: string): Promise<RoutableAgent[]> {
  const rows = await tx
    .select({ a: agent, bundle: agentVersion.bundle })
    .from(agent)
    .innerJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.runStatus, "active"),
        isNotNull(agent.liveVersionId),
      ),
    );
  return rows.map(({ a, bundle }) => ({
    id: a.id,
    tenantId: a.tenantId,
    kind: a.kind,
    status: a.status,
    runStatus: a.runStatus,
    liveVersionId: a.liveVersionId,
    liveBundle: bundle,
  }));
}

/** Writes the run row (idempotent by id) in the caller's transaction. */
export async function createRunRow(tx: Tx, request: RunRequest): Promise<void> {
  await createRun(tx, {
    id: request.runId,
    tenantId: request.tenantId,
    agentId: request.agentId,
    agentVersionId: request.agentVersionId,
    workflowSlug: request.workflowSlug,
    mode: request.mode,
    trigger: { ...request.trigger, payload: request.payload } as Record<string, unknown>,
  });
}

/** Creates the run row, then its instance. Safe to call twice for the same request. */
export async function startRun(deps: DispatchDeps, request: RunRequest): Promise<void> {
  try {
    await withTenant(deps.db, request.tenantId, (tx) => createRunRow(tx, request));
  } catch (error) {
    // The agent was paused between routing and starting: nothing to start.
    if (error instanceof AgentsError && error.code === "invalid_state") return;
    throw error;
  }
  await deps.instances.start(request);
}

/** Routes one client's events, starts their runs, and stamps them dispatched. */
async function dispatchTenant(
  deps: DispatchDeps,
  tenantId: string,
  events: readonly EventRow[],
): Promise<void> {
  // Replies and opt-outs end the reach-outs they answer first, so a run woken by one sees it.
  const woken = await matchReplies(deps.db, tenantId, events, new Date());
  await wakeAll(deps.instances, woken);
  const agents = await withTenant(deps.db, tenantId, (tx) => routableAgents(tx, tenantId));
  for (const event of events) {
    if (event.tenantId !== tenantId) continue;
    const { runs, problems } = await routeEvent(
      { id: event.id, tenantId, type: event.type, payload: event.payload },
      agents,
    );
    for (const p of problems) console.warn("trigger could not be evaluated", p);
    for (const request of runs) await startRun(deps, request);
  }
  await withTenant(deps.db, tenantId, (tx) =>
    markDispatched(
      tx,
      events.map((e) => e.id),
    ),
  );
}

/** Dispatches events (any clients), each client in its own scope. */
export async function dispatchEvents(deps: DispatchDeps, events: readonly EventRow[]) {
  const byTenant = new Map<string, EventRow[]>();
  for (const e of events) byTenant.set(e.tenantId, [...(byTenant.get(e.tenantId) ?? []), e]);
  for (const [tenantId, rows] of byTenant) {
    try {
      await dispatchTenant(deps, tenantId, rows);
    } catch (error) {
      // Left undispatched: the cron sweep tries again.
      console.error(`dispatch for client ${tenantId} failed`, error);
    }
  }
}

/** Every client: the cron has no session, so it walks clients one at a time. */
async function allClients(db: Db): Promise<{ id: string; timezone: string }[]> {
  return db.select({ id: tenant.id, timezone: tenant.timezone }).from(tenant);
}

/**
 * The cron (every minute): re-dispatch events left undispatched for 30 s, start the schedule
 * triggers due in (previous tick, this tick], and re-send resolutions waiting runs have not taken.
 */
export async function cronTick(deps: DispatchDeps, scheduledTime: Date): Promise<void> {
  const clients = await allClients(deps.db);
  const to = new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000);
  const from = new Date(to.getTime() - 60_000);
  for (const client of clients) {
    try {
      const events = await withTenant(deps.db, client.id, (tx) => undispatched(tx));
      if (events.length > 0) await dispatchTenant(deps, client.id, events);
      const agents = await withTenant(deps.db, client.id, (tx) => routableAgents(tx, client.id));
      const { runs, problems } = await dueSchedules({
        agents,
        timezones: { [client.id]: client.timezone },
        from,
        to,
      });
      for (const p of problems) console.warn("schedule could not be evaluated", p);
      for (const request of runs) await startRun(deps, request);
      await redeliverResolutions(deps, client.id, scheduledTime);
      if (deps.reachTick) await deps.reachTick(client.id, scheduledTime);
    } catch (error) {
      console.error(`cron for client ${client.id} failed`, error);
    }
  }
}

// ── Emitting from packages/agents ────────────────────────────────────────────────────────────────

/**
 * packages/agents emits through an injected `Emit` (it may not import senses); this inserts the
 * events into the outbox in the same transaction, where senses checks each payload against its
 * event type. Emitted rows are collected so the caller can dispatch them after the commit.
 */
export function senseEmitter(
  registry: EventTypeRegistry,
  options: { collect?: EventRow[]; testRun?: boolean } = {},
): Emit {
  return async (tx, tenantId, e) => {
    const payload = e.payload as Record<string, unknown>;
    const row = await emit(
      tx,
      { tenantId, type: e.type, subjectType: e.subjectType, subjectId: e.subjectId, payload },
      { registry, ...(options.testRun ? { testRun: true } : {}) },
    );
    if (row) options.collect?.push(row);
  };
}
