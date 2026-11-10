// R4 channels (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Communications"): the account's number
// and email and each agent's own. The portal reads them; the operator sets the account's here (an
// agent's own stay `PUT /api/ops/agents/:id/channels`, routes/reach.ts). Every request goes through
// mount(), which writes its audit row; a change of the account's also writes a `tenant_change`.
// Resolution is ../channels/resolve.ts.

import { AgentsError, channelOptions } from "@countersign/agents";
import { type OpsClientChannels, type PortalChannels, routes } from "@countersign/core";
import { agent, type Tx } from "@countersign/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { accountLines, agentLines, channelState, setAccountBindings } from "../channels/resolve";
import { type AppEnv, ensureClient, HttpError, mount } from "../http";
import { forwardingAddress } from "../reach/replies";
import { agentAddresses } from "../triggers/list";

/** The email addresses the lines name: each agent's own (§10.8) and the account's forwarding. */
async function emailsOf(tx: Tx, tenantId: string, domain: string | undefined) {
  const d = domain?.trim().toLowerCase();
  if (!d) return { agents: new Map<string, string>(), account: null };
  const forwarding = await forwardingAddress(tx, tenantId);
  return {
    agents: await agentAddresses(tx, tenantId, d),
    // An address on another domain (the domain changed) is not the account's any more.
    account: forwarding?.endsWith(`@${d}`) ? forwarding : null,
  };
}

/** The account's channels and each client agent's (not template test copies). */
async function channelsOf(
  tx: Tx,
  tenantId: string,
  domain: string | undefined,
): Promise<PortalChannels & { state: Awaited<ReturnType<typeof channelState>> }> {
  const state = await channelState(tx, tenantId);
  const emails = await emailsOf(tx, tenantId, domain);
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
    account: accountLines(state.account, state.connections, emails.account),
    agents: agents.map((a) => ({
      agentId: a.id,
      name: a.serviceName ?? a.name,
      channels: agentLines(a.channels as Record<string, string>, state.account, state.connections, {
        agentEmail: emails.agents.get(a.id) ?? null,
        accountEmail: emails.account,
      }),
    })),
  };
}

async function opsView(
  tx: Tx,
  tenantId: string,
  domain: string | undefined,
): Promise<OpsClientChannels> {
  const { state, account, agents } = await channelsOf(tx, tenantId, domain);
  return {
    clientId: tenantId,
    bindings: state.account,
    account,
    agents,
    options: await channelOptions(tx, tenantId),
  };
}

export function channelRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.portalChannels, async ({ tx, tenantIds, services }) => {
    const tenantId = tenantIds[0] as string;
    const { account, agents } = await channelsOf(
      tx,
      tenantId,
      services.env.EMAIL_FORWARDING_DOMAIN,
    );
    return { account, agents };
  });

  mount(app, routes.opsClientChannels, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return opsView(ctx.tx, ctx.params.id, ctx.services.env.EMAIL_FORWARDING_DOMAIN);
  });

  mount(app, routes.opsSetClientChannels, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    try {
      await setAccountBindings(tx, params.id, body.channels, session.user.id);
    } catch (error) {
      // The same check as an agent's own channels, answered as this route always has.
      if (error instanceof AgentsError && error.code === "invalid_state") {
        throw new HttpError(422, "invalid_channel", error.message);
      }
      throw error;
    }
    return opsView(tx, params.id, ctx.services.env.EMAIL_FORWARDING_DOMAIN);
  });
}
