// v0.14 W4-B: Zoho CRM sync for one connection (docs/plan.md §1.9 "Sync (W4-B)"; ARCHITECTURE
// §6.7). One page per call: read the stored cursor, read the next page from Zoho (the connector's
// `syncPage`), store its raw records, events and the next cursor in one transaction for the
// connection's one client. Raw records are unique per version, so a page read twice is harmless.
// The cron polls every connected Zoho; Zoho's notifications ask for the same poll right away, and
// the cron renews the watch that sends them. Nothing is processed inline.

import { dbConnectionAttention } from "@countersign/agents";
import {
  attentionReasonOf,
  type ConnectionRef,
  type CredentialsAccessor,
  noopLogger,
  ReconnectRequiredError,
  readZohoFieldCache,
  readZohoSyncCursor,
  ZOHO_CRM_CONNECTOR_ID,
  ZOHO_FIELD_CACHE_KEY,
  ZOHO_FIELD_CACHE_MS,
  ZOHO_RECORD_CHANGED_EVENT,
  ZOHO_WATCH_HOURS,
  type ZohoCrmConnector,
  type ZohoFieldCache,
  type ZohoRecordChangedPayload,
  type ZohoSyncedModule,
  zohoFieldCacheStale,
  zohoNotifyToken,
  zohoVersionTime,
} from "@countersign/connectors";
import { connection, type Db, rawRecord, type Tx, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { eventTypesRouted } from "@countersign/workflows";
import { and, desc, eq, ne } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import type { RegisteredPack } from "../packs";
import type { Platform } from "../platform";
import { routableAgents, senseEmitter } from "../runs/dispatch";

export interface ZohoSyncDeps {
  db: Db;
  platform: Platform;
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
  now?: () => Date;
}

export interface ZohoSyncStepResult {
  done: boolean;
  stored: number;
  /** Raw records marked deleted (records deleted in Zoho). */
  deleted?: number;
  skipped?: string;
  events: EventRow[];
}

/** Where the connection's `sync_cursor` keeps when its last full pass ended (null: one is open). */
export const ZOHO_PASS_DONE_KEY = "zohoPassDoneAt";

/** Whether a record's modification time is after a pass's quiet line (unknown: it isn't). */
function changedAfter(modifiedTime: string | null, quietUntil: string): boolean {
  const at = modifiedTime ? Date.parse(modifiedTime) : Number.NaN;
  return Number.isFinite(at) && at > Date.parse(quietUntil);
}

/** The registered Zoho connector, with its sync (null where it isn't registered). */
export function zohoConnectorOf(platform: Platform): ZohoCrmConnector | null {
  const c = platform.connectors.get(ZOHO_CRM_CONNECTOR_ID) as ZohoCrmConnector | undefined;
  return c && typeof c.syncPage === "function" ? c : null;
}

export function refOf(row: typeof connection.$inferSelect): ConnectionRef {
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

export async function connectedRow(deps: ZohoSyncDeps, tenantId: string, connectionId: string) {
  const row = await withTenant(deps.db, tenantId, async (tx) => {
    const [r] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
    return r;
  });
  if (!row || row.connector !== ZOHO_CRM_CONNECTOR_ID) return { skip: "no such Zoho connection" };
  if (row.status !== "connected") return { skip: `the connection is ${row.status}` };
  return { row };
}

export function contextOf(deps: ZohoSyncDeps, row: typeof connection.$inferSelect) {
  const ref = refOf(row);
  return {
    tenantId: row.tenantId,
    connection: ref,
    credentials: deps.credentials(ref),
    logger: noopLogger,
    now: deps.now ?? (() => new Date()),
  };
}

/** A sign-in Zoho no longer takes: the connection needs the client (both surfaces show it). */
async function needsSignIn(deps: ZohoSyncDeps, tenantId: string, connectionId: string, e: Error) {
  const collect: EventRow[] = [];
  const emitter = senseEmitter(deps.platform.events, { collect });
  await dbConnectionAttention(deps.db, { emit: emitter }).needsAttention(tenantId, {
    connectionId,
    reason: attentionReasonOf(e),
    detail: e.message,
  });
  return collect;
}

/** Reads and stores the next page for one connection. */
export async function zohoSyncStep(
  deps: ZohoSyncDeps,
  params: { tenantId: string; connectionId: string },
): Promise<ZohoSyncStepResult> {
  const { tenantId, connectionId } = params;
  const skip = (why: string, events: EventRow[] = []) => ({
    done: true,
    stored: 0,
    skipped: why,
    events,
  });
  const connector = zohoConnectorOf(deps.platform);
  if (!connector) return skip("Zoho CRM is not registered here");
  const found = await connectedRow(deps, tenantId, connectionId);
  if (!found.row) return skip(found.skip);
  const row = found.row;
  let page: Awaited<ReturnType<ZohoCrmConnector["syncPage"]>>;
  try {
    page = await connector.syncPage(contextOf(deps, row), row.syncCursor);
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      return skip(
        attentionReasonOf(error) === "refresh_failing"
          ? "we can't reach Zoho right now and are looking into it"
          : "the client needs to sign in to Zoho again",
        await needsSignIn(deps, tenantId, connectionId, error),
      );
    }
    throw error;
  }
  const now = (deps.now ?? (() => new Date()))();
  const storedIds: string[] = [];
  const result = await withTenant(deps.db, tenantId, async (tx) => {
    const events: EventRow[] = [];
    let stored = 0;
    for (const record of page.records) {
      const [raw] = await tx
        .insert(rawRecord)
        .values({
          tenantId,
          connectionId,
          connector: ZOHO_CRM_CONNECTOR_ID,
          entityType: record.entityType,
          externalId: record.externalId,
          externalVersion: record.externalVersion,
          payload: record.payload,
        })
        .onConflictDoNothing()
        .returning({ id: rawRecord.id });
      if (!raw) continue;
      stored += 1;
      storedIds.push(raw.id);
      // DECISION: a first sync is history (as QuickBooks' initial sync): its records raise no
      // events, so connecting Zoho doesn't start a run for every old lead.
      if (page.initial) continue;
      const modifiedTime = zohoVersionTime(record.externalVersion);
      // 2026-11-24: a pass that reads everything again (a connection's first full read after a
      // 90-day one) brings records we never held; only those changed after its quiet line are news.
      if (page.quietUntil && !changedAfter(modifiedTime, page.quietUntil)) continue;
      const earlier = await tx
        .select({ version: rawRecord.externalVersion })
        .from(rawRecord)
        .where(
          and(
            eq(rawRecord.tenantId, tenantId),
            eq(rawRecord.connectionId, connectionId),
            eq(rawRecord.entityType, record.entityType),
            eq(rawRecord.externalId, record.externalId),
            ne(rawRecord.id, raw.id),
          ),
        )
        .orderBy(desc(rawRecord.syncedAt))
        .limit(5);
      // docs/plan.md §1.164: a record read again only because the connection now reads more of
      // its fields (the same modification time as a version we hold) changed nothing in Zoho.
      if (earlier.some((e) => zohoVersionTime(e.version) === modifiedTime)) continue;
      const payload: ZohoRecordChangedPayload = {
        connectionId,
        rawRecordId: raw.id,
        module: record.entityType as ZohoSyncedModule,
        recordId: record.externalId,
        change: earlier.length > 0 ? "updated" : "created",
        modifiedTime,
      };
      const event = await emit(
        tx,
        {
          tenantId,
          type: ZOHO_RECORD_CHANGED_EVENT,
          subjectType: "raw_record",
          subjectId: raw.id,
          payload,
        },
        { registry: deps.platform.events },
      );
      if (event) events.push(event);
    }
    // 2026-11-24: records deleted in Zoho leave what a match searches. Raw records are never
    // changed but for `is_deleted` (invariant 3); every version we hold of the record is marked.
    let deleted = 0;
    for (const gone of page.deleted) {
      const marked = await tx
        .update(rawRecord)
        .set({ isDeleted: true })
        .where(
          and(
            eq(rawRecord.tenantId, tenantId),
            eq(rawRecord.connectionId, connectionId),
            eq(rawRecord.connector, ZOHO_CRM_CONNECTOR_ID),
            eq(rawRecord.entityType, gone.entityType),
            eq(rawRecord.externalId, gone.externalId),
            eq(rawRecord.isDeleted, false),
          ),
        )
        .returning({ id: rawRecord.id });
      deleted += marked.length;
    }
    // The poll's cursor sits beside whatever else the connection keeps there (the watch).
    const [current] = await tx
      .select({ cursor: connection.syncCursor })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)))
      .for("update");
    await tx
      .update(connection)
      .set({
        syncCursor: {
          ...((current?.cursor ?? {}) as Record<string, unknown>),
          zoho: page.next,
          // 2026-11-24: when the last pass over every module ended; null while one is under way.
          // The cron's daily poll and a step's catch-up read it (zohoPollDue, catchUpZoho).
          [ZOHO_PASS_DONE_KEY]: page.done ? now.toISOString() : null,
        },
        lastSyncAt: now,
      })
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
    return { done: page.done, stored, deleted, events };
  });
  await packsSynced(deps.db, deps.platform.packs, {
    tenantId,
    connectionId,
    connector: ZOHO_CRM_CONNECTOR_ID,
    rawRecordIds: storedIds,
  });
  return result;
}

