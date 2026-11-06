// v0.12 bankfeed: new bank and card transactions as events (ARCHITECTURE §6.11, docs/plan.md §1.52).
// A sync of one connection reads Plaid's `/transactions/sync` from the connection's cursor (network
// first), then, in one client transaction, stores each transaction version once as a raw record
// and emits `card.charge.created` (credit accounts) or `bank.transaction.created` (depository
// accounts) for each transaction seen for the first time. Plaid's webhook starts a sync of the one
// connection it names; the cron reads every connected feed once an hour as a backstop. A
// connection's first sync (and every sync until Plaid has pulled its history) stores and announces
// nothing old. An item that needs the client's sign-in puts the connection in `error`.

import { dbConnectionAttention, toConnectionRef } from "@countersign/agents";
import {
  BANKFEED_CONNECTOR_ID,
  BANKFEED_REMOVED_VERSION,
  BANKFEED_TRANSACTION_ENTITY,
  type BankfeedTransaction,
  type BankfeedTransactionCreatedPayload,
  bankfeedEventFor,
  bankfeedVersion,
  type ConnectionRef,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  isBankfeedConnector,
  noopLogger,
  ReconnectRequiredError,
} from "@countersign/connectors";
import { connection, type Db, rawRecord, type Tx, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { type DispatchDeps, dispatchEvents, senseEmitter } from "../runs/dispatch";
import { credentialsFor } from "../runs/execute";

/** The cron's minute of each hour for the bank feed backstop (apart from QuickBooks and Ramp). */
// DECISION: hourly, at minute 26. Plaid's webhook is the main trigger; the cron only catches a
// webhook that never came. Plaid itself refreshes an item a few times a day.
export const BANKFEED_CRON_MINUTE = 26;

/** Kept in `connection.sync_cursor`. */
// DECISION: the cursor names the item it belongs to, so a new item (after disconnecting and
// connecting again) starts over as a first sync; `announcing` turns on once Plaid has pulled the
// item's history, so the months Plaid backfills after connecting are stored, not announced.
const BankfeedCursor = z.object({
  plaid: z.literal(true),
  itemId: z.string().min(1).max(200),
  cursor: z.string().max(4096).nullable(),
  announcing: z.boolean(),
});
type BankfeedCursor = z.infer<typeof BankfeedCursor>;

export interface BankfeedSyncDeps {
  db: Db;
  platform: Platform;
  /** One connection's credentials, each read in its own client transaction. */
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
}

export interface BankfeedSyncOutcome {
  status: "synced" | "skipped" | "attention" | "busy";
  stored: number;
  events: EventRow[];
}

type ConnectionRow = typeof connection.$inferSelect;

/** The connected bank feeds, across clients, each found in its own client's transaction. */
async function feedConnections(db: Db): Promise<ConnectionRow[]> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const out: ConnectionRow[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select()
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, BANKFEED_CONNECTOR_ID),
            eq(connection.status, "connected"),
          ),
        ),
    );
    out.push(...rows);
  }
  return out;
}

/** The cron's call: every connected feed once an hour, then the events dispatched. */
export async function bankfeedCron(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">,
  deps: { platform: Platform } & DispatchDeps,
  at: Date,
): Promise<{ connections: number; stored: number } | null> {
  if (!env.ENCRYPTION_KEY || at.getUTCMinutes() !== BANKFEED_CRON_MINUTE) return null;
  if (!isBankfeedConnector(deps.platform.connectors.get(BANKFEED_CONNECTOR_ID))) return null;
  const syncDeps: BankfeedSyncDeps = {
    db: deps.db,
    platform: deps.platform,
    credentials: credentialsFor(deps.db, credentialKeysFromEnv(env)),
  };
  let connections = 0;
  let stored = 0;
  const events: EventRow[] = [];
  for (const row of await feedConnections(deps.db)) {
    try {
      const one = await syncBankfeedConnection(syncDeps, row, at);
      connections += 1;
      stored += one.stored;
      events.push(...one.events);
    } catch (error) {
      reportHandled("bank feed sync failed", error, { connector: BANKFEED_CONNECTOR_ID });
    }
  }
  if (events.length > 0) await dispatchEvents(deps, events);
  return { connections, stored };
}

/** The raw records already stored for these transaction ids in this connection. */
async function knownIds(tx: Tx, row: ConnectionRow, ids: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const found = await tx
      .selectDistinct({ id: rawRecord.externalId })
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.tenantId, row.tenantId),
          eq(rawRecord.connectionId, row.id),
          eq(rawRecord.entityType, BANKFEED_TRANSACTION_ENTITY),
          inArray(rawRecord.externalId, chunk),
        ),
      );
    for (const f of found) known.add(f.id);
  }
  return known;
}

/**
 * One connection's sync: Plaid first (outside any transaction), then one client transaction to
 * store and announce. Another sync of the same connection that finished first wins: this one's
 * reads are dropped (`busy`), as the other stored them already.
 */
