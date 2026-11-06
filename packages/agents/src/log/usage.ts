// The `usage_daily` rollup (ARCHITECTURE §13): per client and client agent per day, for the back
// office's usage screens and future billing. Recomputed from the rows, so running it twice for the
// same day gives the same answer. Cost is summed by Postgres as numeric, never as a JS number.

import { run, type Tx, usageDaily, usagePlatformDaily } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";

/** The most days one run's rollup recomputes (a run waiting longer is caught by the cron sweep). */
export const USAGE_ROLLUP_MAX_DAYS = 31;

/** `YYYY-MM-DD` of a moment, in UTC. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Every UTC day from `from` to `to` (inclusive, `YYYY-MM-DD`), at most `max` of them, newest kept. */
export function utcDaysBetween(from: string, to: string, max = USAGE_ROLLUP_MAX_DAYS): string[] {
  const days: string[] = [];
  const end = new Date(`${to}T00:00:00.000Z`);
  for (let d = new Date(`${from}T00:00:00.000Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(utcDay(d));
  }
  return days.slice(-max);
}

/**
 * Recomputes one client's usage for one day (YYYY-MM-DD) from its runs, step runs, executed
 * external actions and the documents its agents read. Test runs count too: their model calls cost
 * the operator just the same.
 */
// DECISION: days are UTC days. Usage is the operator's (pricing), not the client's, so one clock
// across clients keeps rollups comparable.
// DECISION: `documents` counts the distinct documents a client agent worked on that day: those its
// versions extracted (doc_extraction.agent_version_id), and (v0.12 W1-H, ARCHITECTURE §13) those
// its live runs' steps cite in their `sources` (a document id, or an extraction's), so an agent
// working on a document read in the background counts it. The background reading itself is the
// client's usage (usage_platform_daily, rolled up below), never an agent's. Tool calls have no
// column of their own: their cost is their step's, and the writes among them are
// `external_actions` (plan §1.15).
export async function rollupUsageDaily(
  tx: Tx,
  input: { tenantId: string; day: string },
): Promise<(typeof usageDaily.$inferSelect)[]> {
  const t = input.tenantId;
  await tx.execute(sql`
    with d as (
      select ${input.day}::date as day,
             (${input.day}::date)::timestamp at time zone 'UTC' as lo,
             (${input.day}::date + 1)::timestamp at time zone 'UTC' as hi
    ),
    r as (
      select run.agent_id, count(*)::int as runs
      from run, d
      where run.tenant_id = ${t} and run.created_at >= d.lo and run.created_at < d.hi
      group by run.agent_id
    ),
    s as (
      select run.agent_id, count(*)::int as steps,
             coalesce(sum(sr.tokens_in), 0)::bigint as tokens_in,
             coalesce(sum(sr.tokens_out), 0)::bigint as tokens_out,
             coalesce(sum(sr.cost_usd), 0) as cost_usd
      from step_run sr
      join run on run.id = sr.run_id and run.tenant_id = sr.tenant_id, d
      where sr.tenant_id = ${t}
        and coalesce(sr.started_at, run.created_at) >= d.lo
        and coalesce(sr.started_at, run.created_at) < d.hi
      group by run.agent_id
    ),
    a as (
      select run.agent_id, count(*)::int as external_actions
      from external_action ea
      join run on run.id = ea.run_id and run.tenant_id = ea.tenant_id, d
      where ea.tenant_id = ${t} and ea.status = 'done'
        and ea.executed_at >= d.lo and ea.executed_at < d.hi
      group by run.agent_id
    ),
    read as (
      select av.agent_id, de.document_id
      from doc_extraction de
      join agent_version av on av.id = de.agent_version_id and av.tenant_id = de.tenant_id, d
      where de.tenant_id = ${t} and de.created_at >= d.lo and de.created_at < d.hi
    ),
    cited_ids as (
      select run.agent_id, src.id
      from step_run sr
      join run on run.id = sr.run_id and run.tenant_id = sr.tenant_id
      cross join lateral jsonb_array_elements_text(
        (case when jsonb_typeof(sr.output -> 'sources') = 'array'
              then sr.output -> 'sources' else '[]'::jsonb end)
        || (case when jsonb_typeof(sr.input -> 'sources') = 'array'
                 then sr.input -> 'sources' else '[]'::jsonb end)
      ) as src(id), d
      where sr.tenant_id = ${t} and run.mode = 'live'
        and coalesce(sr.started_at, run.created_at) >= d.lo
        and coalesce(sr.started_at, run.created_at) < d.hi
    ),
    cited as (
      select c.agent_id, doc.id as document_id
      from cited_ids c
      join document doc on doc.tenant_id = ${t} and doc.id::text = c.id
      union
      select c.agent_id, dx.document_id
      from cited_ids c
      join doc_extraction dx on dx.tenant_id = ${t} and dx.id::text = c.id
    ),
    x as (
      select agent_id, count(distinct document_id)::int as documents
      from (select * from read union select * from cited) u
      group by agent_id
    ),
    ids as (
      select agent_id from r union select agent_id from s
      union select agent_id from a union select agent_id from x
    )
    insert into usage_daily
      (tenant_id, day, agent_id, runs, steps, documents, external_actions, tokens_in, tokens_out, cost_usd)
    select ${t}::uuid, d.day, ids.agent_id, coalesce(r.runs, 0), coalesce(s.steps, 0),
           coalesce(x.documents, 0), coalesce(a.external_actions, 0), coalesce(s.tokens_in, 0),
           coalesce(s.tokens_out, 0), coalesce(s.cost_usd, 0)
    from ids cross join d
    left join r on r.agent_id = ids.agent_id
    left join s on s.agent_id = ids.agent_id
    left join a on a.agent_id = ids.agent_id
    left join x on x.agent_id = ids.agent_id
    on conflict (tenant_id, day, agent_id) do update set
      runs = excluded.runs, steps = excluded.steps, documents = excluded.documents,
      external_actions = excluded.external_actions, tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out, cost_usd = excluded.cost_usd
  `);
  await rollupPlatformDaily(tx, input);
  return tx
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.tenantId, t), eq(usageDaily.day, input.day)));
}

/**
 * v0.12 W1-H (ARCHITECTURE §13): recomputes one client's own usage for one day, the reading no
 * agent asked for (uploads and forwarded mail: doc_extraction rows with no agent version), into
 * usage_platform_daily. A day with no such reading writes no row.
 */
// DECISION: a background reading that fails writes no doc_extraction row, so its model call (if it
// got that far) is not counted: rows are immutable and only a reading has one. Failures are rare,
// and an agent's own failed docs.extract still counts on its step.
export async function rollupPlatformDaily(
  tx: Tx,
  input: { tenantId: string; day: string },
): Promise<(typeof usagePlatformDaily.$inferSelect)[]> {
  const t = input.tenantId;
  await tx.execute(sql`
    with d as (
      select ${input.day}::date as day,
             (${input.day}::date)::timestamp at time zone 'UTC' as lo,
             (${input.day}::date + 1)::timestamp at time zone 'UTC' as hi
    )
    insert into usage_platform_daily (tenant_id, day, documents, tokens_in, tokens_out, cost_usd)
    select ${t}::uuid, d.day, count(distinct de.document_id)::int,
           coalesce(sum(de.tokens_in), 0)::bigint, coalesce(sum(de.tokens_out), 0)::bigint,
           coalesce(sum(de.cost_usd), 0)
    from doc_extraction de, d
    where de.tenant_id = ${t} and de.agent_version_id is null
      and de.created_at >= d.lo and de.created_at < d.hi
    group by d.day
    on conflict (tenant_id, day) do update set
      documents = excluded.documents, tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out, cost_usd = excluded.cost_usd
  `);
  return tx
    .select()
    .from(usagePlatformDaily)
    .where(and(eq(usagePlatformDaily.tenantId, t), eq(usagePlatformDaily.day, input.day)));
}

/** Recomputes each of `days` for one client. */
export async function rollupUsageDays(
  tx: Tx,
  input: { tenantId: string; days: readonly string[] },
): Promise<void> {
  for (const day of input.days) await rollupUsageDaily(tx, { tenantId: input.tenantId, day });
}

/**
 * Recomputes every UTC day a run touched, from the day it was created to `now`: a run that waited
 * overnight for an approval adds steps and actions to later days, and its earlier days may have
 * been rolled up before those rows existed.
 */
// DECISION: usage is rolled up on write, when a run finishes (all of a run's days), and swept by
// the cron each hour for today and yesterday (runs still waiting). No GET writes (plan §1.15).
export async function rollupUsageForRun(
  tx: Tx,
  input: { tenantId: string; runId: string; now?: Date },
): Promise<void> {
  const [r] = await tx
    .select({ createdAt: run.createdAt })
    .from(run)
    .where(and(eq(run.id, input.runId), eq(run.tenantId, input.tenantId)));
  const today = utcDay(input.now ?? new Date());
  const from = r ? utcDay(r.createdAt) : today;
  await rollupUsageDays(tx, { tenantId: input.tenantId, days: utcDaysBetween(from, today) });
}
