// A connection the platform found needing a person (ConnectionAttentionPort, docs/plan.md §1.28):
// a connector said the sign-in has expired or was revoked (ReconnectRequiredError), or reading
// keeps failing. In one client-scoped transaction the connection goes to `error`, the change is
// logged in `connection_change`, and `connection.needs_attention` goes into the outbox, so the
// event exists exactly when the status changed. A connection already in `error` is left as it is
// and nothing is emitted again: the issue is open until the client signs in again.

import { connection, connectionChange, type Db, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { ConnectionAttentionPort } from "../runtime/ports";
import type { Emit } from "./external-actions";

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
        await tx.update(connection).set({ status: "error" }).where(mine);
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
            after: "error",
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