export async function syncBankfeedConnection(
  deps: BankfeedSyncDeps,
  row: ConnectionRow,
  at: Date,
): Promise<BankfeedSyncOutcome> {
  const connector = deps.platform.connectors.get(BANKFEED_CONNECTOR_ID);
  if (!isBankfeedConnector(connector) || row.status !== "connected" || !row.externalAccountId) {
    return { status: "skipped", stored: 0, events: [] };
  }
  const itemId = row.externalAccountId;
  const parsed = BankfeedCursor.safeParse(row.syncCursor);
  const saved: BankfeedCursor | null =
    parsed.success && parsed.data.itemId === itemId ? parsed.data : null;
  const ref = toConnectionRef(row);
  let result: Awaited<ReturnType<typeof connector.transactionsSync>>;
  try {
    result = await connector.transactionsSync(
      {
        tenantId: row.tenantId,
        connection: ref,
        credentials: deps.credentials(ref),
        logger: noopLogger,
        now: () => at,
      },
      saved?.cursor ?? null,
    );
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      const events: EventRow[] = [];
      await dbConnectionAttention(deps.db, {
        emit: senseEmitter(deps.platform.events, { collect: events }),
      }).needsAttention(row.tenantId, {
        connectionId: row.id,
        reason: "signin_expired",
        detail: error.message,
      });
      return { status: "attention", stored: 0, events };
    }
    throw error;
  }
  if ("skipped" in result) return { status: "skipped", stored: 0, events: [] };
  const sync = result;
  // The first pass never announces; later ones do once Plaid has the item's history.
  const announcing = saved?.announcing === true;
  const historyDone =
    sync.updateStatus === "HISTORICAL_UPDATE_COMPLETE" ||
    (sync.updateStatus === null && sync.nextCursor !== null);
  const nextCursor: BankfeedCursor = {
    plaid: true,
    itemId,
    cursor: sync.nextCursor,
    announcing: announcing || (historyDone && sync.nextCursor !== null),
  };

  return withTenant(deps.db, row.tenantId, async (tx) => {
    const mine = and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId));
    const [now] = await tx
      .select({ syncCursor: connection.syncCursor, status: connection.status })
      .from(connection)
      .where(mine)
      .for("update");
    // Someone else's sync moved the cursor (or the client disconnected) while we read Plaid.
    if (
      now?.status !== "connected" ||
      JSON.stringify(now.syncCursor ?? null) !== JSON.stringify(row.syncCursor ?? null)
    ) {
      return { status: "busy" as const, stored: 0, events: [] };
    }
    const events: EventRow[] = [];
    let stored = 0;
    const store = async (
      t: BankfeedTransaction | { id: string; accountId: string | null; removed: true },
      version: string,
      deleted: boolean,
    ) => {
      const [inserted] = await tx
        .insert(rawRecord)
        .values({
          tenantId: row.tenantId,
          connectionId: row.id,
          connector: BANKFEED_CONNECTOR_ID,
          entityType: BANKFEED_TRANSACTION_ENTITY,
          externalId: t.id,
          externalVersion: version,
          payload: t,
          syncedAt: at,
          ...(deleted ? { isDeleted: true } : {}),
        })
        .onConflictDoNothing()
        .returning({ id: rawRecord.id });
      if (inserted) stored += 1;
      return inserted?.id ?? null;
    };

    const ids = [
      ...sync.added.map((t) => t.id),
      ...sync.added.flatMap((t) => (t.pendingTransactionId ? [t.pendingTransactionId] : [])),
      ...sync.removed.map((r) => r.id),
    ];
    const known = await knownIds(tx, row, [...new Set(ids)]);
    // Oldest first, so events arrive in the order the money moved.
    const added = [...sync.added].sort((a, b) =>
      a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date),
    );
    for (const t of added) {
      const rawRecordId = await store(t, await bankfeedVersion(t), false);
      // DECISION: a transaction is announced once: the first time its id is seen, and not when a
      // pending one we stored posts under a new id (`pendingTransactionId`), so a card charge
      // isn't announced twice. Changes and removals are stored as new versions and never
      // announced (invariant 3: the rows are never updated).
      const fresh =
        !known.has(t.id) && !(t.pendingTransactionId && known.has(t.pendingTransactionId));
      known.add(t.id);
      if (!rawRecordId || !fresh || !announcing) continue;
      const type = bankfeedEventFor(t);
      if (!type) continue;
      const payload: BankfeedTransactionCreatedPayload = {
        connectionId: row.id,
        rawRecordId,
        transaction: t,
      };
      const ev = await emit(
        tx,
        {
          tenantId: row.tenantId,
          type,
          subjectType: "raw_record",
          subjectId: rawRecordId,
          payload,
        },
        { registry: deps.platform.events },
      );
      if (ev) events.push(ev);
    }
    for (const t of sync.modified) await store(t, await bankfeedVersion(t), false);
    for (const r of sync.removed) {
      // Only a transaction we stored gets a "removed" row (what Plaid dropped before we saw it
      // leaves nothing).
      if (known.has(r.id)) {
        const tombstone = { id: r.id, accountId: r.accountId, removed: true as const };
        await store(tombstone, BANKFEED_REMOVED_VERSION, true);
      }
    }
    await tx.update(connection).set({ syncCursor: nextCursor, lastSyncAt: at }).where(mine);
    return { status: "synced" as const, stored, events };
  });
}

/** A webhook's sync of one item in one client: found by the item id, then synced. */
export async function syncBankfeedItem(
  deps: BankfeedSyncDeps,
  tenantId: string,
  itemId: string,
  at: Date,
): Promise<BankfeedSyncOutcome> {
  const [row] = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          eq(connection.connector, BANKFEED_CONNECTOR_ID),
          eq(connection.externalAccountId, itemId),
        ),
      )
      .limit(1),
  );
  if (!row) return { status: "skipped", stored: 0, events: [] };
  return syncBankfeedConnection(deps, row, at);
}
