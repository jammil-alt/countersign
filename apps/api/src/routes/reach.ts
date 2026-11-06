// Reach out (docs/plan.md §1.25): an agent's people (roles bound to contacts, with conditions),
// edited by the operator and by the client admin; its channels (each bound to a connection), the
// operator's alone; a client's recent reach-outs; and Mezonas' email sending per client (Resend:
// the client's domain and its DNS records, ours until it is verified). Every change is logged with
// who made it (agent_change, connection_change).

import {
  type AgentRow,
  agentRoles,
  channelOptions,
  getAgent,
  missingRoles,
  setChannels,
  setPeople,
} from "@countersign/agents";
import {
  createDomain,
  createSendingKey,
  type FetchLike,
  getDomain,
  globalFetch,
  RESEND_CONNECTOR_ID,
  ResendConfig,
  verifyDomain,
} from "@countersign/connectors";
import {
  type AgentChannels,
  type AgentPeople,
  consentBlockFor,
  type EmailSetup,
  type PeopleBindings,
  REACH_CHANNELS,
  type ReachChannel,
  routes,
} from "@countersign/core";
import {
  agent,
  connection,
  connectionChange,
  contact,
  directoryPeople,
  reachOut,
  type Tx,
} from "@countersign/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { reachContactOf } from "../messaging/contacts";
import { forwardingAddress } from "../reach/replies";
import { cipherFor, connectionCredentials } from "../secrets";
import { newConnectionMatrix } from "./ops-connectors";

async function peopleView(tx: Tx, row: AgentRow): Promise<AgentPeople> {
  const roles = await agentRoles(tx, row);
  const people = (row.people ?? {}) as PeopleBindings;
  // The client's directory: people with their organization (docs/plan.md §1.27).
  const contacts = (await directoryPeople(tx, row.tenantId as string)).slice(0, 2000);
  return {
    agentId: row.id,
    agentName: row.serviceName ?? row.name,
    roles,
    people,
    missing: missingRoles(roles, people),
    contacts: contacts.map(({ person: c, organization }) => {
      const reach = reachContactOf(c);
      return {
        id: c.id,
        name: c.name,
        title: c.title,
        organization: organization?.name ?? null,
        roles: c.roles ?? [],
        reachable: REACH_CHANNELS.filter((ch) => {
          const b = consentBlockFor(reach, ch);
          return b === null || b === "opted_out";
        }),
        optedOut: Boolean(c.optedOutAt),
      };
    }),
  };
}

async function channelsView(tx: Tx, row: AgentRow): Promise<AgentChannels> {
  return {
    agentId: row.id,
    channels: (row.channels ?? {}) as Partial<Record<ReachChannel, string>>,
    options: await channelOptions(tx, row.tenantId as string),
  };
}

async function clientAgent(tx: Tx, tenantIds: readonly string[], id: string): Promise<AgentRow> {
  const row = await getAgent(tx, id);
  if (row.kind !== "client" || !row.tenantId || !tenantIds.includes(row.tenantId)) {
    throw notFound("agent");
  }
  return row;
}

// ── Email setup ─────────────────────────────────────────────────────────────────────────────────

async function emailConnection(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, RESEND_CONNECTOR_ID)))
    .orderBy(asc(connection.createdAt))
    .limit(1);
  return row ?? null;
}

async function emailSetup(
  tx: Tx,
  tenantId: string,
  env: { RESEND_API_KEY?: string; RESEND_FALLBACK_DOMAIN?: string },
): Promise<EmailSetup> {
  const row = await emailConnection(tx, tenantId);
  const config = row ? ResendConfig.safeParse(row.config).data : undefined;
  return {
    available: Boolean(env.RESEND_API_KEY?.trim() && env.RESEND_FALLBACK_DOMAIN?.trim()),
    fallbackDomain: env.RESEND_FALLBACK_DOMAIN?.trim() || null,
    connection:
      row && config
        ? {
            connectionId: row.id,
            status: row.status,
            domain: config.domain,
            domainStatus: config.domainStatus,
            from: `${config.localPart}@${config.sendingDomain}`,
            records: config.records.map((r) => ({
              record: String(r.record ?? ""),
              name: String(r.name ?? ""),
              type: String(r.type ?? ""),
              value: String(r.value ?? ""),
              ttl: r.ttl === undefined || r.ttl === null ? null : String(r.ttl),
              priority: typeof r.priority === "number" ? r.priority : null,
              status: String(r.status ?? ""),
            })),
            checkedAt: config.checkedAt,
          }
        : null,
    replyTo: await forwardingAddress(tx, tenantId),
  };
}