/**
 * §1.164: after a sync page committed, each registered pack that keys this connector's records
 * (the Sales area) builds them, for a client with it on. A first sync's history counts too: it
 * raises no events, but its records are what a match searches. A pack's failure is reported and
 * the sync goes on; the next match brings the keys up to date anyway.
 */
export async function packsSynced(
  db: Db,
  packs: readonly RegisteredPack[],
  input: { tenantId: string; connectionId: string; connector: string; rawRecordIds: string[] },
): Promise<void> {
  if (input.rawRecordIds.length === 0) return;
  for (const pack of packs) {
    if (!pack.synced?.connectors.includes(input.connector)) continue;
    try {
      await pack.synced.run(db, input);
    } catch (error) {
      reportHandled(`${pack.manifest.id} keys after a ${input.connector} sync failed`, error, {
        job: "pack_synced",
        client: input.tenantId,
      });
    }
  }
}

/** Pages one sync reads at most; the next one goes on from the stored cursor. */
export const ZOHO_MAX_SYNC_PAGES = 20;

/**
 * Pages until the pass is over (or ZOHO_MAX_SYNC_PAGES). `dispatch` sends each page's events
 * after its transaction committed; the sweep sends any it misses.
 */
export async function runZohoSync(
  deps: ZohoSyncDeps,
  params: { tenantId: string; connectionId: string },
  dispatch: (eventIds: string[]) => Promise<unknown> = async () => {},
  maxPages = ZOHO_MAX_SYNC_PAGES,
): Promise<{ pages: number; stored: number; skipped?: string }> {
  let stored = 0;
  for (let i = 0; i < maxPages; i++) {
    const step = await zohoSyncStep(deps, params);
    stored += step.stored;
    if (step.events.length > 0) await dispatch(step.events.map((e) => e.id));
    if (step.skipped) return { pages: i + 1, stored, skipped: step.skipped };
    if (step.done) return { pages: i + 1, stored };
  }
  return { pages: maxPages, stored };
}

