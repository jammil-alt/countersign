// The `usage_daily` rollup (ARCHITECTURE §13): per client and client agent per day, for the back
// office's usage screens and future billing. Recomputed from the rows, so running it twice for the
// same day gives the same answer.

import { type Tx, usageDaily } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";

/**
 * Recomputes one client's usage for one day (YYYY-MM-DD) from its runs, step runs and executed
 * external actions. Test runs count too: their model calls cost the operator just the same.
 */
// DECISION: days are UTC days. Usage is the operator's (pricing), not the client's, so one clock
// across clients keeps rollups comparable.
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
    ids as (select agent_id from r union select agent_id from s union select agent_id from a)
    insert into usage_daily
      (tenant_id, day, agent_id, runs, steps, documents, external_actions, tokens_in, tokens_out, cost_usd)
    select ${t}::uuid, d.day, ids.agent_id, coalesce(r.runs, 0), coalesce(s.steps, 0), 0,
           coalesce(a.external_actions, 0), coalesce(s.tokens_in, 0), coalesce(s.tokens_out, 0),
           coalesce(s.cost_usd, 0)
    from ids cross join d
    left join r on r.agent_id = ids.agent_id
    left join s on s.agent_id = ids.agent_id
    left join a on a.agent_id = ids.agent_id
    on conflict (tenant_id, day, agent_id) do update set
      runs = excluded.runs, steps = excluded.steps, external_actions = excluded.external_actions,
      tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out, cost_usd = excluded.cost_usd
  `);
  return tx
    .select()
    .from(usageDaily)
    .where(and(eq(usageDaily.tenantId, t), eq(usageDaily.day, input.day)));
}
