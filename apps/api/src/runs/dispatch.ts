// The senses dispatcher and the run starter (docs/plan.md §1.2 "Senses outbox", "Starting runs").
// After a commit, each emitted event goes to the trigger router with its client's runnable agents;
// every matching workflow gets a run row and a RunWorkflow instance, both keyed by the router's
// deterministic run id, so dispatching an event twice starts nothing new. The cron sweeps up what
// the after-commit dispatch missed and starts schedule triggers. Each client is handled in its own
// withTenant() transaction: jobs act for exactly one client (ARCHITECTURE §16).

import { AgentsError, createRun, type Emit, rollupUsageDays, utcDay } from "@countersign/agents";
import { clientHolidays } from "@countersign/core";
import { agent, agentVersion, type Db, type Tx, tenant, withTenant } from "@countersign/db";
import {
  claimUndispatched,
  type EmittedEvents,
  type EventRow,
  type EventTypeRegistry,
  emit,
  markDispatched,
  releaseDispatched,
} from "@countersign/senses";
import {
  dueSchedules,
  type RoutableAgent,
  type RunRequest,
  routeEvent,
  type StepRunner,
} from "@countersign/workflows";
import { and, eq, isNotNull } from "drizzle-orm";
import { matchRepliesIn, wakeAll } from "../reach/replies";
// v0.12 W2-E
import { countLimited, overLimit } from "../triggers/limits";
import { senderLookup } from "../triggers/senders";
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
  /** The code service's alerts for one client become inbox items; absent without `CODES`. */
  codesTick?: (tenantId: string, at: Date) => Promise<unknown>;
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

// v0.12 W1-H: dispatch right after commit (ARCHITECTURE §8, docs/plan.md §1.43). ────────────────

/** Which of a client's undispatched events a dispatch claims. */
export type DispatchPick =
  | { ids: readonly string[] }
  /** The sweep: events left for 30 s (the after-commit dispatch had its chance). */
  | { olderThanSeconds: number }
  /** A pass's own fresh events, when it can't name them (the cron's tenant pass). */
  | { newerThanSeconds: number };

/**
 * Claims one client's events, routes them and stamps them, in one transaction; starts their runs
 * once it commits. The claim is a row lock that other dispatchers skip, and the stamp commits with
 * the run rows and the replies matched, so an event is dispatched once even when the after-commit
 * dispatch and the sweep reach it together. A run whose instance can't start gives its event back
 * (unstamped) to the sweep; starting it again is safe (deterministic run ids). Returns how many
 * events it dispatched.
 */
// DECISION: the claim is a row lock held by the dispatching transaction (`for update skip
// locked`), not a lease column: no migration, and a dispatcher that dies before committing leaves
// the events as they were for the sweep. Instances start after the commit, as before, so a run's
// row exists before its instance reads it.
export async function dispatchTenant(
  deps: DispatchDeps,
  tenantId: string,
  pick: DispatchPick,
): Promise<number> {
  const claimed = await withTenant(deps.db, tenantId, async (tx) => {
    const events = await claimUndispatched(tx, pick);
    if (events.length === 0) return null;
    // Replies and opt-outs end the reach-outs they answer first, so a run woken by one sees it.
    const woken = await matchRepliesIn(tx, tenantId, events, new Date());
    const agents = await routableAgents(tx, tenantId);
    const starts: { eventId: string; request: RunRequest }[] = [];
    for (const event of events) {
      const { runs, problems } = await routeEvent(
        { id: event.id, tenantId, type: event.type, payload: event.payload },
        agents,
        // v0.12 W2-E: message triggers read the sender from the client's People.
        { sender: senderLookup(tx, tenantId) },
      );
      for (const p of problems) console.warn("trigger could not be evaluated", p);
      for (const request of runs) {
        // v0.12 W2-E: a webhook trigger's rate limit, counted from that trigger's runs.
        if (request.limit && (await overLimit(tx, request))) {
          await countLimited(tx, tenantId, request.limit);
          continue;
        }
        try {
          await createRunRow(tx, request);
        } catch (error) {
          // The agent was paused between routing and starting: nothing to start (createRun
          // refuses before it writes, so the transaction goes on).
          if (error instanceof AgentsError && error.code === "invalid_state") continue;
          throw error;
        }
        starts.push({ eventId: event.id, request });
      }
    }
    await markDispatched(
      tx,
      events.map((e) => e.id),
    );
    return { events, woken, starts };
  });
  if (!claimed) return 0;
  const failed = new Set<string>();
  for (const { eventId, request } of claimed.starts) {
    try {
      await deps.instances.start(request);
    } catch (error) {
      failed.add(eventId);
      console.error(`starting run ${request.runId} failed; the sweep tries again`, error);
    }
  }
  await wakeAll(deps.instances, claimed.woken);
  if (failed.size > 0) {
    await withTenant(deps.db, tenantId, (tx) => releaseDispatched(tx, [...failed]));
  }
  return claimed.events.length;
}

/** Dispatches one client's committed events by id; a failure is logged and left to the sweep. */
export async function dispatchByIds(
  deps: DispatchDeps,
  tenantId: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  try {
    return await dispatchTenant(deps, tenantId, { ids });
  } catch (error) {
    console.error(`dispatch for client ${tenantId} failed`, error);
    return 0;
  }
}

