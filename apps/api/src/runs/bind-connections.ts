// Which of a client's connections an agent is bound to, connector by connector.
import { connection, type Tx } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";

/**
 * The client's connection to bind for each needed connector: a connected one before any other,
 * the oldest first. Unless `rebind`, a connector already bound is left as it is; with it, one
 * bound to a connection that is no longer connected moves to a connected one, if there is one.
 */
// DECISION (staging, 2026-11-27): the Sandbox kept its first, never-connected QuickBooks
// connection beside the one connected later, and the oldest-first pick bound new test copies to
// the dead one ("the connection is disconnected"). Only a test copy is rebound: a client agent's
// binding is the operator's, and changes only when they change it.
export async function connectionsToBind(
  tx: Tx,
  input: {
    tenantId: string;
    needed: readonly string[];
    bindings: Readonly<Record<string, string>>;
    rebind: boolean;
  },
): Promise<Record<string, string>> {
  if (input.needed.length === 0) return {};
  const rows = await tx
    .select({ id: connection.id, connector: connection.connector, status: connection.status })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, input.tenantId),
        inArray(connection.connector, [...input.needed]),
      ),
    )
    .orderBy(connection.createdAt);
  const add: Record<string, string> = {};
  for (const c of input.needed) {
    const mine = rows.filter((r) => r.connector === c);
    const pick = mine.find((r) => r.status === "connected") ?? mine[0];
    if (!pick) continue;
    const bound = input.bindings[c];
    if (bound === undefined) {
      add[c] = pick.id;
      continue;
    }
    const current = mine.find((r) => r.id === bound);
    if (
      input.rebind &&
      pick.status === "connected" &&
      pick.id !== bound &&
      current?.status !== "connected"
    ) {
      add[c] = pick.id;
    }
  }
  return add;
}
