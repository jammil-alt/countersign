// v0.12 W2-F: what a question's model call is told (docs/plan.md §1.49): the agents of the client
// (in the back office, of the clients served, with the clients and templates), the connectors a
// change can be made in, and today's date. Read in the request's scoped transaction; every query
// names the clients (invariant 1). Nothing of another client reaches a portal question.

import { ASK_CONTEXT_MAX, type AskContext, type AskSurface } from "@countersign/core";
import { agent, type Tx, tenant } from "@countersign/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Platform } from "../platform";

/** `YYYY-MM-DD` in UTC. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// DECISION: the portal's questions name the client's services (agents active, paused or retired:
// those whose runs its list shows), by agent and service name; drafts and test copies stay out.
const PORTAL_AGENT_STATUSES = ["active", "paused", "retired"] as const;

export async function askContext(
  tx: Tx,
  input: { surface: AskSurface; tenantIds: readonly string[]; platform: Platform; now: Date },
): Promise<AskContext> {
  const ids = [...input.tenantIds];
  const clients = ids.length
    ? await tx
        .select({ id: tenant.id, name: tenant.name })
        .from(tenant)
        .where(inArray(tenant.id, ids))
        .orderBy(asc(tenant.name))
    : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const agents = ids.length
    ? await tx
        .select({
          id: agent.id,
          tenantId: agent.tenantId,
          name: agent.name,
          serviceName: agent.serviceName,
        })
        .from(agent)
        .where(
          and(
            inArray(agent.tenantId, ids),
            eq(agent.kind, "client"),
            eq(agent.testCopy, false),
            ...(input.surface === "portal"
              ? [inArray(agent.runStatus, [...PORTAL_AGENT_STATUSES])]
              : []),
          ),
        )
        .orderBy(asc(agent.name), asc(agent.id))
        .limit(ASK_CONTEXT_MAX)
    : [];
  const connectors = input.platform.connectors
    .list()
    .map((c) => ({ id: c.manifest.id, name: c.manifest.name }));
  const today = utcDate(input.now);
  if (input.surface === "portal") {
    return {
      surface: "portal",
      today,
      agents: agents.map((a) => ({ id: a.id, name: a.name, serviceName: a.serviceName })),
      connectors,
    };
  }
  const templates = await tx
    .select({ id: agent.id, name: agent.name })
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.kind, "template")))
    .orderBy(asc(agent.name), asc(agent.id))
    .limit(ASK_CONTEXT_MAX);
  return {
    surface: "ops",
    today,
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      serviceName: a.serviceName,
      client: clientName.get(a.tenantId ?? "") ?? "",
    })),
    clients,
    templates,
    connectors,
  };
}
