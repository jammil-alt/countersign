// R4 channels (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Communications"): the account's number
// and email and each agent's own. The portal reads them; the operator sets the account's here (an
// agent's own stay `PUT /api/ops/agents/:id/channels`, routes/reach.ts). Every request goes through
// mount(), which writes its audit row. Resolution is ../channels/resolve.ts.

import { channelOptions } from "@countersign/agents";
import { type OpsClientChannels, type PortalChannels, routes } from "@countersign/core";
import { agent, type Tx } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  accountLines,
  agentLines,
  bindingProblem,
  channelState,
  setAccountBindings,
} from "../channels/resolve";
import { type AppEnv, ensureClient, HttpError, mount } from "../http";

/** The account's channels and each client agent's (not template test copies). */
async function channelsOf(
  tx: Tx,
  tenantId: string,
): Promise<PortalChannels & { state: Awaited<ReturnType<typeof channelState>> }> {
  const state = await channelState(tx, tenantId);
  const agents = await tx
    .select({
      id: agent.id,
      name: agent.name,
      serviceName: agent.serviceName,
      channels: agent.channels,
    })
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), sql`not ${agent.testCopy}`))
    .orderBy(asc(agent.name), asc(agent.id));
  return {
    state,
    account: accountLines(state.account, state.connections),
    agents: agents.map((a) => ({
      agentId: a.id,
      name: a.serviceName ?? a.name,
      channels: agentLines(a.channels as Record<string, string>, state.account, state.connections),
    })),
  };
}

async function opsView(tx: Tx, tenantId: string): Promise<OpsClientChannels> {
  const { state, account, agents } = await channelsOf(tx, tenantId);
  return {
    clientId: tenantId,
    bindings: state.account,
    account,
    agents,
    options: await channelOptions(tx, tenantId),
  };
}

export function channelRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalChannels, async ({ tx, tenantIds }) => {
    const { account, agents } = await channelsOf(tx, tenantIds[0] as string);
    return { account, agents };
  });

  mount(app, routes.opsClientChannels, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return opsView(ctx.tx, ctx.params.id);
  });

  mount(app, routes.opsSetClientChannels, async (ctx) => {
    const { tx, params, body } = ctx;
    ensureClient(ctx, params.id);
    const { connections } = await channelState(tx, params.id);
    const problem = bindingProblem(body.channels, connections);
    if (problem) throw new HttpError(422, "invalid_channel", problem);
    await setAccountBindings(tx, params.id, body.channels);
    return opsView(tx, params.id);
  });
}
