// Grants (ARCHITECTURE §6.9, docs/plan.md §1.26): what one client agent may do through one bound
// connection. The binding is the grant; an `agent_grant` row only narrows it (a ceiling per verb,
// a subset of the connector's tools), and no row means no narrowing. Each change is an
// `agent_change` row (kind `grant`, before and after). Who may loosen is the caller's check: the
// operator up to the connection's matrix, client roles only tighten (apps/api).

import { GrantLimits, normalizeGrant } from "@countersign/core";
import { agent, agentChange, agentGrant, connection, type Tx } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { AgentsError, notFound } from "../errors";

export interface GrantRecord {
  agentId: string;
  connectionId: string;
  limits: GrantLimits;
  updatedBy: string | null;
  updatedAt: Date;
}

function recordOf(row: typeof agentGrant.$inferSelect): GrantRecord {
  // Rows are written through `setGrant` only; a row that no longer parses narrows to nothing
  // rather than widening: every verb off.
  const parsed = GrantLimits.safeParse(row.limits);
  return {
    agentId: row.agentId,
    connectionId: row.connectionId,
    limits: parsed.success
      ? parsed.data
      : { verbs: { read: "off", create: "off", update: "off", delete: "off" } },
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

/** The agent's grant on a connection, or null (no narrowing). */
export async function grantOf(
  tx: Tx,
  input: { tenantId: string; agentId: string; connectionId: string },
): Promise<GrantRecord | null> {
  const [row] = await tx
    .select()
    .from(agentGrant)
    .where(
      and(
        eq(agentGrant.tenantId, input.tenantId),
        eq(agentGrant.agentId, input.agentId),
        eq(agentGrant.connectionId, input.connectionId),
      ),
    );
  return row ? recordOf(row) : null;
}

/** Every grant row of a client (the Access page joins them to bindings). */
export async function grantsOfClient(tx: Tx, tenantId: string): Promise<GrantRecord[]> {
  const rows = await tx.select().from(agentGrant).where(eq(agentGrant.tenantId, tenantId));
  return rows.map(recordOf);
}

const same = (a: GrantLimits, b: GrantLimits) =>
  JSON.stringify(normalizeGrant(a)) === JSON.stringify(normalizeGrant(b));

/**
 * Sets a client agent's grant on one of its client's connections and logs the change. Returns
 * the grant as stored; an unchanged grant writes nothing.
 */
export async function setGrant(
  tx: Tx,
  input: {
    tenantId: string;
    agentId: string;
    connectionId: string;
    limits: unknown;
    actorId: string | null;
    /** Who changed it: the operator's side or the client's. */
    by: "operator" | "client";
  },
): Promise<GrantRecord> {
  const parsed = GrantLimits.safeParse(input.limits);
  if (!parsed.success) {
    throw new AgentsError("invalid_grant", `invalid grant: ${parsed.error.message}`);
  }
  const limits = normalizeGrant(parsed.data);
  const [a] = await tx
    .select({ id: agent.id, tenantId: agent.tenantId, kind: agent.kind })
    .from(agent)
    .where(and(eq(agent.id, input.agentId), eq(agent.tenantId, input.tenantId)))
    .for("update");
  if (!a) throw notFound("client agent");
  if (a.kind !== "client")
    throw new AgentsError("not_a_client_agent", "only client agents have grants");
  const [c] = await tx
    .select({ id: connection.id })
    .from(connection)
    .where(and(eq(connection.id, input.connectionId), eq(connection.tenantId, input.tenantId)));
  if (!c) throw notFound("connection");

  const before = await grantOf(tx, input);
  if (before && same(before.limits, limits)) return before;
  const [row] = await tx
    .insert(agentGrant)
    .values({
      tenantId: input.tenantId,
      agentId: input.agentId,
      connectionId: input.connectionId,
      limits,
      updatedBy: input.actorId,
    })
    .onConflictDoUpdate({
      target: [agentGrant.agentId, agentGrant.connectionId],
      set: { limits, updatedBy: input.actorId, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error("grant upsert returned nothing");
  await tx.insert(agentChange).values({
    tenantId: input.tenantId,
    agentId: input.agentId,
    actorId: input.actorId,
    change: {
      kind: "grant",
      by: input.by,
      connectionId: input.connectionId,
      before: before?.limits ?? null,
      after: limits,
    },
  });
  return recordOf(row);
}
