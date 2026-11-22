// R5: a report per account (docs/reporting-plan.md §3 R5, docs/plan.md §1.235). One client's
// period across its agents, from R4's reader (`agent-report.ts`): the same scope with no agent, the
// same headline grouped by agent, the same status conditions, so every figure's RunFilter opens
// exactly its runs on the surface's runs list. Beside the period, what stands now: runs and items
// waiting and the oldest wait, failed runs nobody has looked at (as Needs us counts them),
// connections that need attention, and usage against the allowance (worked out by the route, which
// differs by surface). The portal reads only the client's own items (invariant 11); every query
// names the one client as well as relying on RLS (invariant 1).

import {
  ACCOUNT_ALLOWANCE_SHARE,
  ACCOUNT_WAIT_OVERDUE_HOURS,
  FAILED_RUN_ESCALATION_DAYS,
  type NeedsUsReason,
  type OpsAccountReport,
  type PortalAccountReport,
  type RunFilter,
} from "@countersign/core";
import { type agent, inboxItem, run, type Tx } from "@countersign/db";
import { and, eq, gte, type SQL, sql } from "drizzle-orm";
import { connectionsNeedingAttention } from "../connection-attention";
import type { Platform } from "../platform";
import { emptyHeadline, headlines, OUTCOMES, scopeOf, statusSql } from "./agent-report";
import { forClient } from "./client-status";
import { notWaitingReminder } from "./run-wait";

type Surface = "portal" | "ops";
type AgentRow = typeof agent.$inferSelect;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface AccountInput {
  surface: Surface;
  client: { id: string; name: string; timezone: string };
  /** The client's agents that get a line: its services (`isService`). */
  agents: readonly AgentRow[];
  from: string;
  to: string;
  previous: { from: string; to: string };
  /** The month's credits against the allowance, as the surface reads them; null: not billed. */
  usage: PortalAccountReport["usage"];
  now: Date;
}

/** The items "what waits now" counts: the portal's are the client's own. */
function openItemsWhere(surface: Surface, tenantId: string): SQL[] {
  return [
    eq(inboxItem.tenantId, tenantId),
    eq(inboxItem.status, "open"),
    // DECISION: a test run's items block no client, and the supervisor's reminders are about
    // other items, not waits of their own: both left out, as Needs us leaves them out.
    sql`coalesce(${inboxItem.payload}->>'testRun', '') <> 'true'`,
    notWaitingReminder,
    ...(surface === "portal" ? [forClient()] : []),
  ];
}

/**
 * Live runs that failed in the last FAILED_RUN_ESCALATION_DAYS and were not tried again: Needs
 * us's "failed run nobody has looked at" (`routes/command-center.ts`), for one client.
 */
// DECISION: "nobody has looked at" is Needs us's own rule (failed, live, within the escalation
// window, no retry), so the account report and Escalations agree. RunFilter can't say "not tried
// again", so the figure carries no filter; the back office links it to the client's Escalations.
function failedUnseenWhere(tenantId: string, now: Date): SQL[] {
  return [
    eq(run.tenantId, tenantId),
    eq(run.mode, "live"),
    eq(run.status, "failed"),
    gte(run.createdAt, new Date(now.getTime() - FAILED_RUN_ESCALATION_DAYS * DAY_MS)),
    sql`not exists (select 1 from run retry where retry.retry_of = ${run.id} and retry.tenant_id = ${run.tenantId})`,
  ];
}

