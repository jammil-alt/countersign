// docs/plan.md §1.234 (Y5): the one query behind the work statement's counters. The counters'
// meanings are core's `WORK_COUNTERS`; this is where they are counted, and the only place: the
// portal's statement, its PDF, the PDF emailed with the invoice and the back office's view all call
// `workCounts`, so they always agree. Read in the caller's transaction (one client's scope, or the
// back office narrowed to one client); the query also names the client (invariant 1).
//
// Every counter is over the client agents' live runs created in [since, until), and counts only
// rows recorded before `until`, so a month that has ended never changes. Money is summed as
// numeric in SQL, per currency, and returned as decimal strings (invariant 6).

import { WORK_COUNT_IDS, type WorkAmount, type WorkCountId } from "@countersign/core";
import { sql } from "drizzle-orm";
import type { Tx } from "./client";

export interface AgentWorkCounts extends Record<WorkCountId, number> {
  agentId: string;
  /** The agent's live runs created in the period. */
  runs: number;
  /** Per currency, largest first. */
  dollarsIdentified: WorkAmount[];
}

interface Row extends Record<string, unknown> {
  agent_id: string;
  runs: string | number;
  items_processed: string | number;
  auto_posted: string | number;
  sent_for_approval: string | number;
  exceptions_caught: string | number;
  dollars: { currency: string; total: string }[] | null;
}

/** The SQL column each counter is read from; `work-counts.test.ts` checks every id has one. */
export const WORK_COUNT_COLUMNS: Record<WorkCountId, keyof Row> = {
  itemsProcessed: "items_processed",
  autoPosted: "auto_posted",
  sentForApproval: "sent_for_approval",
  exceptionsCaught: "exceptions_caught",
};

/**
 * Each client agent's counters over its live runs created in [since, until), for the agents with
 * at least one such run, ordered by name. See core's `WORK_COUNTERS` for what each one means.
 */
export async function workCounts(
  tx: Pick<Tx, "execute">,
  input: { tenantId: string; since: Date; until: Date },
): Promise<AgentWorkCounts[]> {
  const t = input.tenantId;
  const since = input.since.toISOString();
  const until = input.until.toISOString();
  const rows = await tx.execute<Row>(sql`
    with runs as (
      -- DECISION: a client agent's live runs, never a template's test copy (which runs in the
      -- Sandbox) or a test run, which never writes: the same runs the KPIs and R4's report count.
      select r.id, r.agent_id
        from run r
        join agent a on a.id = r.agent_id and a.tenant_id = r.tenant_id
       where r.tenant_id = ${t}
         and r.mode = 'live'
         and r.created_at >= ${since}::timestamptz
         and r.created_at < ${until}::timestamptz
         and a.kind = 'client'
         and not a.test_copy
    ),
    items as (
      -- Items processed: different records a run decided on or changed, or that started it (no
      -- step). A record's identity is our id, else the client's tool and its id, else the row.
      select runs.agent_id,
             count(distinct s.kind || ':' || coalesce(
               s.record_id::text, s.connector || ':' || s.external_id, s.id::text)) as n
        from run_subject s
        join runs on runs.id = s.run_id
       where s.tenant_id = ${t}
         and s.created_at < ${until}::timestamptz
         and (s.role in ('decided', 'changed') or s.step_run_id is null)
       group by runs.agent_id
    ),
    auto as (
      -- Posted automatically: a write done with no approval item.
      select runs.agent_id, count(*) as n
        from external_action x
        join runs on runs.id = x.run_id
       where x.tenant_id = ${t}
         and x.status = 'done'
         and x.inbox_item_id is null
         and x.executed_at < ${until}::timestamptz
       group by runs.agent_id
    ),
    approvals as (
      -- Sent for approval: the client's own approval items (not routed to us), whatever the answer.
      select runs.agent_id, count(*) as n
        from inbox_item i
        join runs on runs.id = i.run_id
       where i.tenant_id = ${t}
         and i.kind in ('external_action', 'approval')
         and (i.assignee_role is null or i.assignee_role <> 'operator')
         and i.created_at < ${until}::timestamptz
       group by runs.agent_id
    ),
    alerts as (
      -- The alerts its runs raised, unless dismissed before the period ended.
      select runs.agent_id, al.dollar_impact, al.currency
        from alert al
        join runs on runs.id = al.raised_by_run_id
       where al.tenant_id = ${t}
         and al.created_at < ${until}::timestamptz
         and not (al.status = 'dismissed' and al.resolved_at < ${until}::timestamptz)
    ),
    disagreed as (
      -- Writes the verifier disagreed with (ARCHITECTURE §10.18), wherever the card went.
      select runs.agent_id, count(*) as n
        from inbox_item i
        join runs on runs.id = i.run_id
       where i.tenant_id = ${t}
         and i.payload -> 'verification' ->> 'outcome' = 'disagreed'
         and i.created_at < ${until}::timestamptz
       group by runs.agent_id
    ),
    dollars as (
      select agent_id, jsonb_agg(jsonb_build_object('currency', currency, 'total', total::text)
                                 order by total desc, currency) as dollars
        from (select agent_id, currency, sum(dollar_impact) as total
                from alerts
               where dollar_impact is not null
               group by agent_id, currency) d
       where total <> 0
       group by agent_id
    ),
    per_agent as (
      select agent_id, count(*) as runs from runs group by agent_id
    )
    select p.agent_id,
           p.runs,
           coalesce(items.n, 0) as items_processed,
           coalesce(auto.n, 0) as auto_posted,
           coalesce(approvals.n, 0) as sent_for_approval,
           coalesce((select count(*) from alerts where alerts.agent_id = p.agent_id), 0)
             + coalesce(disagreed.n, 0) as exceptions_caught,
           dollars.dollars
      from per_agent p
      left join items on items.agent_id = p.agent_id
      left join auto on auto.agent_id = p.agent_id
      left join approvals on approvals.agent_id = p.agent_id
      left join disagreed on disagreed.agent_id = p.agent_id
      left join dollars on dollars.agent_id = p.agent_id
      join agent a on a.id = p.agent_id and a.tenant_id = ${t}
     order by coalesce(a.service_name, a.name), a.id
  `);
  return [...rows].map((r) => {
    const out = {
      agentId: r.agent_id,
      runs: Number(r.runs),
      dollarsIdentified: (r.dollars ?? []).map((d) => ({
        currency: d.currency,
        total: normalizeDecimal(d.total),
      })),
    } as AgentWorkCounts;
    for (const id of WORK_COUNT_IDS) out[id] = Number(r[WORK_COUNT_COLUMNS[id]]);
    return out;
  });
}

/** `1250.5000` → `1250.50`: at least two places, no trailing zeros beyond them. */
function normalizeDecimal(v: string): string {
  if (!v.includes(".")) return `${v}.00`;
  const [whole, frac = ""] = v.split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${trimmed}`;
}