/** Pages a notification's sync reads (two passes over the four modules); the cron does the rest. */
export const ZOHO_NOTIFY_PAGES = 8;

// ── Notifications ───────────────────────────────────────────────────────────────────────────────

/** Where Zoho sends a connection's notifications. */
export function zohoNotifyUrl(origin: string, tenantId: string, connectionId: string): string {
  return `${origin}/api/hooks/zoho_crm/${tenantId}/${connectionId}`;
}

/** A watch is renewed when it is older than this (it lasts ZOHO_WATCH_HOURS). */
export const ZOHO_WATCH_RENEW_MS = 20 * 60 * 60 * 1000;

/**
 * Asks Zoho to notify us of this connection's changes when the last watch is older than
 * ZOHO_WATCH_RENEW_MS (or there is none), and notes when. Needs a deployment secret for the token
 * and the public origin for the address; without either, the poll alone keeps Zoho in step.
 */
// DECISION: a watch Zoho refuses (a connection signed in before the notifications scope, say) is
// noted and tried again a day later; the cron's poll keeps the records coming meanwhile.
export async function renewZohoWatch(
  deps: ZohoSyncDeps & { secret: string | undefined; origin: string | undefined },
  params: { tenantId: string; connectionId: string },
): Promise<"renewed" | "fresh" | "skipped" | "refused"> {
  if (!deps.secret || !deps.origin) return "skipped";
  const connector = zohoConnectorOf(deps.platform);
  if (!connector) return "skipped";
  const found = await connectedRow(deps, params.tenantId, params.connectionId);
  if (!found.row) return "skipped";
  const now = (deps.now ?? (() => new Date()))();
  const at = (found.row.syncCursor as { zohoWatch?: { at?: unknown } } | null)?.zohoWatch?.at;
  if (typeof at === "string" && now.getTime() - Date.parse(at) < ZOHO_WATCH_RENEW_MS) {
    return "fresh";
  }
  let outcome: "renewed" | "refused" = "renewed";
  try {
    await connector.watch(contextOf(deps, found.row), {
      notifyUrl: zohoNotifyUrl(deps.origin, params.tenantId, params.connectionId),
      token: await zohoNotifyToken(deps.secret, params.connectionId),
    });
  } catch (error) {
    if (error instanceof ReconnectRequiredError) return "skipped";
    // Never the token: only the connection and Zoho's own message.
    console.warn(
      `zoho watch for connection ${params.connectionId} refused: ${error instanceof Error ? error.message : "unknown"}`,
    );
    outcome = "refused";
  }
  await withTenant(deps.db, params.tenantId, async (tx) => {
    const [current] = await tx
      .select({ cursor: connection.syncCursor })
      .from(connection)
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, params.tenantId)))
      .for("update");
    await tx
      .update(connection)
      .set({
        syncCursor: {
          ...((current?.cursor ?? {}) as Record<string, unknown>),
          zohoWatch: { at: now.toISOString(), ok: outcome === "renewed" },
        },
      })
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, params.tenantId)));
  });
  return outcome;
}

