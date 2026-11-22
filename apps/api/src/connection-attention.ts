// Which of a client's connections need a person, and why: `error` (the grant is dead or a sync
// keeps failing: the client signs in again) or `refresh_failing` (renewing our access has failed
// for a day; it still shows as connected and the grant is not ended, so it is ours to look at,
// Connectors C4.2). The ops MCP server's `connections_list` and R5's account report read it alike.

import { ATTENTION_ISSUE_KINDS, refreshFailingOpen } from "@countersign/agents";
import type { ConnectionAttention } from "@countersign/core";
import { connection, connectionChange, type Tx } from "@countersign/db";
import { and, desc, inArray, sql } from "drizzle-orm";

// DECISION: a failing renewal counts as needing attention here as in the daily check (docs/plan.md
// §1.134), named apart from `error` so the operator knows the client need not sign in again.
export function attentionOf(
  status: string,
  issue: Record<string, unknown> | null | undefined,
): ConnectionAttention | null {
  if (status === "error") return "error";
  if (status === "connected" && refreshFailingOpen(issue)) return "refresh_failing";
  return null;
}

/** The clients' connections that need a person, with why; the others left out. */
export async function connectionsNeedingAttention(tx: Tx, tenantIds: readonly string[]) {
  if (tenantIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(connection)
    .where(inArray(connection.tenantId, [...tenantIds]))
    .orderBy(connection.tenantId, connection.connector);
  const connected = rows.filter((r) => r.status === "connected").map((r) => r.id);
  // Each connected connection's latest attention change (opened or closed), if any.
  const issues = connected.length
    ? await tx
        .selectDistinctOn([connectionChange.connectionId], {
          connectionId: connectionChange.connectionId,
          change: connectionChange.change,
        })
        .from(connectionChange)
        .where(
          and(
            inArray(connectionChange.tenantId, [...tenantIds]),
            inArray(connectionChange.connectionId, connected),
            sql`${connectionChange.change}->>'kind' in (${sql.join(
              ATTENTION_ISSUE_KINDS.map((k) => sql`${k}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(connectionChange.connectionId, desc(connectionChange.createdAt))
    : [];
  const issueOf = new Map(
    issues.map((i) => [i.connectionId, i.change as Record<string, unknown> | null]),
  );
  return rows.flatMap((row) => {
    const attention = attentionOf(row.status, issueOf.get(row.id));
    return attention ? [{ row, attention }] : [];
  });
}
