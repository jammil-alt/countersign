// v0.12 W3-B: Ramp's new card transactions as events (ARCHITECTURE §6.11, docs/plan.md §1.52).
// Every 15 minutes the cron reads each connected Ramp's transactions since its last read (with a
// few days' overlap, as card transactions appear late), stores each new one once as a raw record
// and emits `ramp.transaction.created` for it in the same transaction. The first read of a new
// connection stores what it finds and emits nothing, so connecting doesn't start work for old
// purchases. A sign-in that has expired puts the connection in `error` (connection attention).

import { dbConnectionAttention, toConnectionRef } from "@countersign/agents";
import {
  type ConnectionRef,
  type CredentialsAccessor,
  credentialKeysFromEnv,
  noopLogger,
  RAMP_CONNECTOR_ID,
  RAMP_TRANSACTION_CREATED,
  RAMP_TRANSACTION_ENTITY,
  type RampTransaction,
  type RampTransactionCreatedPayload,
  ReconnectRequiredError,
  rampTransactionsSince,
} from "@countersign/connectors";
import { connection, type Db, rawRecord, tenant, withTenant } from "@countersign/db";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { type DispatchDeps, dispatchEvents, senseEmitter } from "../runs/dispatch";
import { credentialsFor } from "../runs/execute";

/** The cron's minute within each quarter hour for Ramp (9, 24, 39, 54), apart from QuickBooks'. */
export const RAMP_POLL_MINUTE = 9;
/**
 * How far back each read reaches before the last one. Raw records keep a transaction from being
 * announced twice, so the overlap only costs a page.
 */
// DECISION: 3 days. A card purchase can reach Ramp a day or two after it was made (its
// `user_transaction_time` is when it was made), so reading only since the last poll would miss it.
export const RAMP_POLL_OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;

/** Kept in `connection.sync_cursor`: when the last read began. */
const RampCursor = z.object({ ramp: z.literal(true), since: z.iso.datetime({ offset: true }) });

export interface RampPollDeps {
  db: Db;
  platform: Platform;
  /** One connection's credentials, each read and write in its own transaction (refreshes stick). */
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
}

export interface RampPollResult {
  connections: number;
  stored: number;
  /** The events emitted (to dispatch after the pass). */
  events: EventRow[];
}

/** The connected Ramps, across clients, each found in its own client's transaction. */
async function rampConnections(db: Db) {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const out: (typeof connection.$inferSelect)[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select()
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, RAMP_CONNECTOR_ID),
            eq(connection.status, "connected"),
          ),
        ),
    );
    out.push(...rows);
  }
  return out;
}

/**
 * The cron's call: the poll with the deployment's credentials, then its events dispatched. Nothing
 * where credentials can't be read (no ENCRYPTION_KEY).
 */
export async function rampCron(
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">,
  deps: { platform: Platform } & DispatchDeps,
  at: Date,
): Promise<RampPollResult | null> {
  if (!env.ENCRYPTION_KEY || at.getUTCMinutes() % 15 !== RAMP_POLL_MINUTE) return null;
  const result = await rampPollTick(
    {
      db: deps.db,
      platform: deps.platform,
      credentials: credentialsFor(deps.db, credentialKeysFromEnv(env)),
    },
    at,
  );
  if (result.events.length > 0) await dispatchEvents(deps, result.events);
  return result;
}

/** Every 15 minutes: new transactions of every connected Ramp. */
export async function rampPollTick(deps: RampPollDeps, at: Date): Promise<RampPollResult> {
  const result: RampPollResult = { connections: 0, stored: 0, events: [] };
  if (at.getUTCMinutes() % 15 !== RAMP_POLL_MINUTE) return result;
  if (!deps.platform.connectors.has(RAMP_CONNECTOR_ID)) return result;
  for (const row of await rampConnections(deps.db)) {
    try {
      const one = await pollRampConnection(deps, row, at);
      result.connections += 1;
      result.stored += one.stored;
      result.events.push(...one.events);
    } catch (error) {
      reportHandled("ramp poll failed", error, { connector: RAMP_CONNECTOR_ID });
    }
  }
  return result;
}

/** One connection's read: the network first, then one transaction to store and announce. */
export async function pollRampConnection(
  deps: RampPollDeps,
  row: typeof connection.$inferSelect,
  at: Date,
): Promise<{ stored: number; events: EventRow[] }> {
  const connector = deps.platform.connectors.get(RAMP_CONNECTOR_ID);
  if (!connector) return { stored: 0, events: [] };
  const cursor = RampCursor.safeParse(row.syncCursor);
  const first = !cursor.success;
  const since = new Date(
    (cursor.success ? Date.parse(cursor.data.since) : at.getTime()) - RAMP_POLL_OVERLAP_MS,
  );
  const ref = toConnectionRef(row);
  let transactions: RampTransaction[];
  try {
    ({ transactions } = await rampTransactionsSince(
      connector,
      {
        tenantId: row.tenantId,
        connection: ref,
        credentials: deps.credentials(ref),
        logger: noopLogger,
        now: () => at,
      },
      since,
    ));
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
      return { stored: 0, events };
    }
    throw error;
  }
  // DECISION: at most 10 pages of 100 a read (rampTransactionsSince). A business with more new
  // transactions in a quarter hour plus the overlap gets the rest on the next reads, which reach
  // back as far; none is announced twice.
  return withTenant(deps.db, row.tenantId, async (tx) => {
    const events: EventRow[] = [];
    let stored = 0;
    // Oldest first, so events arrive in the order the purchases were made.
    for (const t of [...transactions].reverse()) {
      const [inserted] = await tx
        .insert(rawRecord)
        .values({
          tenantId: row.tenantId,
          connectionId: row.id,
          connector: RAMP_CONNECTOR_ID,
          entityType: RAMP_TRANSACTION_ENTITY,
          externalId: t.id,
          externalVersion: null,
          payload: t,
          syncedAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: rawRecord.id });
      if (!inserted) continue;
      stored += 1;
      if (first) continue;
      const payload: RampTransactionCreatedPayload = {
        connectionId: row.id,
        rawRecordId: inserted.id,
        transaction: t,
      };
      const ev = await emit(
        tx,
        {
          tenantId: row.tenantId,
          type: RAMP_TRANSACTION_CREATED,
          subjectType: "raw_record",
          subjectId: inserted.id,
          payload,
        },
        { registry: deps.platform.events },
      );
      if (ev) events.push(ev);
    }
    await tx
      .update(connection)
      .set({ syncCursor: { ramp: true, since: at.toISOString() }, lastSyncAt: at })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)));
    return { stored, events };
  });
}
