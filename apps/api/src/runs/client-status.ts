// A run as the client sees it (QA round 1, docs/plan.md §1.37): one definition every portal route
// counts and labels runs by, so the Table, an agent's page, Runs and Reports agree.
//
// A workflow run that waits on a person keeps `run.status = 'running'` (its step is `waiting` and
// an open Desk item holds it), so the stored status alone would show it as Running. Here a run
// that is still going and has an open item for someone of the client "waits on you"; it is never
// counted or shown as running. Time spent waiting on the client is kept apart from working time.
import type { ActivityReport, RunsPerDay } from "@countersign/core";
import { inboxItem, run, type Tx } from "@countersign/db";
import { and, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";

/** Stored statuses of a run that may still change. */
export const OPEN_RUN = ["queued", "running", "waiting"] as const;

/** A Desk item for someone of the client: anything not routed to the operator. */
export function forClient(): SQL {
  return or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")) as SQL;
}

// DECISION: "waits on you" is the client's, not the reader's: a run with an open item for any
// person of the client waits on the client (snoozed or not), whoever is looking. The Desk's own
// list and count stay the reader's. A run waiting on us (an operator item) stays "running".
/** The run (`run` in the query) has an open Desk item for the client. */
export const waitsOnClient: SQL = sql`exists (select 1 from ${inboxItem} where ${inboxItem.runId} = ${run.id} and ${inboxItem.tenantId} = ${run.tenantId} and ${inboxItem.status} = 'open' and (${inboxItem.assigneeRole} is null or ${inboxItem.assigneeRole} <> 'operator'))`;

/** The client's states of a run: the five the portal shows. */
export type ClientRunState = "running" | "waiting" | "done" | "failed" | "stopped";

/** A run's client state as SQL, for grouping and per-day buckets. */
export const clientState: SQL<ClientRunState> = sql<ClientRunState>`case
  when ${run.status} = 'succeeded' then 'done'
  when ${run.status} = 'failed' then 'failed'
  when ${run.status} = 'cancelled' then 'stopped'
  when ${run.status} = 'waiting' or ${waitsOnClient} then 'waiting'
  else 'running' end`;

/**
 * The portal's run status filter in the client's states: `waiting` is any run waiting on the
 * client (whatever its stored status), `queued` and `running` only those that don't.
 */
export function clientStatusWhere(statuses: readonly string[] | undefined): SQL[] {
  if (!statuses?.length) return [];
  const parts: SQL[] = [];
  const going = statuses.filter((s) => s === "queued" || s === "running");
  if (going.length) {
    parts.push(
      and(inArray(run.status, going as ("queued" | "running")[]), sql`not ${waitsOnClient}`) as SQL,
    );
  }
  if (statuses.includes("waiting")) {
    parts.push(
      or(
        eq(run.status, "waiting"),
        and(inArray(run.status, ["queued", "running"]), waitsOnClient),
      ) as SQL,
    );
  }
  const ended = statuses.filter((s) => s === "succeeded" || s === "failed" || s === "cancelled");
  if (ended.length) {
    parts.push(inArray(run.status, ended as ("succeeded" | "failed" | "cancelled")[]));
  }
  return [parts.length ? (or(...parts) as SQL) : sql`false`];
}

type Runs = ActivityReport["runs"];

export const noRuns = (): Runs => ({
  total: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  waiting: 0,
  going: 0,
});

/** Adds `n` runs in a client state to a count. */
export function countState(into: Runs, state: string, n: number): void {
  into.total += n;
  if (state === "done") into.succeeded += n;
  else if (state === "failed") into.failed += n;
  else if (state === "stopped") into.cancelled += n;
  else if (state === "waiting") into.waiting += n;
  else into.going += n;
}

// DECISION: a run belongs to the period it started in (its row's creation), everywhere a client
// sees a count: the Table's week, an agent's month, Reports' range and the runs per day. A run
// started this week and still waiting is counted this week as waiting, not left out.
/** A moment as SQL, for `runCounts`' bounds. */
export const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/**
 * A client's live runs started in `[lo, hi)`, counted by client state: in all and per agent.
 * `where` narrows (an agent).
 */
export async function runCounts(
  tx: Tx,
  tenantId: string,
  period: { lo: SQL; hi: SQL },
  where: SQL[] = [],
): Promise<{ all: Runs; byAgent: Map<string, Runs> }> {
  const rows = await tx
    .select({ agentId: run.agentId, state: clientState, n: sql<number>`count(*)::int` })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.mode, "live"),
        sql`${run.createdAt} >= ${period.lo}`,
        sql`${run.createdAt} < ${period.hi}`,
        ...where,
      ),
    )
    .groupBy(run.agentId, clientState);
  const all = noRuns();
  const byAgent = new Map<string, Runs>();
  for (const r of rows) {
    countState(all, r.state, Number(r.n));
    const mine = byAgent.get(r.agentId) ?? noRuns();
    countState(mine, r.state, Number(r.n));
    byAgent.set(r.agentId, mine);
  }
  return { all, byAgent };
}

