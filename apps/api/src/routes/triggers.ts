// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's, for a
// client agent of a client they serve (inside withOperator).

import { getAgent } from "@countersign/agents";
import { routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import { agentTriggers } from "../triggers/list";

export function triggerRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsAgentTriggers, async (ctx) => {
    const row = await getAgent(ctx.tx, ctx.params.id);
    if (row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) throw notFound("agent");
    if (row.kind !== "client") throw new HttpError(422, "not_a_client_agent", "not a client agent");
    return agentTriggers(
      ctx.tx,
      { id: row.id, tenantId: row.tenantId, liveVersionId: row.liveVersionId },
      ctx.services.env.EMAIL_FORWARDING_DOMAIN,
    );
  });
}
