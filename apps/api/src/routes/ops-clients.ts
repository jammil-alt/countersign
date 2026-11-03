// Back office: clients, their connections, runs across clients, and the operator inbox
// (ARCHITECTURE §14). Every handler runs inside withOperator(the clients this operator serves).

import { applyMatrixChange } from "@countersign/connectors";
import { routes } from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  connectionChange,
  externalAction,
  inboxItem,
  membership,
  run,
  stepRun,
  type Tx,
  tenant,
  toolCall,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, count, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { resolveInboxItem } from "../inbox";
import { dispatchEvents } from "../runs/dispatch";
import {
  agentSummary,
  matrixEdit,
  opsAction,
  opsConnection,
  opsInboxItem,
  opsRun,
  opsStep,
  opsToolCall,
} from "./mappers";

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function clientSummaries(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(tenant)
    .where(inArray(tenant.id, [...ids]))
    .orderBy(tenant.name);
  const agents = await tx
    .select({ tenantId: agent.tenantId, n: count() })
    .from(agent)
    .where(and(inArray(agent.tenantId, [...ids]), eq(agent.kind, "client")))
    .groupBy(agent.tenantId);
  const open = await tx
    .select({ tenantId: inboxItem.tenantId, n: count() })
    .from(inboxItem)
    .where(and(inArray(inboxItem.tenantId, [...ids]), eq(inboxItem.status, "open")))
    .groupBy(inboxItem.tenantId);
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    timezone: t.timezone,
    createdAt: t.createdAt.toISOString(),
    agents: agents.find((a) => a.tenantId === t.id)?.n ?? 0,
    openInbox: open.find((o) => o.tenantId === t.id)?.n ?? 0,
  }));
}

async function connectionInScope(tx: Tx, tenantIds: readonly string[], id: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.id, id), inArray(connection.tenantId, [...tenantIds])));
  if (!row) throw notFound("connection");
  return row;
}

