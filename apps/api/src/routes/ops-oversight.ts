// v0.13 W2-I: run oversight decisions across the clients the operator serves, for the agent lab
// (ARCHITECTURE §10.11; docs/plan.md §1.54). Back office only (invariant 11).

import { Decimal, type OpsOversightList, type OpsOversightQuery, routes } from "@countersign/core";
import { oversightDecision, run, type Tx } from "@countersign/db";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount } from "../http";
import { decisionView } from "../oversight/views";

/** Oversight decisions over these clients, newest first, with totals over those listed. */
export async function oversightList(
  tx: Tx,
  served: readonly string[],
  query: Pick<OpsOversightQuery, "agent" | "action" | "cause"> & { limit: number },
): Promise<OpsOversightList> {
  if (served.length === 0) {
    return { decisions: [], totals: { count: 0, costUsd: "0.0000", byAction: {} } };
  }
  const where: SQL[] = [inArray(oversightDecision.tenantId, [...served])];
  if (query.agent) where.push(eq(run.agentId, query.agent));
  if (query.action) where.push(eq(oversightDecision.action, query.action));
  if (query.cause) where.push(eq(oversightDecision.cause, query.cause));
  const rows = await tx
    .select({ d: oversightDecision, agentId: run.agentId, workflowSlug: run.workflowSlug })
    .from(oversightDecision)
    .innerJoin(
      run,
      and(eq(run.id, oversightDecision.runId), eq(run.tenantId, oversightDecision.tenantId)),
    )
    .where(and(...where))
    .orderBy(desc(oversightDecision.createdAt), desc(oversightDecision.id))
    .limit(query.limit);
  let cost = new Decimal(0);
  const byAction: Record<string, number> = {};
  for (const r of rows) {
    cost = cost.plus(r.d.costUsd);
    byAction[r.d.action] = (byAction[r.d.action] ?? 0) + 1;
  }
  return {
    decisions: rows.map((r) => ({
      ...decisionView(r.d),
      tenantId: r.d.tenantId,
      agentId: r.agentId,
      workflowSlug: r.workflowSlug,
    })),
    // DECISION: the totals are over the decisions listed (the newest `limit`), so the lab's
    // counts match what it shows.
    totals: { count: rows.length, costUsd: cost.toFixed(4), byAction },
  };
}

export function opsOversightRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsOversight, async (ctx) => {
    const { tx, tenantIds, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    return oversightList(tx, query.client ? [query.client] : [...tenantIds], query);
  });
}