/** The report both surfaces show; the back office adds why the client needs us. */
export async function accountReport(
  tx: Tx,
  platform: Platform,
  input: AccountInput,
): Promise<PortalAccountReport | Omit<OpsAccountReport, "needsUs">> {
  const { surface, client, now } = input;
  const scopeInput = { surface, tenantId: client.id, timezone: client.timezone, agent: null };
  const scope = scopeOf(platform, scopeInput, input.from, input.to);
  const before = scopeOf(platform, scopeInput, input.previous.from, input.previous.to);
  // Every run whenever it started: what stands now.
  const standing = scopeOf(platform, scopeInput, null, null);
  const withFilter = (extra: Partial<RunFilter>): RunFilter => ({ ...scope.base, ...extra });
  const nowFilter = (extra: Partial<RunFilter>): RunFilter => ({ ...standing.base, ...extra });
  const waitingSql = statusSql(surface, OUTCOMES.waiting);

  const [byAgent, byAgentBefore, all, allBefore, waitingRuns, [items], [failed], connections] =
    await Promise.all([
      headlines(tx, scope, input.from, input.to, true),
      headlines(tx, before, input.previous.from, input.previous.to, true),
      headlines(tx, scope, input.from, input.to, false),
      headlines(tx, before, input.previous.from, input.previous.to, false),
      tx
        .select({ agentId: run.agentId, n: sql<number>`count(*)::int` })
        .from(run)
        .where(and(...standing.where, waitingSql))
        .groupBy(run.agentId),
      tx
        .select({
          n: sql<number>`count(*)::int`,
          overdue: sql<number>`(count(*) filter (where ${inboxItem.createdAt} < ${new Date(
            now.getTime() - ACCOUNT_WAIT_OVERDUE_HOURS * HOUR_MS,
          ).toISOString()}::timestamptz))::int`,
          oldest: sql<Date | string | null>`min(${inboxItem.createdAt})`,
        })
        .from(inboxItem)
        .where(and(...openItemsWhere(surface, client.id))),
      tx
        .select({
          n: sql<number>`count(*)::int`,
          oldest: sql<Date | string | null>`min(coalesce(${run.finishedAt}, ${run.createdAt}))`,
        })
        .from(run)
        .where(and(...failedUnseenWhere(client.id, now))),
      connectionsNeedingAttention(tx, [client.id]),
    ]);

  const waitingOf = new Map(waitingRuns.map((r) => [r.agentId, Number(r.n)]));
  const iso = (v: Date | string | null | undefined) =>
    v === null || v === undefined ? null : new Date(v).toISOString();
  const lines = input.agents
    .map((a) => {
      const h = byAgent.get(a.id) ?? emptyHeadline(input.from, input.to);
      const agents = [a.id];
      return {
        service: { id: a.id, name: a.serviceName ?? a.name },
        headline: h,
        previous: byAgentBefore.get(a.id) ?? emptyHeadline(input.previous.from, input.previous.to),
        runs: { count: h.runs, filter: withFilter({ agents }) },
        done: { count: h.done, filter: withFilter({ agents, statuses: [...OUTCOMES.done] }) },
        failed: {
          count: h.failed,
          filter: withFilter({ agents, statuses: [...OUTCOMES.failed] }),
        },
        waiting: {
          count: waitingOf.get(a.id) ?? 0,
          filter: nowFilter({ agents, statuses: [...OUTCOMES.waiting] }),
        },
      };
    })
    .sort(
      (a, b) =>
        b.headline.runs - a.headline.runs ||
        b.waiting.count - a.waiting.count ||
        a.service.name.localeCompare(b.service.name),
    );

  const headline = all.get(client.id) ?? emptyHeadline(input.from, input.to);
  const waitingCount = [...waitingOf.values()].reduce((n, v) => n + v, 0);
  return {
    client: { id: client.id, name: client.name },
    from: input.from,
    to: input.to,
    timezone: client.timezone,
    headline,
    previous: allBefore.get(client.id) ?? emptyHeadline(input.previous.from, input.previous.to),
    runs: { count: headline.runs, filter: withFilter({}) },
    done: { count: headline.done, filter: withFilter({ statuses: [...OUTCOMES.done] }) },
    failed: { count: headline.failed, filter: withFilter({ statuses: [...OUTCOMES.failed] }) },
    agents: lines,
    waiting: {
      runs: { count: waitingCount, filter: nowFilter({ statuses: [...OUTCOMES.waiting] }) },
      items: Number(items?.n ?? 0),
      overdue: Number(items?.overdue ?? 0),
      oldestSince: iso(items?.oldest),
    },
    failedUnseen: { count: Number(failed?.n ?? 0), oldestSince: iso(failed?.oldest), filter: null },
    connections: connections.map(({ row, attention }) => ({
      id: row.id,
      connector: row.connector,
      name: platform.connectors.get(row.connector)?.manifest.name ?? row.connector,
      attention,
      since: row.updatedAt.toISOString(),
    })),
    usage: input.usage,
  };
}

/**
 * Why a client needs us (the owner's answer 3): something waiting past a day, a failed run nobody
 * has looked at, a connection that needs attention, or an allowance over 80% used.
 */
export function needsUsOf(
  report: Pick<PortalAccountReport, "waiting" | "failedUnseen" | "connections" | "usage">,
): NeedsUsReason[] {
  const out: NeedsUsReason[] = [];
  if (report.waiting.overdue > 0) out.push("waiting");
  if (report.failedUnseen.count > 0) out.push("failed");
  if (report.connections.length > 0) out.push("connection");
  const share = report.usage?.share;
  if (share !== null && share !== undefined && share > ACCOUNT_ALLOWANCE_SHARE) {
    out.push("allowance");
  }
  return out;
}
