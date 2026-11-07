// Runs each day for the small charts (UI cleanup, design pass): the portal's Home and agent cards,
// the command center's figures and agents table, and the client page's agent rows. Counted from
// the rows, never invented: a day with no run is 0. A run belongs to the day it started (its row's
// creation), as every client count does (./client-status.ts).
import { addDays, type DayRuns, KPI_DAYS } from "@countersign/core";
import { run, type Tx } from "@countersign/db";
import { and, type SQL, sql } from "drizzle-orm";
import { todayIn } from "../routes/usage";

/** The last `days` calendar days ending today where `timezone` is, oldest first (`YYYY-MM-DD`). */
export function lastDays(now: Date, timezone: string, days: number = KPI_DAYS): string[] {
  const today = todayIn(timezone, now);
  return Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1)));
}

const emptyDays = (n: number): DayRuns[] =>
  Array.from({ length: n }, () => ({ runs: 0, failed: 0 }));

/**
 * Runs that match `where`, started in the last `days` days (in `timezone`), each day: in all and
 * per agent. Every list has one entry per day, oldest first.
 */
export async function runsByDay(
  tx: Tx,
  where: SQL[],
  opts: { timezone: string; now: Date; days?: number },
): Promise<{ all: DayRuns[]; byAgent: Map<string, DayRuns[]> }> {
  const days = lastDays(opts.now, opts.timezone, opts.days);
  const first = days[0] as string;
  const index = new Map(days.map((d, i) => [d, i]));
  const day = sql<string>`to_char(${run.createdAt} at time zone ${opts.timezone}, 'YYYY-MM-DD')`;
  const rows = await tx
    .select({
      agentId: run.agentId,
      day,
      runs: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${run.status} = 'failed'))::int`,
    })
    .from(run)
    .where(
      and(
        ...where,
        sql`${run.createdAt} >= ((${first})::date)::timestamp at time zone ${opts.timezone}`,
      ),
    )
    // By position: the time zone is a parameter, and a repeated expression would be another one.
    .groupBy(sql`1`, sql`2`);
  const all = emptyDays(days.length);
  const byAgent = new Map<string, DayRuns[]>();
  for (const r of rows) {
    const i = index.get(r.day);
    if (i === undefined) continue;
    const mine = byAgent.get(r.agentId) ?? emptyDays(days.length);
    const n = Number(r.runs);
    const failed = Number(r.failed);
    (mine[i] as DayRuns).runs += n;
    (mine[i] as DayRuns).failed += failed;
    (all[i] as DayRuns).runs += n;
    (all[i] as DayRuns).failed += failed;
    byAgent.set(r.agentId, mine);
  }
  return { all, byAgent };
}

/** An agent's days from `runsByDay`, or a row of zeros when it ran on none of them. */
export function daysOf(
  byAgent: Map<string, DayRuns[]>,
  agentId: string,
  days = KPI_DAYS,
): DayRuns[] {
  return byAgent.get(agentId) ?? emptyDays(days);
}