export function opsClientRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClients, async (ctx) => ({
    clients: await clientSummaries(ctx.tx, ctx.tenantIds),
  }));

  mount(app, routes.opsCreateClient, async ({ tx, body, session, tenantIds, services }) => {
    const timezone = body.timezone ?? "UTC";
    if (!validTimezone(timezone)) throw new HttpError(422, "invalid_timezone", timezone);
    const offered = body.connectorsOffered ?? [];
    for (const id of offered) {
      if (!services.platform.connectors.has(id)) {
        throw new HttpError(422, "unknown_connector", `no connector ${id}`);
      }
    }
    const [row] = await tx
      .insert(tenant)
      .values({ name: body.name, timezone, settings: { connectors_offered: offered } })
      .returning();
    if (!row) throw new Error("tenant insert returned nothing");
    // DECISION: the operator who creates a client serves it. The new client is added to this
    // transaction's scope so its first membership passes row-level security in the same commit;
    // the id is the one just inserted, never taken from the request.
    await tx.execute(
      sql`select set_config('app.tenant_ids', ${`{${[...tenantIds, row.id].join(",")}}`}, true)`,
    );
    await tx
      .insert(membership)
      .values({ tenantId: row.id, userId: session.user.id, role: "operator" });
    const [summary] = await clientSummaries(tx, [row.id]);
    if (!summary) throw new Error("the new client is not visible");
    return { client: summary };
  });

  mount(app, routes.opsClient, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.id);
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    const agents = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, t.id), eq(agent.kind, "client")))
      .orderBy(agent.slug);
    const connections = await tx
      .select()
      .from(connection)
      .where(eq(connection.tenantId, t.id))
      .orderBy(connection.connector);
    const members = await tx
      .select({
        userId: membership.userId,
        email: appUser.email,
        name: appUser.name,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .where(eq(membership.tenantId, t.id))
      .orderBy(appUser.email);
    return {
      client: {
        id: t.id,
        name: t.name,
        timezone: t.timezone,
        settings: t.settings,
        createdAt: t.createdAt.toISOString(),
      },
      agents: agents.map(agentSummary),
      connections: connections.map(opsConnection),
      members,
    };
  });

  mount(app, routes.opsClientConnections, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const rows = await ctx.tx
      .select()
      .from(connection)
      .where(eq(connection.tenantId, ctx.params.id))
      .orderBy(connection.connector);
    return { connections: rows.map(opsConnection) };
  });

  mount(app, routes.opsUpdateConnection, async ({ tx, params, body, tenantIds, session }) => {
    const row = await connectionInScope(tx, tenantIds, params.id);
    const set: Partial<typeof connection.$inferInsert> = {};
    const changes: Record<string, unknown>[] = [];
    if (body.permissions) {
      const r = applyMatrixChange({
        current: row.permissions,
        proposed: matrixEdit(body.permissions),
        by: "operator",
      });
      if (!r.ok) throw new HttpError(422, r.reason, r.message);
      if (r.changed) {
        set.permissions = r.matrix;
        changes.push({ ...r.change });
      }
    }
    if (body.config) {
      set.config = body.config;
      changes.push({ kind: "config", before: row.config, after: body.config });
    }
    if (changes.length === 0) return { connection: opsConnection(row) };
    const [updated] = await tx
      .update(connection)
      .set(set)
      .where(and(eq(connection.id, row.id), eq(connection.tenantId, row.tenantId)))
      .returning();
    for (const change of changes) {
      await tx.insert(connectionChange).values({
        tenantId: row.tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change,
      });
    }
    if (!updated) throw new Error("connection update returned nothing");
    return { connection: opsConnection(updated) };
  });

  // ── Runs ───────────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsRuns, async (ctx) => {
    const { tx, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const where: SQL[] = [inArray(run.tenantId, [...ctx.tenantIds])];
    if (query.client) where.push(eq(run.tenantId, query.client));
    if (query.status) where.push(eq(run.status, query.status));
    if (query.agent) where.push(eq(run.agentId, query.agent));
    if (query.mode) where.push(eq(run.mode, query.mode));
    const rows = await tx
      .select()
      .from(run)
      .where(and(...where))
      .orderBy(desc(run.createdAt))
      .limit(query.limit);
    return { runs: rows.map(opsRun) };
  });

  mount(app, routes.opsRun, async ({ tx, params, tenantIds }) => {
    const [r] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, params.id), inArray(run.tenantId, [...tenantIds])));
    if (!r) throw notFound("run");
    const steps = await tx
      .select()
      .from(stepRun)
      .where(and(eq(stepRun.runId, r.id), eq(stepRun.tenantId, r.tenantId)))
      .orderBy(stepRun.startedAt, stepRun.id);
    const calls = steps.length
      ? await tx
          .select()
          .from(toolCall)
          .where(
            and(
              eq(toolCall.tenantId, r.tenantId),
              inArray(
                toolCall.stepRunId,
                steps.map((s) => s.id),
              ),
            ),
          )
          .orderBy(toolCall.createdAt)
      : [];
    const actions = await tx
      .select()
      .from(externalAction)
      .where(and(eq(externalAction.runId, r.id), eq(externalAction.tenantId, r.tenantId)))
      .orderBy(externalAction.createdAt);
    const items = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, r.id), eq(inboxItem.tenantId, r.tenantId)))
      .orderBy(inboxItem.createdAt);
    return {
      run: opsRun(r),
      steps: steps.map(opsStep),
      toolCalls: calls.map(opsToolCall),
      actions: actions.map(opsAction),
      inbox: items.map(opsInboxItem),
    };
  });

  // ── Inbox ──────────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsInbox, async (ctx) => {
    const { tx, query } = ctx;
    if (query.client) ensureClient(ctx, query.client);
    const where: SQL[] = [
      inArray(inboxItem.tenantId, [...ctx.tenantIds]),
      eq(inboxItem.status, query.status),
    ];
    if (query.client) where.push(eq(inboxItem.tenantId, query.client));
    if (query.assigned === "operator") where.push(eq(inboxItem.assigneeRole, "operator"));
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(and(...where))
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    return { items: rows.map(opsInboxItem) };
  });

  mount(app, routes.opsResolveInbox, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    const [item] = await tx
      .select({ tenantId: inboxItem.tenantId })
      .from(inboxItem)
      .where(and(eq(inboxItem.id, params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    const collect: EventRow[] = [];
    const outcome = await resolveInboxItem(tx, {
      tenantId: item.tenantId,
      itemId: params.id,
      by: { userId: session.user.id, role: "operator" },
      body,
      registry: services.platform.events,
      collect,
    });
    const { resume } = outcome;
    if (resume) {
      ctx.afterCommit(() =>
        services.instances.sendEvent(resume.runId, { type: resume.type, payload: resume.payload }),
      );
    }
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    return { item: opsInboxItem(outcome.item) };
  });
}
