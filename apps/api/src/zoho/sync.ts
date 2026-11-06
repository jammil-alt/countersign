// v0.14 W4-B: Zoho CRM sync for one connection (docs/plan.md §1.9 "Sync (W4-B)"; ARCHITECTURE
// §6.7). One page per call: read the stored cursor, read the next page from Zoho (the connector's
// `syncPage`), store its raw records, events and the next cursor in one transaction for the
// connection's one client. Raw records are unique per version, so a page read twice is harmless.
// The cron polls every connected Zoho; Zoho's notifications ask for the same poll right away, and
// the cron renews the watch that sends them. Nothing is processed inline.

import { dbConnectionAttention } from "@countersign/agents";
import {
  type ConnectionRef,
  type CredentialsAccessor,
  noopLogger,
  ReconnectRequiredError,
  ZOHO_CRM_CONNECTOR_ID,
  ZOHO_RECORD_CHANGED_EVENT,
  type ZohoCrmConnector,
  type ZohoRecordChangedPayload,
  type ZohoSyncedModule,
  zohoNotifyToken,
} from "@countersign/connectors";
import { connection, type Db, rawRecord, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq, ne } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { senseEmitter } from "../runs/dispatch";

export interface ZohoSyncDeps {
  db: Db;
  platform: Platform;
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
  now?: () => Date;
}

export interface ZohoSyncStepResult {
  done: boolean;
  stored: number;
  skipped?: string;
  events: EventRow[];
}

/** The registered Zoho connector, with its sync (null where it isn't registered). */
export function zohoConnectorOf(platform: Platform): ZohoCrmConnector | null {
  const c = platform.connectors.get(ZOHO_CRM_CONNECTOR_ID) as ZohoCrmConnector | undefined;
  return c && typeof c.syncPage === "function" ? c : null;
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

async function connectedRow(deps: ZohoSyncDeps, tenantId: string, connectionId: string) {
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

function contextOf(deps: ZohoSyncDeps, row: typeof connection.$inferSelect) {
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
    reason: "signin_expired",
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
        "the client needs to sign in to Zoho again",
        await needsSignIn(deps, tenantId, connectionId, error),
      );
    }
    throw error;
  }
  const now = (deps.now ?? (() => new Date()))();
  return withTenant(deps.db, tenantId, async (tx) => {
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
      // DECISION: a first sync is history (as QuickBooks' initial sync): its records raise no
      // events, so connecting Zoho doesn't start a run for every old lead.
      if (page.initial) continue;
      const [earlier] = await tx
        .select({ id: rawRecord.id })
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
        .limit(1);
      const payload: ZohoRecordChangedPayload = {
        connectionId,
        rawRecordId: raw.id,
        module: record.entityType as ZohoSyncedModule,
        recordId: record.externalId,
        change: earlier ? "updated" : "created",
        modifiedTime: record.externalVersion,
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
    // The poll's cursor sits beside whatever else the connection keeps there (the watch).
    const [current] = await tx
      .select({ cursor: connection.syncCursor })
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)))
      .for("update");
    await tx
      .update(connection)
      .set({
        syncCursor: { ...((current?.cursor ?? {}) as Record<string, unknown>), zoho: page.next },
        lastSyncAt: now,
      })
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
    return { done: page.done, stored, events };
  });
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

/** Every 15 minutes: renew each connected Zoho's watch when due, then poll it. */
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