// ── Field metadata (docs/plan.md §1.164 step 3) ─────────────────────────────────────────────────

/**
 * Keeps a connection's field list beside its cursor (`sync_cursor.zohoFields`), in the caller's
 * transaction for the connection's one client.
 */
// DECISION (docs/plan.md §1.164): the field list is kept in `sync_cursor`, beside the poll's cursor
// and the watch, not in `config`: it is what we read from Zoho, not a setting, so it never shows
// as a change to the connection's setup (Connectors C4), and the sync reads it from the cursor it
// is handed. No migration.
export async function storeZohoFieldCache(
  tx: Tx,
  params: { tenantId: string; connectionId: string },
  cache: ZohoFieldCache,
): Promise<void> {
  const where = and(
    eq(connection.id, params.connectionId),
    eq(connection.tenantId, params.tenantId),
  );
  const [current] = await tx
    .select({ cursor: connection.syncCursor })
    .from(connection)
    .where(where)
    .for("update");
  await tx
    .update(connection)
    .set({
      syncCursor: {
        ...((current?.cursor ?? {}) as Record<string, unknown>),
        [ZOHO_FIELD_CACHE_KEY]: cache,
      },
    })
    .where(where);
}

/**
 * Reads the connection's fields from Zoho when the kept list is older than `maxAgeMs` (or there is
 * none) and keeps them. A sign-in without the field scope is kept as `needs_sign_in` and asked
 * again a day later; a sign-in Zoho no longer takes is the poll's to report.
 */
