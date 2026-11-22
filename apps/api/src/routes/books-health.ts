// Books health (docs/plan.md §1.216): the one-page report on a client's QuickBooks. The checks
// library (core `checkBooks`) runs on the connection's synced records (connectors `loadQboBooks`);
// this route is the only place that adds what QuickBooks' API doesn't say, which accounts were
// reconciled, from the Bookkeeping pack's signed-off reconciliations (apps/api wires packs; the
// platform's library never imports one).

import { loadQboBooks } from "@countersign/connectors";
import {
  type BooksHealthView,
  checkBooks,
  connectionLabel,
  QBO_CONNECTOR_ID,
  routes,
} from "@countersign/core";
import { connection, type Tx, tenantPack } from "@countersign/db";
import { reconciliation } from "@countersign/pack-bookkeeping";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount } from "../http";

export function booksHealthRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalBooksHealth, async (ctx) =>
    booksHealth(ctx.tx, ctx.tenantIds[0] as string, new Date()),
  );
  mount(app, routes.opsClientBooksHealth, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return booksHealth(ctx.tx, ctx.params.id, new Date());
  });
}

/** The report on the client's QuickBooks company as of today. */
// DECISION: one company: the client's connected QuickBooks connection synced most recently (a
// client has one QuickBooks company in v1); "today" is the UTC day.
export async function booksHealth(tx: Tx, tenantId: string, now: Date): Promise<BooksHealthView> {
  const packs = (
    await tx
      .select({ pack: tenantPack.pack })
      .from(tenantPack)
      .where(eq(tenantPack.tenantId, tenantId))
      .orderBy(asc(tenantPack.pack))
  ).map((p) => p.pack);
  const [c] = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, QBO_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    )
    .orderBy(sql`${connection.lastSyncAt} desc nulls last`, desc(connection.createdAt))
    .limit(1);
  if (!c) return { company: null, report: null, packs };
  const company = {
    name: connectionLabel(c.config, c.externalAccountId),
    lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
  };
  if (!c.lastSyncAt) return { company, report: null, packs };
  const snapshot = await loadQboBooks(tx, {
    tenantId,
    connectionId: c.id,
    reconciledThrough: await reconciledThrough(tx, tenantId, c.id),
  });
  return {
    company,
    report: checkBooks(snapshot, { asOf: now.toISOString().slice(0, 10) }),
    packs,
  };
}

/**
 * QuickBooks account id → the last day a signed-off reconciliation of it ran through. QuickBooks'
 * API doesn't say what was reconciled there.
 */
// DECISION: only reconciliations signed off in Mezonas count (the Bookkeeping pack's, whose pair
// key names the QuickBooks side as `qbo:<connection>:<account>`); one reconciled in QuickBooks
// alone reads as not reconciled with us, and the report says so in those words.
async function reconciledThrough(
  tx: Tx,
  tenantId: string,
  connectionId: string,
): Promise<Record<string, string>> {
  const marker = `|qbo:${connectionId}:`;
  const rows = await tx
    .select({
      pairKey: reconciliation.pairKey,
      asOf: sql<string>`max(${reconciliation.asOf})::text`,
    })
    .from(reconciliation)
    .where(
      and(
        eq(reconciliation.tenantId, tenantId),
        eq(reconciliation.status, "signed_off"),
        sql`strpos(${reconciliation.pairKey}, ${marker}) > 0`,
      ),
    )
    .groupBy(reconciliation.pairKey);
  const out: Record<string, string> = {};
  for (const r of rows) {
    const account = r.pairKey.slice(r.pairKey.indexOf(marker) + marker.length);
    if (!account || (out[account] && out[account] >= r.asOf)) continue;
    out[account] = r.asOf;
  }
  return out;
}