export function reachRoutes(app: Hono<AppEnv>): void {
  // ── People (operator) ──
  mount(app, routes.opsAgentPeople, async (ctx) => {
    const row = await clientAgent(ctx.tx, ctx.tenantIds, ctx.params.id);
    return { people: await peopleView(ctx.tx, row) };
  });
  mount(app, routes.opsSetAgentPeople, async (ctx) => {
    const row = await clientAgent(ctx.tx, ctx.tenantIds, ctx.params.id);
    const updated = await setPeople(ctx.tx, {
      agentId: row.id,
      actorId: ctx.session.user.id,
      by: "operator",
      people: ctx.body.people,
    });
    return { people: await peopleView(ctx.tx, updated) };
  });

  // ── Channels (operator only) ──
  mount(app, routes.opsAgentChannels, async (ctx) => {
    const row = await clientAgent(ctx.tx, ctx.tenantIds, ctx.params.id);
    return { channels: await channelsView(ctx.tx, row) };
  });
  mount(app, routes.opsSetAgentChannels, async (ctx) => {
    const row = await clientAgent(ctx.tx, ctx.tenantIds, ctx.params.id);
    const updated = await setChannels(ctx.tx, {
      agentId: row.id,
      actorId: ctx.session.user.id,
      channels: ctx.body.channels,
    });
    return { channels: await channelsView(ctx.tx, updated) };
  });

  mount(app, routes.opsReachOuts, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const rows = await ctx.tx
      .select({ r: reachOut, name: contact.name })
      .from(reachOut)
      .innerJoin(
        contact,
        and(eq(contact.id, reachOut.contactId), eq(contact.tenantId, reachOut.tenantId)),
      )
      .where(eq(reachOut.tenantId, ctx.params.id))
      .orderBy(desc(reachOut.createdAt))
      .limit(100);
    return {
      items: rows.map(({ r, name }) => {
        const plan = (r.plan ?? {}) as { channels?: ReachChannel[] };
        return {
          id: r.id,
          agentId: r.agentId,
          contactId: r.contactId,
          contactName: name,
          role: r.role,
          purpose: r.purpose,
          urgency: r.urgency,
          status: r.status,
          outcome: r.outcome ?? null,
          reason: r.reason,
          channels: plan.channels ?? [],
          attempts: ((r.attempts ?? []) as { status?: string }[]).filter((a) => a.status === "sent")
            .length,
          createdAt: r.createdAt.toISOString(),
          endedAt: r.endedAt?.toISOString() ?? null,
        };
      }),
    };
  });

  // ── Email sending (operator only) ──
  mount(app, routes.opsEmail, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return { setup: await emailSetup(ctx.tx, ctx.params.id, ctx.services.env) };
  });

  mount(app, routes.opsEmailConnect, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const tenantId = ctx.params.id;
    const { env } = ctx.services;
    const mainKey = env.RESEND_API_KEY?.trim();
    const fallback = env.RESEND_FALLBACK_DOMAIN?.trim().toLowerCase();
    if (!mainKey || !fallback) {
      throw new HttpError(409, "not_configured", "this deployment has no Resend account set up");
    }
    await cipherFor(env);
    const fetch: FetchLike = ctx.services.deps.fetch?.(env) ?? globalFetch();
    const existing = await emailConnection(ctx.tx, tenantId);
    const before = existing ? ResendConfig.safeParse(existing.config).data : undefined;
    // A new domain is added at Resend and its DNS records shown; we send from ours until verified.
    let domain = before?.domain ?? null;
    let domainId = before?.domainId ?? null;
    let records = before?.records ?? [];
    let domainStatus = before?.domainStatus ?? null;
    if (ctx.body.domain && ctx.body.domain !== domain) {
      const d = await createDomain(fetch, mainKey, ctx.body.domain);
      domain = d.name;
      domainId = d.id;
      records = d.records as Record<string, unknown>[];
      domainStatus = d.status;
    } else if (ctx.body.domain === null) {
      domain = null;
      domainId = null;
      records = [];
      domainStatus = null;
    }
    const sendingDomain = domain && domainStatus === "verified" ? domain : fallback;
    const config: ResendConfig = {
      domain,
      domainId,
      domainStatus,
      records,
      sendingDomain,
      localPart: ctx.body.localPart,
      fromName: ctx.body.fromName ?? null,
      replyTo: await forwardingAddress(ctx.tx, tenantId),
      checkedAt: new Date().toISOString(),
    };
    const sendingKey = await createSendingKey(fetch, mainKey, {
      name: `mezonas-${tenantId}`,
      domainId:
        sendingDomain === fallback ? (env.RESEND_FALLBACK_DOMAIN_ID?.trim() ?? null) : domainId,
    });
    let connectionId: string;
    if (existing) {
      connectionId = existing.id;
      await ctx.tx
        .update(connection)
        .set({ config: config as unknown as Record<string, unknown>, status: "connected" })
        .where(and(eq(connection.id, existing.id), eq(connection.tenantId, tenantId)));
    } else {
      const [made] = await ctx.tx
        .insert(connection)
        .values({
          tenantId,
          connector: RESEND_CONNECTOR_ID,
          status: "connected",
          externalAccountId: sendingDomain,
          config: config as unknown as Record<string, unknown>,
          // v0.12 W2-A: the operator's default access for new clients, else the connector's.
          permissions: await newConnectionMatrix(
            ctx.tx,
            ctx.services.platform.connectors.get(RESEND_CONNECTOR_ID)?.manifest,
          ),
          connectedBy: ctx.session.user.id,
        })
        .returning({ id: connection.id });
      if (!made) throw new Error("connection insert returned nothing");
      connectionId = made.id;
    }
    await ctx.tx.insert(connectionChange).values({
      tenantId,
      connectionId,
      actorId: ctx.session.user.id,
      change: { kind: "email_setup", domain, sendingDomain, localPart: ctx.body.localPart },
    });
    // The connection holds a sending-only key, never Mezonas' own.
    await (await connectionCredentials(ctx.tx, env, { id: connectionId, tenantId })).set({
      apiKey: sendingKey,
    });
    return { setup: await emailSetup(ctx.tx, tenantId, env) };
  });

  mount(app, routes.opsEmailVerify, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const tenantId = ctx.params.id;
    const { env } = ctx.services;
    const mainKey = env.RESEND_API_KEY?.trim();
    if (!mainKey) throw new HttpError(409, "not_configured", "no Resend account set up");
    const row = await emailConnection(ctx.tx, tenantId);
    const config = row ? ResendConfig.safeParse(row.config).data : undefined;
    if (!row || !config?.domainId) {
      throw new HttpError(409, "no_domain", "add the client's domain first");
    }
    const fetch: FetchLike = ctx.services.deps.fetch?.(env) ?? globalFetch();
    await verifyDomain(fetch, mainKey, config.domainId);
    const d = await getDomain(fetch, mainKey, config.domainId);
    const verified = d.status === "verified";
    const next: ResendConfig = {
      ...config,
      domainStatus: d.status,
      records: d.records as Record<string, unknown>[],
      checkedAt: new Date().toISOString(),
      sendingDomain: verified ? d.name : config.sendingDomain,
    };
    await ctx.tx
      .update(connection)
      .set({
        config: next as unknown as Record<string, unknown>,
        externalAccountId: next.sendingDomain,
      })
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
    await ctx.tx.insert(connectionChange).values({
      tenantId,
      connectionId: row.id,
      actorId: ctx.session.user.id,
      change: { kind: "email_verify", status: d.status },
    });
    if (verified && config.sendingDomain !== d.name) {
      // Now sending from the client's domain: a key for that domain replaces ours.
      const key = await createSendingKey(fetch, mainKey, {
        name: `mezonas-${tenantId}`,
        domainId: config.domainId,
      });
      await (await connectionCredentials(ctx.tx, env, row)).set({ apiKey: key });
    }
    return { setup: await emailSetup(ctx.tx, tenantId, env) };
  });

  // ── Portal: the client admin binds people (never channels) ──
  mount(app, routes.portalAgentPeople, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const rows = await ctx.tx
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.testCopy, false)))
      .orderBy(asc(agent.name));
    const items: AgentPeople[] = [];
    for (const row of rows) {
      if (row.status === "disabled" || row.runStatus === "retired") continue;
      const view = await peopleView(ctx.tx, row);
      if (view.roles.length) items.push(view);
    }
    return { items };
  });
  mount(app, routes.portalSetAgentPeople, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const updated = await setPeople(ctx.tx, {
      agentId: ctx.params.id,
      tenantId,
      actorId: ctx.session.user.id,
      by: "client",
      people: ctx.body.people,
    });
    return { people: await peopleView(ctx.tx, updated) };
  });
}
