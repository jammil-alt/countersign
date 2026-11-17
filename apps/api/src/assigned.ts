// A client user limited to some of the client's agents (docs/plan.md §1.122). Their list is read
// from `membership.agent_ids` in the request's own transaction, so a change by the client admin
// takes effect on their next request (not after the 5-minute carried-account window). A limited
// user reaches only the portal routes core's `ASSIGNED_USER_ROUTES` lists; those that name an
// agent, a run or an item answer only for the agents on the list.

import { seesAgent } from "@countersign/core";
import { membership, run, type Tx } from "@countersign/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { notFound } from "./http";

/** The agents a person is limited to in one client; null for every agent. */
export async function assignedAgents(
  tx: Tx,
  tenantId: string,
  userId: string,
): Promise<readonly string[] | null> {
  const [row] = await tx
    .select({ agentIds: membership.agentIds })
    .from(membership)
    .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, userId)));
  return row?.agentIds ?? null;
}

/** A where clause keeping rows of the agents on the list (none: every agent). */
export function agentWhere(column: PgColumn, agents: readonly string[] | null): SQL | undefined {
  if (agents === null) return undefined;
  if (agents.length === 0) return sql`false`;
  return inArray(column, [...agents]);
}

/** "Not found" for an agent this person may not see, as for another client's agent. */
export function ensureSeesAgent(agents: readonly string[] | null, agentId: string | null): void {
  if (!seesAgent(agents, agentId)) throw notFound("agent");
}

/** "Not found" for a run of an agent this person may not see (a missing run is left to the route). */
export async function ensureSeesRun(
  tx: Tx,
  tenantId: string,
  runId: string,
  agents: readonly string[] | null,
): Promise<void> {
  if (agents === null) return;
  const [row] = await tx
    .select({ agentId: run.agentId })
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
  if (row && !seesAgent(agents, row.agentId)) throw notFound("run");
}
