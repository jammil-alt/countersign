// A connection the platform found needing a person (ConnectionAttentionPort, docs/plan.md §1.28):
// a connector said the sign-in has expired or was revoked (ReconnectRequiredError), or reading
// keeps failing. In one client-scoped transaction the connection goes to `error`, the change is
// logged in `connection_change`, and `connection.needs_attention` goes into the outbox, so the
// event exists exactly when the status changed. A connection already in `error` is left as it is
// and nothing is emitted again: the issue is open until the client signs in again.
//
// `refresh_failing` (renewing our access has failed for a day, the grant itself not ended) is
// different: the connection stays `connected`, so syncs keep trying and nobody is asked to sign
// in again; the change is logged and the event emitted once while the issue is open, and the
// first call that works again closes it (`accessRestoredIn`).

import { FINGERPRINT_KEY, findingFingerprint } from "@countersign/core";
import {
  connection,
  connectionChange,
  type Db,
  inboxItem,
  type Tx,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ConnectionAttentionPort } from "../runtime/ports";
import type { Emit } from "./external-actions";

/** `connection_change.change.kind` when a `refresh_failing` issue closes by itself. */
export const ACCESS_RESTORED_CHANGE = "access_restored";

/** The connection's latest attention change (opened or closed), if any. */
async function lastAttention(tx: Tx, tenantId: string, connectionId: string) {
  const [last] = await tx
    .select({ change: connectionChange.change })
    .from(connectionChange)
    .where(
      and(
        eq(connectionChange.tenantId, tenantId),
        eq(connectionChange.connectionId, connectionId),
        sql`${connectionChange.change}->>'kind' in ('needs_attention', ${ACCESS_RESTORED_CHANGE})`,
      ),
    )
    .orderBy(desc(connectionChange.createdAt))
    .limit(1);
  return (last?.change ?? null) as Record<string, unknown> | null;
}

const refreshFailingOpen = (change: Record<string, unknown> | null) =>
  change?.kind === "needs_attention" && change.reason === "refresh_failing";

export function dbConnectionAttention(
  db: Db,
  options: { emit?: Emit } = {},
): ConnectionAttentionPort {
  return {
    needsAttention(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const mine = and(eq(connection.id, input.connectionId), eq(connection.tenantId, tenantId));
        const [row] = await tx
          .select({ status: connection.status, connector: connection.connector })
          .from(connection)
          .where(mine)
          .for("update");
        if (!row || row.status === "error") return;
        // DECISION: `refresh_failing` keeps the connection `connected` (the grant was not ended:
        // our keys, a provider's outage, the app disabled on the client's side). Setting `error`
        // would stop every sync and ask each client to sign in again after a bad secret or a
        // weekend outage; the finding (from the event) is what a person sees, once while open.
        const keep = input.reason === "refresh_failing";
        if (keep && refreshFailingOpen(await lastAttention(tx, tenantId, input.connectionId))) {
          return;
        }
        if (!keep) await tx.update(connection).set({ status: "error" }).where(mine);
        const detail = input.detail.slice(0, 500);
        await tx.insert(connectionChange).values({
          tenantId,
          connectionId: input.connectionId,
          actorId: null,
          change: {
            kind: "needs_attention",
            reason: input.reason,
            detail,
            before: row.status,
            after: keep ? row.status : "error",
          },
        });
        await options.emit?.(tx, tenantId, {
          type: "connection.needs_attention",
          subjectType: "connection",
          subjectId: input.connectionId,
          payload: {
            connectionId: input.connectionId,
            connector: row.connector,
            reason: input.reason,
            detail,
            sourceId: null,
          },
        });
      });
    },
  };
}

/**
 * A call on the connection worked again: an open `refresh_failing` issue closes (logged, and its
 * open findings resolved). Anything else is left as it is. In `tx`, scoped to the client.
 */
export async function accessRestoredIn(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const mine = and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId));
  const [row] = await tx.select({ id: connection.id }).from(connection).where(mine).for("update");
  if (!row || !refreshFailingOpen(await lastAttention(tx, tenantId, connectionId))) return false;
  await tx.insert(connectionChange).values({
    tenantId,
    connectionId,
    actorId: null,
    change: { kind: ACCESS_RESTORED_CHANGE },
  });
  const fingerprint = findingFingerprint({ kind: "connection_access", connectionId });
  await tx
    .update(inboxItem)
    .set({
      status: "resolved",
      resolvedAt: now,
      resolution: { by: "platform", reason: ACCESS_RESTORED_CHANGE },
    })
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.status, "open"),
        sql`${inboxItem.payload}->>${FINGERPRINT_KEY} = ${fingerprint}`,
      ),
    );
  return true;
}

/** `accessRestoredIn` in its own short transaction for the client. */
export function accessRestored(db: Db, tenantId: string, connectionId: string): Promise<boolean> {
  return withTenant(db, tenantId, (tx) => accessRestoredIn(tx, tenantId, connectionId));
}