/** What each agent of a client has going now: runs working, and runs waiting on the client. */
export async function openRunsByAgent(
  tx: Tx,
  tenantId: string,
): Promise<Map<string, { running: number; waitingOnYou: number }>> {
  const rows = await tx
    .select({ agentId: run.agentId, state: clientState, n: sql<number>`count(*)::int` })
    .from(run)
    .where(and(eq(run.tenantId, tenantId), eq(run.mode, "live"), inArray(run.status, OPEN_RUN)))
    .groupBy(run.agentId, clientState);
  const out = new Map<string, { running: number; waitingOnYou: number }>();
  for (const r of rows) {
    const e = out.get(r.agentId) ?? { running: 0, waitingOnYou: 0 };
    if (r.state === "waiting") e.waitingOnYou += Number(r.n);
    else e.running += Number(r.n);
    out.set(r.agentId, e);
  }
  return out;
}

/** Joins overlapping `[from, to)` spans and sums them, in milliseconds. */
export function unionMs(spans: { from: number; to: number }[]): number {
  const sorted = spans.filter((s) => s.to > s.from).sort((a, b) => a.from - b.from);
  let total = 0;
  let start = Number.NEGATIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    if (s.from > end) {
      if (end > start) total += end - start;
      start = s.from;
      end = s.to;
    } else if (s.to > end) {
      end = s.to;
    }
  }
  if (end > start) total += end - start;
  return total;
}

/**
 * For each run: whether it waits on the client now, the oldest open item's time, and how long it
 * has waited on the client in all (open items count up to `now`; their spans are joined, so two
 * items open together count once).
 */
export async function clientWaits(
  tx: Tx,
  tenantId: string,
  runIds: string[],
  now: Date = new Date(),
): Promise<Map<string, { waitingOnYou: boolean; since: Date | null; waitedMs: number }>> {
  const out = new Map<string, { waitingOnYou: boolean; since: Date | null; waitedMs: number }>();
  if (runIds.length === 0) return out;
  const rows = await tx
    .select({
      runId: inboxItem.runId,
      status: inboxItem.status,
      createdAt: inboxItem.createdAt,
      resolvedAt: inboxItem.resolvedAt,
    })
    .from(inboxItem)
    .where(and(eq(inboxItem.tenantId, tenantId), inArray(inboxItem.runId, runIds), forClient()));
  const spans = new Map<string, { from: number; to: number }[]>();
  for (const r of rows) {
    if (!r.runId) continue;
    const open = r.status === "open";
    const e = out.get(r.runId) ?? { waitingOnYou: false, since: null, waitedMs: 0 };
    if (open) {
      e.waitingOnYou = true;
      if (!e.since || r.createdAt < e.since) e.since = r.createdAt;
    }
    out.set(r.runId, e);
    const end = open ? now : (r.resolvedAt ?? r.createdAt);
    const list = spans.get(r.runId) ?? [];
    list.push({ from: r.createdAt.getTime(), to: end.getTime() });
    spans.set(r.runId, list);
  }
  for (const [runId, list] of spans) {
    const e = out.get(runId);
    if (e) e.waitedMs = unionMs(list);
  }
  return out;
}

/**
 * The portal's runs per day: each run on the day it started where the client is (its time zone),
 * by how it stands now. `runs` and `failed` keep the back office's meaning.
 */
export async function clientRunsPerDay(
  tx: Tx,
  where: SQL[],
  timezone: string,
): Promise<RunsPerDay> {
  const day = sql<string>`to_char(coalesce(${run.startedAt}, ${run.createdAt}) at time zone ${timezone}, 'YYYY-MM-DD')`;
  const rows = await tx
    .select({ day, state: clientState, n: sql<number>`count(*)::int` })
    .from(run)
    .where(and(...where))
    // By position: the time zone is a parameter, and a repeated expression would be another one.
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`);
  type Day = { [K in keyof RunsPerDay[number]]-?: NonNullable<RunsPerDay[number][K]> };
  const days = new Map<string, Day>();
  for (const r of rows) {
    const d: Day = days.get(r.day) ?? {
      day: r.day,
      runs: 0,
      failed: 0,
      done: 0,
      waiting: 0,
      going: 0,
      stopped: 0,
    };
    const n = Number(r.n);
    d.runs += n;
    if (r.state === "done") d.done += n;
    else if (r.state === "failed") d.failed += n;
    else if (r.state === "stopped") d.stopped += n;
    else if (r.state === "waiting") d.waiting += n;
    else d.going += n;
    days.set(r.day, d);
  }
  return [...days.values()];
}