/**
 * Dispatches events a caller collected (any clients), each client in its own scope. Only what
 * committed and is still undispatched goes: the rows are read again under the claim, so an event
 * from a transaction that rolled back, or one already dispatched, starts nothing.
 */
export async function dispatchEvents(
  deps: DispatchDeps,
  events: readonly Pick<EventRow, "id" | "tenantId">[],
): Promise<void> {
  const byTenant = new Map<string, string[]>();
  for (const e of events) byTenant.set(e.tenantId, [...(byTenant.get(e.tenantId) ?? []), e.id]);
  for (const [tenantId, ids] of byTenant) await dispatchByIds(deps, tenantId, ids);
}

/**
 * The after-commit helper for work outside a request's handler (background reading, a sync step,
 * a run's step, the cron): dispatches the ids collected (`EmittedEvents`) once the work's
 * transaction has committed, handed to `waitUntil` when one is given. Resolves when done.
 */
export function dispatchAfterCommit(
  deps: DispatchDeps,
  tenantId: string,
  collected: EmittedEvents,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<number> {
  const done = dispatchByIds(deps, tenantId, collected.take());
  waitUntil?.(done);
  return done;
}

/**
 * A run's step runner that dispatches the events its steps emitted right after each step (and
 * before it waits or sleeps), not only when the run ends (ARCHITECTURE §8). The rows are collected
 * by the runtime (`emitted`); a step replayed from storage emits nothing, and an event dispatched
 * already is skipped, so a replay starts nothing twice.
 */
export function dispatchingRunner(
  runner: StepRunner,
  deps: DispatchDeps | null,
  emitted: EventRow[],
): StepRunner {
  if (!deps) return runner;
  const flush = async () => {
    if (emitted.length > 0) await dispatchEvents(deps, emitted.splice(0));
  };
  return {
    async do(name, fn, config) {
      const out = await runner.do(name, fn, config);
      await flush();
      return out;
    },
    async waitForEvent(name, options) {
      await flush();
      return runner.waitForEvent(name, options);
    },
    async sleep(name, duration) {
      await flush();
      return runner.sleep(name, duration);
    },
  };
}

/** How old an undispatched event is before the cron's sweep takes it. */
export const SWEEP_AFTER_SECONDS = 30;

/** The minute of each hour the cron rolls usage up (runs still waiting have no finish to do it). */
// DECISION: hourly, for today and yesterday (UTC): finished runs roll their own days up at once;
// the sweep keeps a waiting run's steps and the actions approved later in usage within the hour.
export const USAGE_SWEEP_MINUTE = 7;

/** The days the hourly sweep recomputes: yesterday and today, in UTC. */
export function usageSweepDays(at: Date): string[] {
  const yesterday = new Date(at.getTime() - 86_400_000);
  return [utcDay(yesterday), utcDay(at)];
}

/** Every client: the cron has no session, so it walks clients one at a time. */
async function allClients(db: Db): Promise<{ id: string; timezone: string; settings: unknown }[]> {
  // v0.12 W2-E: settings, for the client's own holidays.
  return db
    .select({ id: tenant.id, timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant);
}

/**
 * The cron (every minute): re-dispatch events left undispatched for 30 s, start the schedule
 * triggers due in (previous tick, this tick], and re-send resolutions waiting runs have not taken.
 * Once an hour it also rolls usage up for today and yesterday (USAGE_SWEEP_MINUTE).
 */
export async function cronTick(deps: DispatchDeps, scheduledTime: Date): Promise<void> {
  const clients = await allClients(deps.db);
  const to = new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000);
  const from = new Date(to.getTime() - 60_000);
  for (const client of clients) {
    try {
      // The sweep: what the after-commit dispatches left (30 s and older).
      await dispatchTenant(deps, client.id, { olderThanSeconds: SWEEP_AFTER_SECONDS });
      const agents = await withTenant(deps.db, client.id, (tx) => routableAgents(tx, client.id));
      const { runs, problems } = await dueSchedules({
        agents,
        timezones: { [client.id]: client.timezone },
        from,
        to,
        // v0.12 W2-E: `skipHolidays` skips the client's own dates too.
        holidays: { [client.id]: clientHolidays(client.settings) },
      });
      for (const p of problems) console.warn("schedule could not be evaluated", p);
      for (const request of runs) await startRun(deps, request);
      await redeliverResolutions(deps, client.id, scheduledTime);
      if (to.getUTCMinutes() === USAGE_SWEEP_MINUTE) {
        await withTenant(deps.db, client.id, (tx) =>
          rollupUsageDays(tx, { tenantId: client.id, days: usageSweepDays(to) }),
        );
      }
      if (deps.reachTick) await deps.reachTick(client.id, scheduledTime);
      if (deps.codesTick) await deps.codesTick(client.id, scheduledTime);
      // v0.12 W1-H: what this pass emitted (reach-outs, code alerts, usage) goes now, not a tick
      // later.
      // DECISION: the cron's tenant pass opens its transactions in many places, so at its end it
      // claims the client's events of the last minute rather than collecting ids; older ones are
      // the sweep's, and the claim keeps a concurrent dispatch from taking any twice.
      await dispatchTenant(deps, client.id, { newerThanSeconds: 60 });
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
