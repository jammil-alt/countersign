// v0.14 W4-C: the platform's record of writes a provider takes no idempotency key for (Slack's
// chat.postMessage; WriteAttemptServices in @countersign/connectors). Each is a raw record of the
// connection, never updated (invariant 3): `WriteAttempt` per key and attempt number, claimed once
// by the unique (connection, entity type, external id, version) key; `WriteRefused` when the
// provider answered with a refusal; `WriteDone` once with the result. One short withTenant
// transaction per call, for the connection's one client (invariant 1). No token is ever stored.

import type {
  ConnectionRef,
  WriteAttemptServices,
  WriteAttemptState,
} from "@countersign/connectors";
import type { JsonObject } from "@countersign/core";
import { type Db, rawRecord, withTenant } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";

export const WRITE_ATTEMPT_ENTITY = "WriteAttempt";
export const WRITE_REFUSED_ENTITY = "WriteRefused";
export const WRITE_DONE_ENTITY = "WriteDone";

export function dbWriteAttempts(db: Db, connection: ConnectionRef): WriteAttemptServices {
  const tenantId = connection.tenantId;
  const base = {
    tenantId,
    connectionId: connection.id,
    connector: connection.connector,
  };
  return {
    stateFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx): Promise<WriteAttemptState> => {
        const rows = await tx
          .select({
            entityType: rawRecord.entityType,
            version: rawRecord.externalVersion,
            payload: rawRecord.payload,
            at: rawRecord.syncedAt,
          })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.externalId, idempotencyKey),
              inArray(rawRecord.entityType, [
                WRITE_ATTEMPT_ENTITY,
                WRITE_REFUSED_ENTITY,
                WRITE_DONE_ENTITY,
              ]),
            ),
          );
        const attempts = rows
          .filter((r) => r.entityType === WRITE_ATTEMPT_ENTITY)
          .sort((a, b) => Number(a.version) - Number(b.version));
        const last = attempts.at(-1);
        const done = rows.find((r) => r.entityType === WRITE_DONE_ENTITY);
        const lastPayload = last?.payload as { details?: JsonObject } | undefined;
        return {
          done: ((done?.payload as { output?: JsonObject } | undefined)?.output ??
            null) as JsonObject | null,
          started: attempts.length,
          refused: rows.filter((r) => r.entityType === WRITE_REFUSED_ENTITY).length,
          last: last ? { details: lastPayload?.details ?? {}, startedAt: last.at } : null,
        };
      });
    },

    start({ idempotencyKey, attempt, details, at }) {
      return withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(rawRecord)
          .values({
            ...base,
            entityType: WRITE_ATTEMPT_ENTITY,
            externalId: idempotencyKey,
            externalVersion: String(attempt),
            payload: { idempotencyKey, attempt, details, startedAt: at.toISOString() },
            syncedAt: at,
          })
          .onConflictDoNothing()
          .returning({ id: rawRecord.id });
        return inserted.length === 1;
      });
    },

    refused({ idempotencyKey, attempt, reason, at }) {
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(rawRecord)
          .values({
            ...base,
            entityType: WRITE_REFUSED_ENTITY,
            externalId: idempotencyKey,
            externalVersion: String(attempt),
            payload: {
              idempotencyKey,
              attempt,
              reason: reason.slice(0, 200),
              at: at.toISOString(),
            },
            syncedAt: at,
          })
          .onConflictDoNothing();
      });
    },

    done({ idempotencyKey, output, at }) {
      return withTenant(db, tenantId, async (tx) => {
        await tx
          .insert(rawRecord)
          .values({
            ...base,
            entityType: WRITE_DONE_ENTITY,
            externalId: idempotencyKey,
            externalVersion: null,
            payload: { idempotencyKey, output, at: at.toISOString() },
            syncedAt: at,
          })
          .onConflictDoNothing();
      });
    },
  };
}