export async function refreshZohoFields(
  deps: ZohoSyncDeps,
  params: { tenantId: string; connectionId: string },
  maxAgeMs = ZOHO_FIELD_CACHE_MS,
): Promise<"fresh" | "read" | "needs_sign_in" | "skipped"> {
  const connector = zohoConnectorOf(deps.platform);
  if (!connector) return "skipped";
  const found = await connectedRow(deps, params.tenantId, params.connectionId);
  if (!found.row) return "skipped";
  const now = (deps.now ?? (() => new Date()))();
  if (!zohoFieldCacheStale(readZohoFieldCache(found.row.syncCursor), now, maxAgeMs)) {
    return "fresh";
  }
  let cache: ZohoFieldCache;
  try {
    cache = await connector.fieldCache(contextOf(deps, found.row));
  } catch (error) {
    if (error instanceof ReconnectRequiredError) return "skipped";
    throw error;
  }
  await withTenant(deps.db, params.tenantId, (tx) => storeZohoFieldCache(tx, params, cache));
  return cache.status === "ok" ? "read" : "needs_sign_in";
}

// ── The cron ────────────────────────────────────────────────────────────────────────────────────

/** Every connected Zoho, client by client (each in its own withTenant, as QuickBooks'). */
export async function zohoConnections(
  db: Db,
): Promise<{ tenantId: string; connectionId: string }[]> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const out: { tenantId: string; connectionId: string }[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select({ id: connection.id })
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, ZOHO_CRM_CONNECTOR_ID),
            eq(connection.status, "connected"),
          ),
        ),
    );
    for (const r of rows) out.push({ tenantId: client.id, connectionId: r.id });
  }
  return out;
}

/** The cron's minute within each quarter hour for Zoho polls (9, 24, 39, 54). */
export const ZOHO_CRON_MINUTE = 9;

/** How long after a finished pass the next poll is due (owner, 2026-11-24: once a day). */
export const ZOHO_POLL_EVERY_MS = 24 * 60 * 60 * 1000;
/** A tick's slack, so a poll due at 09:09 isn't put off a day by a pass that ended at 09:09:30. */
const TICK_MS = 15 * 60 * 1000;

/** Why a connection is polled this tick. */
export type ZohoPollReason = "first" | "unfinished" | "daily" | "no_watch";

/**
 * Whether the cron polls a connection now, from its stored `sync_cursor` alone: a first sync, a
 * pass still under way (a full read of 50,000 records takes about 13 ticks of 20 pages), or a
 * day since the last pass ended. Null: not by these; the cron then asks `zohoWatchLive` and the
 * client's agents (zohoCronTick).
 */
// DECISION (owner, 2026-11-24: "poll once per day and then again when a relevant agent is
// triggered to run"): Zoho's notifications bring changes within seconds (each starts a poll), a
// step that reads the synced records catches up first (catchUpZoho), and this daily poll is the
// backstop for anything they missed. Cursors stored before the pass time was kept count as a pass
// under way, polled once more to record it.
export function zohoPollDue(syncCursor: unknown, now: Date): ZohoPollReason | null {
  const stored = (syncCursor ?? {}) as Record<string, unknown>;
  if (!readZohoSyncCursor(stored)) return "first";
  const doneAt = stored[ZOHO_PASS_DONE_KEY];
  if (typeof doneAt !== "string") return "unfinished";
  const at = Date.parse(doneAt);
  if (!Number.isFinite(at)) return "unfinished";
  return now.getTime() - at >= ZOHO_POLL_EVERY_MS - TICK_MS ? "daily" : null;
}

/** Whether Zoho took the connection's last watch and it hasn't lapsed: its changes notify us. */
export function zohoWatchLive(syncCursor: unknown, now: Date): boolean {
  const watch = (syncCursor as { zohoWatch?: { at?: unknown; ok?: unknown } } | null)?.zohoWatch;
  if (watch?.ok !== true || typeof watch.at !== "string") return false;
  const at = Date.parse(watch.at);
  return Number.isFinite(at) && now.getTime() - at < ZOHO_WATCH_HOURS * 60 * 60 * 1000;
}

/** Whether any of the client's running agents starts on a Zoho change (`zoho_crm.record.changed`). */
export async function startsOnZohoChanges(db: Db, tenantId: string): Promise<boolean> {
  const agents = await withTenant(db, tenantId, (tx) => routableAgents(tx, tenantId));
  return agents.some((a) => eventTypesRouted(a).includes(ZOHO_RECORD_CHANGED_EVENT));
}

