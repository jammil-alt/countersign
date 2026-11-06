// The platform's own health (docs/plan.md §1.61): what went wrong in clients' work that is not an
// exception, so Sentry never saw it. Failed live runs and failed writes to clients' tools, grouped
// by their error key (§1.40), every hour; runs stuck before a step, approvals the run never took
// and broken connections, once a day. Each group goes to Sentry as one issue per error key, with
// the client and a few record ids as tags and extras, never a client's text; the ops MCP server's
// `ops_health` tool reads the same findings on demand.
//
// One query set for both: it reads the clients it is given, inside the caller's scope (the cron's
// withTenant per client, the MCP tool's operator scope), and filters by tenant_id (invariant 1).

import { errorGroupKey, runErrorKey } from "@countersign/core";
import {
  connection,
  type Db,
  externalAction,
  inboxItem,
  run,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { captureMessage } from "@sentry/cloudflare";
import { and, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { reportHandled } from "./report";

export const HEALTH_KINDS = [
  "run_failed",
  "action_failed",
  "run_stuck",
  "delivery_stuck",
  "connection_broken",
] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];

export interface HealthFinding {
  kind: HealthKind;
  tenantId: string;
  /** What the finding is grouped by: a run's error key, a tool and code, a connector and status. */
  key: string;
  count: number;
  /** Up to SAMPLE_IDS record ids (runs, actions, inbox items or connections), newest first. */
  ids: string[];
  /** A write whose outcome is unknown (the tool may or may not have made the change). */
  unconfirmed?: true;
}

const SAMPLE_IDS = 5;
/** A run still queued or running this long after it was created has stopped moving. */
export const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
/** An approval the run has not taken this long after it was signed (the cron re-sends each minute). */
export const STUCK_DELIVERY_MS = 30 * 60 * 1000;
/** A connection that syncs and has not for this long (QuickBooks syncs every 15 minutes). */
export const STALE_SYNC_MS = 2 * 60 * 60 * 1000;

// DECISION: the hourly pass runs at minute 12, apart from the usage sweep's minute 7; states are
// reported once a day at 13:12 UTC (morning in the US), so a stuck run is one Sentry event a day.
export const HEALTH_MINUTE = 12;
export const HEALTH_DAILY_HOUR_UTC = 13;

interface Window {
  from: Date;
  to: Date;
  now: Date;
  /** Also the states (stuck runs and deliveries, broken connections), not only the window's events. */
  states: boolean;
}

function group(
  rows: readonly { id: string; tenantId: string; key: string; unconfirmed?: boolean }[],
  kind: HealthKind,
): HealthFinding[] {
  const out = new Map<string, HealthFinding>();
  for (const r of rows) {
    const id = `${r.tenantId}\u0000${r.key}`;
    const f = out.get(id) ?? { kind, tenantId: r.tenantId, key: r.key, count: 0, ids: [] };
    f.count += 1;
    if (f.ids.length < SAMPLE_IDS) f.ids.push(r.id);
    if (r.unconfirmed) f.unconfirmed = true;
    out.set(id, f);
  }
  return [...out.values()];
}

/** What went wrong for these clients: the window's failures and, with `states`, what is stuck now. */
export async function healthFindings(
  tx: Tx,
  tenantIds: readonly string[],
  w: Window,
): Promise<HealthFinding[]> {
  if (tenantIds.length === 0) return [];
  const ids = [...tenantIds];
  const findings: HealthFinding[] = [];

  const failedRuns = await tx
    .select({ id: run.id, tenantId: run.tenantId, error: run.error })
    .from(run)
    .where(
      and(
        inArray(run.tenantId, ids),
        sql`${run.status} = 'failed'`,
        sql`${run.mode} = 'live'`,
        gte(run.finishedAt, w.from),
        lt(run.finishedAt, w.to),
      ),
    )
    .orderBy(sql`${run.finishedAt} desc`);
  findings.push(
    ...group(
      failedRuns.map((r) => ({ id: r.id, tenantId: r.tenantId, key: errorGroupKey(r.error) })),
      "run_failed",
    ),
  );

  const when = sql`coalesce(${externalAction.executedAt}, ${externalAction.approvedAt}, ${externalAction.createdAt})`;
  const failedActions = await tx
    .select({
      id: externalAction.id,
      tenantId: externalAction.tenantId,
      tool: externalAction.tool,
      error: externalAction.error,
    })
    .from(externalAction)
    .where(
      and(
        inArray(externalAction.tenantId, ids),
        sql`${externalAction.status} = 'failed'`,
        sql`${when} >= ${w.from.toISOString()}::timestamptz`,
        sql`${when} < ${w.to.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(sql`${when} desc`);
  findings.push(
    ...group(
      failedActions.map((a) => {
        const e = (a.error ?? {}) as { code?: unknown; message?: unknown; unconfirmed?: unknown };
        const key =
          typeof e.code === "string" && e.code
            ? `${a.tool}:${e.code}`
            : runErrorKey(
                { tool: a.tool, kind: "action" },
                typeof e.message === "string" ? e.message : null,
              );
        return { id: a.id, tenantId: a.tenantId, key, unconfirmed: e.unconfirmed === true };
      }),
      "action_failed",
    ),
  );

  if (!w.states) return findings;

  const stuckRuns = await tx
    .select({ id: run.id, tenantId: run.tenantId, status: run.status, slug: run.workflowSlug })
    .from(run)
    .where(
      and(
        inArray(run.tenantId, ids),
        inArray(run.status, ["queued", "running"]),
        lt(run.createdAt, new Date(w.now.getTime() - STUCK_RUN_MS)),
      ),
    )
    .orderBy(sql`${run.createdAt} desc`);
  findings.push(
    ...group(
      stuckRuns.map((r) => ({ id: r.id, tenantId: r.tenantId, key: `${r.status}:${r.slug}` })),
      "run_stuck",
    ),
  );

  const late = new Date(w.now.getTime() - STUCK_DELIVERY_MS);
  const undelivered = await tx
    .select({ id: inboxItem.id, tenantId: inboxItem.tenantId, kind: inboxItem.kind })
    .from(inboxItem)
    .where(
      and(
        inArray(inboxItem.tenantId, ids),
        sql`${inboxItem.status} = 'resolved'`,
        isNotNull(inboxItem.runId),
        isNull(inboxItem.runReceivedAt),
        lt(inboxItem.resolvedAt, late),
        or(isNull(inboxItem.deliverAfter), lt(inboxItem.deliverAfter, late)),
      ),
    )
    .orderBy(sql`${inboxItem.resolvedAt} desc`);
  findings.push(
    ...group(
      undelivered.map((i) => ({ id: i.id, tenantId: i.tenantId, key: i.kind })),
      "delivery_stuck",
    ),
  );

  const stale = new Date(w.now.getTime() - STALE_SYNC_MS);
  const broken = await tx
    .select({
      id: connection.id,
      tenantId: connection.tenantId,
      connector: connection.connector,
      status: connection.status,
    })
    .from(connection)
    .where(
      and(
        inArray(connection.tenantId, ids),
        or(
          sql`${connection.status} = 'error'`,
          and(
            sql`${connection.status} = 'connected'`,
            isNotNull(connection.syncCursor),
            lt(connection.lastSyncAt, stale),
          ),
        ),
      ),
    );
  findings.push(
    ...group(
      broken.map((c) => ({
        id: c.id,
        tenantId: c.tenantId,
        key: `${c.connector}:${c.status === "error" ? "error" : "sync_stale"}`,
      })),
      "connection_broken",
    ),
  );
  return findings;
}

const TITLES: Record<HealthKind, string> = {
  run_failed: "Live runs failed",
  action_failed: "Writes to a client's tool failed",
  run_stuck: "Runs stopped before finishing",
  delivery_stuck: "Signed items not taken by their run",
  connection_broken: "Connections need attention",
};

/** One Sentry event per finding: grouped by kind and key across clients, the client as a tag. */
export function reportFinding(f: HealthFinding): void {
  const level =
    f.kind === "run_failed" || f.kind === "connection_broken" ? "warning" : ("error" as const);
  captureMessage(`${TITLES[f.kind]}: ${f.key}`, {
    level,
    fingerprint: ["ops_health", f.kind, f.key],
    tags: {
      handled: "yes",
      job: "health",
      ops_health: f.kind,
      error_key: f.key,
      client: f.tenantId,
      ...(f.unconfirmed ? { unconfirmed: "yes" } : {}),
    },
    extra: { count: f.count, ids: f.ids },
  });
}

/** The window an hourly pass at `scheduledTime` covers: the hour before the current one. */
export function healthWindow(scheduledTime: Date): Window {
  const now = new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000);
  const to = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  return {
    from: new Date(to.getTime() - 3_600_000),
    to,
    now,
    states: now.getUTCHours() === HEALTH_DAILY_HOUR_UTC,
  };
}

/** The cron's call: once an hour, each client's findings to Sentry. Returns how many it sent. */
export async function healthTick(
  db: Db,
  scheduledTime: Date,
  report: (f: HealthFinding) => void = reportFinding,
): Promise<number> {
  if (scheduledTime.getUTCMinutes() !== HEALTH_MINUTE) return 0;
  const w = healthWindow(scheduledTime);
  const clients = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  let sent = 0;
  for (const client of clients) {
    try {
      const found = await withTenant(db, client.id, (tx) => healthFindings(tx, [client.id], w));
      for (const f of found) report(f);
      sent += found.length;
    } catch (error) {
      reportHandled(`health check for client ${client.id} failed`, error, {
        job: "health",
        client: client.id,
      });
    }
  }
  return sent;
}
