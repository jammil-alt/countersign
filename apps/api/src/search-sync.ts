// M45: the nightly search sync (docs/plan.md §1.75; docs/marketing-plan.md §4.4). For every
// connected search connection (Google Search Console, Bing Webmaster Tools), client by client:
// read the span its state plans (16 months the first time, then from a few days before the data's
// end), store one raw record per day and dimension set (unique per version, so a re-read stores
// nothing new), and keep the sync's state on the connection (`sync_cursor.search`): the day the
// data runs to, when it ran, and a failure in our own words. The Marketing pack's nightly pass
// normalises the records into its search tables half an hour later; nothing here names the pack.
// The connectors are named by their search sync, not by id: whichever registered connector has one.

import {
  type ConnectionContext,
  type ConnectionRef,
  type CredentialsAccessor,
  noopLogger,
  planSearchSync,
  readSearchSyncState,
  SearchImportError,
  type SearchSyncState,
  searchConnectorOf,
} from "@countersign/connectors";
import { connection, type Db, rawRecord, tenant, withTenant } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import { reportHandled } from "./observability/report";
import type { Platform } from "./platform";

export interface SearchSyncDeps {
  db: Db;
  platform: Platform;
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
  now?: () => Date;
}

/** The nightly sync's hour and minute (UTC), half an hour before the pack's nightly pass. */
// DECISION: the platform's cron, not the pack's nightly hook: the sync needs the client's
// credentials (the vault's key), which only apps/api holds, and it stores raw records like every
// other connector's sync; the pack normalises them in its own pass (03:41). 03:11 leaves the sync
// half an hour. Every other hour at :11, a connection that has never synced is read too, so the
// first import comes within the hour of the key being entered rather than the next night.
export const SEARCH_SYNC_HOUR = 3;
export const SEARCH_SYNC_MINUTE = 11;

/** What our own words say for a failure we didn't expect (never the error's own message). */
const UNEXPECTED = "the import failed unexpectedly; we try again tonight";

export interface SearchSyncOutcome {
  status: "ok" | "failed" | "skipped";
  stored: number;
  dataRunsTo: string | null;
  error?: string;
}

function refOf(row: typeof connection.$inferSelect): ConnectionRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connector: row.connector,
    status: row.status,
    externalAccountId: row.externalAccountId,
    config: row.config as ConnectionRef["config"],
    permissions: row.permissions,
  };
}

/** The registered connectors with a search sync, by id. */
export function searchConnectorIds(platform: Platform): string[] {
  return platform.connectors
    .list()
    .filter((c) => searchConnectorOf(c))
    .map((c) => c.manifest.id);
}

/** Reads and stores one connection's span, and keeps how it went. */
export async function syncSearchConnection(
  deps: SearchSyncDeps,
  params: { tenantId: string; connectionId: string },
): Promise<SearchSyncOutcome> {
  const { tenantId, connectionId } = params;
  const now = (deps.now ?? (() => new Date()))();
  const row = await withTenant(deps.db, tenantId, async (tx) => {
    const [r] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
    return r;
  });
  const connector = searchConnectorOf(row ? deps.platform.connectors.get(row.connector) : null);
  if (!row || !connector) return { status: "skipped", stored: 0, dataRunsTo: null };
  const before = readSearchSyncState(row.syncCursor);
  if (row.status !== "connected") {
    return { status: "skipped", stored: 0, dataRunsTo: before?.dataRunsTo ?? null };
  }
  const span = planSearchSync(before, now);
  const ref = refOf(row);
  const ctx: ConnectionContext = {
    tenantId,
    connection: ref,
    credentials: deps.credentials(ref),
    logger: noopLogger,
    now: () => now,
  };
  let state: SearchSyncState;
  let stored = 0;
  let error: string | undefined;
  try {
    const read = await connector.search.read(ctx, span);
    stored = await withTenant(deps.db, tenantId, async (tx) => {
      let n = 0;
      for (const record of read.records) {
        const [raw] = await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId,
            connector: row.connector,
            entityType: record.entityType,
            externalId: record.externalId,
            externalVersion: record.externalVersion,
            payload: record.payload,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        if (raw) n += 1;
      }
      return n;
    });
    const runsTo =
      read.lastDay && (!before?.dataRunsTo || read.lastDay > before.dataRunsTo)
        ? read.lastDay
        : (before?.dataRunsTo ?? null);
    state = {
      v: 1,
      dataRunsTo: runsTo,
      lastRunAt: now.toISOString(),
      lastOkAt: now.toISOString(),
      lastError: null,
    };
  } catch (e) {
    if (!(e instanceof SearchImportError)) {
      // Reported without the connection's credentials or the provider's body.
      reportHandled("search sync failed", e, {
        job: "search_sync",
        client: tenantId,
        connector: row.connector,
      });
    }
    error = e instanceof SearchImportError ? e.reason.slice(0, 500) : UNEXPECTED;
    // A failed run keeps the day the data runs to; nothing of the run is stored.
    state = {
      v: 1,
      dataRunsTo: before?.dataRunsTo ?? null,
      lastRunAt: now.toISOString(),
      lastOkAt: before?.lastOkAt ?? null,
      lastError: error,
    };
  }
  await withTenant(deps.db, tenantId, async (tx) => {
    const [current] = await tx
      .select({ cursor: connection.syncCursor })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)))
      .for("update");
    await tx
      .update(connection)
      .set({
        syncCursor: { ...((current?.cursor ?? {}) as Record<string, unknown>), search: state },
        ...(error ? {} : { lastSyncAt: now }),
      })
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
  });
  return {
    status: error ? "failed" : "ok",
    stored,
    dataRunsTo: state.dataRunsTo,
    ...(error ? { error } : {}),
  };
}

/** Every connected search connection, client by client (each in its own withTenant). */
export async function searchConnections(
  db: Db,
  platform: Platform,
): Promise<{ tenantId: string; connectionId: string; synced: boolean }[]> {
  const ids = searchConnectorIds(platform);
  if (ids.length === 0) return [];
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const out: { tenantId: string; connectionId: string; synced: boolean }[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select({ id: connection.id, cursor: connection.syncCursor })
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            inArray(connection.connector, ids),
            eq(connection.status, "connected"),
          ),
        ),
    );
    for (const r of rows) {
      out.push({
        tenantId: client.id,
        connectionId: r.id,
        synced: readSearchSyncState(r.cursor)?.lastRunAt != null,
      });
    }
  }
  return out;
}

/**
 * Hourly at :11: at 03:11 UTC every connected search connection, at the other hours only those
 * never synced. One connection's failure is kept on it and the tick goes on.
 */
export async function searchSyncTick(deps: SearchSyncDeps, at: Date): Promise<number> {
  if (at.getUTCMinutes() !== SEARCH_SYNC_MINUTE) return 0;
  const nightly = at.getUTCHours() === SEARCH_SYNC_HOUR;
  let synced = 0;
  for (const c of await searchConnections(deps.db, deps.platform)) {
    if (!nightly && c.synced) continue;
    try {
      await syncSearchConnection({ ...deps, now: () => at }, c);
      synced += 1;
    } catch (error) {
      reportHandled(`search sync of connection ${c.connectionId} failed`, error, {
        job: "search_sync",
        client: c.tenantId,
      });
    }
  }
  return synced;
}