/**
 * Every 15 minutes: renew each connected Zoho's watch when due and its field list once a day, then
 * poll the connections that are due (zohoPollDue), and, while Zoho's notifications don't reach us
 * for a connection (a sign-in made before their scope, or a refused watch), every 15 minutes the
 * ones whose client has an agent that starts on Zoho's changes, so that agent isn't a day late.
 */
export async function zohoCronTick(
  deps: ZohoSyncDeps & { secret: string | undefined; origin: string | undefined },
  dispatch: (tenantId: string, eventIds: string[]) => Promise<unknown>,
  at: Date,
): Promise<number> {
  if (at.getUTCMinutes() % 15 !== ZOHO_CRON_MINUTE) return 0;
  if (!zohoConnectorOf(deps.platform)) return 0;
  let synced = 0;
  for (const c of await zohoConnections(deps.db)) {
    try {
      await renewZohoWatch(deps, c);
      // docs/plan.md §1.164: the field list, once a day, before the poll that reads by it. A
      // failure here never stops the poll.
      await refreshZohoFields(deps, c).catch((error: unknown) =>
        reportHandled(`zoho fields of connection ${c.connectionId} failed`, error, {
          job: "zoho_sync",
          client: c.tenantId,
        }),
      );
      const found = await connectedRow(deps, c.tenantId, c.connectionId);
      if (!found.row) continue;
      const cursor = found.row.syncCursor;
      const due =
        zohoPollDue(cursor, at) ??
        (!zohoWatchLive(cursor, at) && (await startsOnZohoChanges(deps.db, c.tenantId))
          ? "no_watch"
          : null);
      if (!due) continue;
      await runZohoSync(deps, c, (ids) => dispatch(c.tenantId, ids));
      synced += 1;
    } catch (error) {
      reportHandled(`zoho sync of connection ${c.connectionId} failed`, error, {
        job: "zoho_sync",
        client: c.tenantId,
      });
    }
  }
  return synced;
}

// ── A step's catch-up (owner, 2026-11-24) ───────────────────────────────────────────────────────

/** A connection that ended a pass this recently isn't read again for a step. */
export const ZOHO_CATCH_UP_FRESH_MS = 5 * 60 * 1000;
/** Pages a step's catch-up reads at most (as a notification's: two passes over the modules). */
export const ZOHO_CATCH_UP_PAGES = ZOHO_NOTIFY_PAGES;

/**
 * Brings a client's synced Zoho records up to date before a step reads them (a tool whose spec
 * names `feed: "zoho_crm"`, the Sales area's match): each connected Zoho whose last pass ended
 * more than ZOHO_CATCH_UP_FRESH_MS ago reads what changed since, at most ZOHO_CATCH_UP_PAGES
 * pages. A full read still under way goes on a little and the cron does the rest; the step reads
 * what we hold.
 */
// DECISION: skipped when a pass ended in the last 5 minutes, so a loop of 50 rows or a run that
// matches twice reads Zoho once. Two or three calls when nothing changed (Zoho answers 304).
export async function catchUpZoho(
  deps: ZohoSyncDeps,
  tenantId: string,
  dispatch: (eventIds: string[]) => Promise<unknown> = async () => {},
): Promise<{ read: number; fresh: number }> {
  if (!zohoConnectorOf(deps.platform)) return { read: 0, fresh: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const rows = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({ id: connection.id, cursor: connection.syncCursor })
      .from(connection)
      .where(
        and(
          eq(connection.tenantId, tenantId),
          eq(connection.connector, ZOHO_CRM_CONNECTOR_ID),
          eq(connection.status, "connected"),
        ),
      ),
  );
  let read = 0;
  let fresh = 0;
  for (const row of rows) {
    const doneAt = ((row.cursor ?? {}) as Record<string, unknown>)[ZOHO_PASS_DONE_KEY];
    const at = typeof doneAt === "string" ? Date.parse(doneAt) : Number.NaN;
    if (Number.isFinite(at) && now.getTime() - at < ZOHO_CATCH_UP_FRESH_MS) {
      fresh += 1;
      continue;
    }
    await runZohoSync(deps, { tenantId, connectionId: row.id }, dispatch, ZOHO_CATCH_UP_PAGES);
    read += 1;
  }
  return { read, fresh };
}
