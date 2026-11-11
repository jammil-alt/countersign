// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's, for a
// client agent of a client they serve (inside withOperator).

import { getAgent } from "@countersign/agents";
import { type AgentTriggers, type PortalTrigger, routes } from "@countersign/core";
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

/**
 * The portal's view of an agent's triggers (Agent settings): the operator's list cut to plain facts
 * for the enabled jobs of the client's own agent. Its run filters, dedupe keys, hooks and people
 * filters stay the operator's (invariant 11).
 */
export function portalTriggerRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalAgentTriggers, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const row = await getAgent(ctx.tx, ctx.params.id).catch(() => null);
    if (!row || row.tenantId !== tenantId || row.kind !== "client" || row.testCopy) {
      throw notFound("service");
    }
    const list = await agentTriggers(
      ctx.tx,
      { id: row.id, tenantId, liveVersionId: row.liveVersionId },
      ctx.services.env.EMAIL_FORWARDING_DOMAIN,
    );
    return {
      commandName: list.commandName,
      triggers: list.triggers.filter((t) => t.enabled).map(portalTrigger),
    };
  });
}

function portalTrigger(t: AgentTriggers["triggers"][number]): PortalTrigger {
  const g = t.guards;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const client = g.client as { canRun?: unknown } | undefined;
  return {
    job: t.workflowName,
    type: t.type as PortalTrigger["type"],
    event: t.type === "event" ? str(g.event) : null,
    cron: t.type === "schedule" ? str(g.cron) : null,
    tz: t.type === "schedule" ? str(g.tz) : null,
    skipsHolidays: t.type === "schedule" && g.skipHolidays === true,
    clientCanRun: t.type === "manual" && client?.canRun === true,
    channels:
      t.type === "message" && Array.isArray(g.channels)
        ? g.channels.filter((c): c is string => typeof c === "string")
        : [],
    // A test run is never the client's: when its latest start was a test, none is shown.
    lastStartedAt: t.lastFired && t.lastFired.mode !== "test" ? t.lastFired.at : null,
  };
}
