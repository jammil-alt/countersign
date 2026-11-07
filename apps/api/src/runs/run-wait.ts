// UI cleanup (stream A): a run as the back office sees it. A run still going with an open inbox item
// (for anyone: the client or us) is "waiting for approval", never running, as the portal does for
// the client (./client-status.ts). Here: that state as SQL, for the runs list's status filter and
// counts, and each waiting run's wait (who, since when, whether anybody can act), for every run
// shape the back office reads.
import {
  type ClientMember,
  type OpenItem,
  type ReachContext,
  type RunWait,
  runWaitOf,
} from "@countersign/core";
import { appUser, inboxItem, membership, run, type Tx } from "@countersign/db";
import { and, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Services } from "../http";
import { mailerFromEnv } from "../notify/mailer";

/**
 * The run (`run` in the query) has an open inbox item, for anyone. Written with its own alias and
 * the run's columns qualified, so it binds right in a select list too (drizzle leaves a single
 * table's columns unqualified there).
 */
export const waitsOnPerson: SQL = sql`exists (select 1 from inbox_item wi where wi.run_id = "run"."id" and wi.tenant_id = "run"."tenant_id" and wi.status = 'open')`;

/**
 * The back office's run status filter: `waiting` is any run waiting on a person (whatever its
 * stored status), `queued` and `running` only those that don't; ended statuses as stored.
 */
export function opsStatusWhere(statuses: readonly string[] | undefined): SQL[] {
  if (!statuses?.length) return [];
  const parts: SQL[] = [];
  const going = statuses.filter((s) => s === "queued" || s === "running");
  if (going.length) {
    parts.push(
      and(inArray(run.status, going as ("queued" | "running")[]), sql`not ${waitsOnPerson}`) as SQL,
    );
  }
  if (statuses.includes("waiting")) {
    parts.push(
      or(
        eq(run.status, "waiting"),
        and(inArray(run.status, ["queued", "running"]), waitsOnPerson),
      ) as SQL,
    );
  }
  const ended = statuses.filter((s) => s === "succeeded" || s === "failed" || s === "cancelled");
  if (ended.length) {
    parts.push(inArray(run.status, ended as ("succeeded" | "failed" | "cancelled")[]));
  }
  return [parts.length ? (or(...parts) as SQL) : sql`false`];
}

/** Whether this deployment knows first sign-ins (WorkOS) and sends emails. */
export function reachContext(services: Pick<Services, "auth" | "env">): ReachContext {
  const choice = services.auth();
  return {
    signInsKnown: choice.ok && choice.adapter.kind === "workos",
    emailOn: mailerFromEnv(services.env).isConfigured,
  };
}

/** The people of these clients, for who may approve. */
export async function clientMembers(
  tx: Tx,
  tenantIds: readonly string[],
  reach: ReachContext,
): Promise<Map<string, ClientMember[]>> {
  const out = new Map<string, ClientMember[]>();
  const ids = [...new Set(tenantIds)];
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      tenantId: membership.tenantId,
      userId: membership.userId,
      role: membership.role,
      canSign: membership.canSign,
      workosUserId: appUser.workosUserId,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(inArray(membership.tenantId, ids));
  for (const r of rows) {
    const list = out.get(r.tenantId) ?? [];
    list.push({
      userId: r.userId,
      role: r.role,
      canSign: r.canSign,
      signedIn: reach.signInsKnown ? r.workosUserId !== null : null,
    });
    out.set(r.tenantId, list);
  }
  return out;
}

/** An open item with its tenant, run and the named assignee's name. */
export interface OpenItemRow extends OpenItem {
  id: string;
  tenantId: string;
  runId: string | null;
  agentId: string | null;
  title: string;
  payload: Record<string, unknown>;
}

/** Open items of these clients (and, given, of these runs), with the named assignee's name. */
export async function openItems(
  tx: Tx,
  tenantIds: readonly string[],
  where: SQL[] = [],
): Promise<OpenItemRow[]> {
  if (tenantIds.length === 0) return [];
  const rows = await tx
    .select({
      id: inboxItem.id,
      tenantId: inboxItem.tenantId,
      runId: inboxItem.runId,
      agentId: inboxItem.agentId,
      title: inboxItem.title,
      payload: inboxItem.payload,
      assigneeRole: inboxItem.assigneeRole,
      assigneeUserId: inboxItem.assigneeUserId,
      createdAt: inboxItem.createdAt,
      name: appUser.name,
      email: appUser.email,
    })
    .from(inboxItem)
    .leftJoin(appUser, eq(appUser.id, inboxItem.assigneeUserId))
    .where(
      and(inArray(inboxItem.tenantId, [...tenantIds]), eq(inboxItem.status, "open"), ...where),
    );
  return rows.map(({ name, email, ...r }) => ({
    ...r,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    personName: r.assigneeUserId ? (name ?? email ?? null) : null,
  }));
}

/**
 * Each waiting run's wait, for runs still going (queued, running or waiting). A run with no open
 * item has none (a `waiting` run between items reads as waiting with no wait).
 */
export async function runWaits(
  tx: Tx,
  runs: readonly { id: string; tenantId: string; status: string }[],
  reach: ReachContext,
): Promise<Map<string, RunWait>> {
  const out = new Map<string, RunWait>();
  const open = runs.filter((r) => ["queued", "running", "waiting"].includes(r.status));
  if (open.length === 0) return out;
  const tenantIds = [...new Set(open.map((r) => r.tenantId))];
  const items = await openItems(tx, tenantIds, [
    inArray(
      inboxItem.runId,
      open.map((r) => r.id),
    ),
  ]);
  if (items.length === 0) return out;
  const members = await clientMembers(tx, tenantIds, reach);
  const byRun = new Map<string, OpenItemRow[]>();
  for (const i of items) {
    if (!i.runId) continue;
    byRun.set(i.runId, [...(byRun.get(i.runId) ?? []), i]);
  }
  for (const r of open) {
    const list = byRun.get(r.id);
    if (!list) continue;
    const wait = runWaitOf(list, members.get(r.tenantId) ?? [], reach);
    if (wait) out.set(r.id, wait);
  }
  return out;
}
