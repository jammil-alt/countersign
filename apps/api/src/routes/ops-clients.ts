// Back office: clients, their connections, runs across clients, and the operator inbox
// (ARCHITECTURE §14). Every handler runs inside withOperator(the clients this operator serves).

import type { Approver } from "@countersign/agents";
import { applyMatrixChange } from "@countersign/connectors";
import {
  complianceOf,
  parseCoveredProcessors,
  processingRefusal,
  processorsForOffer,
  routes,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  connectionChange,
  externalAction,
  inboxItem,
  membership,
  modelCall,
  run,
  stepRun,
  type Tx,
  tenant,
  toolCall,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, count, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, HttpError, mount, notFound } from "../http";
import { resolveInboxItem } from "../inbox";
// v0.13 W2-I
import { runOversight } from "../oversight/views";
import { dispatchEvents } from "../runs/dispatch";
import { connectNoAuth } from "./connections";
import { withLanguage } from "./language";
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
import { inviteToClient, withApprovals } from "./onboarding";
import { canSignIn } from "./portal";
import { ensureFilterClients, runErrorGroups, runFilterWhere, runsPerDay } from "./run-controls";
import { addSupervisor } from "./supervisor";

/** The Sandbox client: `tenant.settings.sandbox` (docs/plan.md §1.2). */
export function isSandbox(settings: Record<string, unknown>): boolean {
  return settings.sandbox === true;
}

/**
 * The Sandbox client, for the routes that act in it from the back office as its client would
 * (connect its tools, upload its documents): 404 unless this operator serves the client, 403
 * `not_sandbox` for any other client.
 */
// DECISION: the operator connects tools only in the Sandbox client, their own test client with no
// client users (docs/plan.md §1.5): its no-sign-in tools, and since 2026-11-05 its OAuth tools with
// the operator's own sign-in. In a real client the client signs in from the portal, and the
// operator never connects on their behalf (ARCHITECTURE §6.1).
export async function sandboxClient(
  ctx: { tx: Tx; tenantIds: readonly string[] },
  id: string,
  refusal = "only the Sandbox client's tools are connected from the back office",
) {
  ensureClient(ctx, id);
  const [t] = await ctx.tx.select().from(tenant).where(eq(tenant.id, id));
  if (!t) throw notFound("client");
  if (!isSandbox(t.settings)) throw new HttpError(403, "not_sandbox", refusal);
  return t;
}

/** Which of these clients is the Sandbox, read from their settings. */
async function sandboxIds(tx: Tx, tenantIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(tenantIds)];
  const rows = ids.length
    ? await tx
        .select({ id: tenant.id, settings: tenant.settings })
        .from(tenant)
        .where(inArray(tenant.id, ids))
    : [];
  return new Set(rows.filter((t) => isSandbox(t.settings)).map((t) => t.id));
}

/**
 * The signed-in operator as the one resolving these clients' inbox items, per client. In the
 * Sandbox they resolve every item (packages/agents' `mayResolve`); which client is the Sandbox is
 * read from its settings here, never taken from a request.
 */
export async function operatorApprovers(
  tx: Tx,
  userId: string,
  tenantIds: readonly string[],
): Promise<(tenantId: string) => Approver> {
  const sandboxes = await sandboxIds(tx, tenantIds);
  return (tenantId) => ({
    userId,
    role: "operator",
    ...(sandboxes.has(tenantId) ? { sandbox: true } : {}),
  });
}

/** `tenant.settings.connectors_offered`, as connector ids. */
export function offeredConnectors(settings: Record<string, unknown>): string[] {
  const v = settings.connectors_offered;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

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
    .where(
      and(inArray(agent.tenantId, [...ids]), eq(agent.kind, "client"), eq(agent.status, "active")),
    )
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
    sandbox: isSandbox(t.settings as Record<string, unknown>),
  }));
}

/** The agents runs and inbox items name, for the back office's lists. */
async function agentRefs(tx: Tx, tenantIds: readonly string[], ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select()
    .from(agent)
    .where(and(inArray(agent.id, wanted), inArray(agent.tenantId, [...tenantIds])));
  return rows.map((a) => ({
    id: a.id,
    tenantId: a.tenantId,
    slug: a.slug,
    name: a.name,
    serviceName: a.serviceName,
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

  mount(app, routes.opsCreateClient, async (ctx) => {
    const { tx, body, session, tenantIds, services } = ctx;
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
      .values({
        name: body.name,
        timezone,
        // Approval stays with the client's admin unless the operator delegates it (ARCHITECTURE §4);
        // unset reads as the client admin.
        settings: withLanguage(
          body.approvals
            ? withApprovals({ connectors_offered: offered }, body.approvals)
            : { connectors_offered: offered },
          body.language,
        ),
      })
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
    // The client admin, invited in the same transaction (the email follows the commit).
    const invited = body.admin
      ? await inviteToClient(
          ctx,
          row.id,
          { ...body.admin, role: "client_admin" },
          { surface: "ops" },
        )
      : null;
    // Onboarding offers the supervisor (docs/plan.md §1.28): forked and published, ready to test.
    if (body.supervisor) {
      await addSupervisor(tx, {
        tenantId: row.id,
        actorId: session.user.id,
        platform: services.platform,
      });
    }
    const [summary] = await clientSummaries(tx, [row.id]);
    if (!summary) throw new Error("the new client is not visible");
    return { client: summary, admin: invited };
  });

  mount(app, routes.opsClient, async (ctx) => {
    const { tx, params } = ctx;
    ensureClient(ctx, params.id);
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    const agents = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.tenantId, t.id), eq(agent.kind, "client"), eq(agent.status, "active")))
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
    const { tx, params, services } = ctx;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    const rows = await tx
      .select()
      .from(connection)
      .where(eq(connection.tenantId, params.id))
      .orderBy(connection.connector);
    const agents = await tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.tenantId, params.id), eq(agent.kind, "client"), eq(agent.status, "active")),
      );
    const usedBy: Record<string, { id: string; name: string }[]> = {};
    for (const c of rows) {
      usedBy[c.id] = agents
        .filter((a) => a.runStatus !== "retired" && Object.values(a.bindings).includes(c.id))
        .map((a) => ({ id: a.id, name: a.serviceName ?? a.name }));
    }
    return {
      connections: rows.map(opsConnection),
      offered: offeredConnectors(t.settings),
      connectors: services.platform.connectors.list().map((c) => ({
        id: c.manifest.id,
        name: c.manifest.name,
        description: c.manifest.description,
        icon: c.manifest.icon ?? null,
        auth: c.manifest.auth,
        available: canSignIn(c),
        tools: c.manifest.tools.map((tool) => ({
          id: tool.id,
          description: tool.description,
          verb: tool.verb,
          sideEffect: tool.sideEffect,
        })),
      })),
      usedBy,
      sandbox: isSandbox(t.settings),
    };
  });

  mount(app, routes.opsConnectSandbox, async (ctx) => {
    const { tx, params, services, session } = ctx;
    const t = await sandboxClient(ctx, params.id);
    const id = await connectNoAuth(tx, {
      tenantId: t.id,
      connector: params.connector,
      platform: services.platform,
      actorId: session.user.id,
      by: "operator",
    });
    if (!offeredConnectors(t.settings).includes(params.connector)) {
      await tx
        .update(tenant)
        .set({
          settings: {
            ...t.settings,
            connectors_offered: [...offeredConnectors(t.settings), params.connector],
          },
        })
        .where(eq(tenant.id, t.id));
    }
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, id), eq(connection.tenantId, t.id)));
    if (!row) throw notFound("connection");
    return { connection: opsConnection(row) };
  });

  mount(app, routes.opsOfferConnectors, async (ctx) => {
    const { tx, params, body, services } = ctx;
    ensureClient(ctx, params.id);
    const offered = [...new Set(body.offered)];
    for (const id of offered) {
      if (!services.platform.connectors.has(id)) {
        throw new HttpError(422, "unknown_connector", `no connector ${id}`);
      }
    }
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id));
    if (!t) throw notFound("client");
    if (t.retiredAt) throw new HttpError(409, "retired", "this client is retired");
    // HIPAA mode (docs/plan.md §1.35): a connector that sends data to a vendor without a signed BAA
    // is never offered. Already offered ones stay offered only if they were covered when HIPAA mode
    // was turned on (it can't be turned on otherwise).
    const profile = complianceOf(t.settings);
    const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
    for (const id of offered) {
      const refusal = processingRefusal(
        profile,
        covered,
        processorsForOffer(id),
        `The ${id} connector`,
      );
      if (refusal) throw new HttpError(409, "hipaa", refusal);
    }
    // DECISION: withdrawing an offer leaves an existing connection as it is (the client still sees
    // and can disconnect it); it only stops new sign-ins.
    await tx
      .update(tenant)
      .set({ settings: { ...t.settings, connectors_offered: offered } })
      .where(eq(tenant.id, t.id));
    return { offered };
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
    // v0.12 W1-E: RunFilter, counts per day and groups by error (docs/plan.md §1.40).
    ensureFilterClients(ctx, query.filter);
    const where: SQL[] = [
      inArray(run.tenantId, [...ctx.tenantIds]),
      ...runFilterWhere(query.filter),
    ];
    const rows = await tx
      .select()
      .from(run)
      .where(and(...where))
      .orderBy(desc(run.createdAt))
      .limit(query.limit);
    const groups = query.groupBy === "error" ? await runErrorGroups(tx, where) : undefined;
    return {
      runs: rows.map(opsRun),
      agents: await agentRefs(tx, ctx.tenantIds, [
        ...rows.map((r) => r.agentId),
        ...(groups ?? []).flatMap((g) => g.agents),
      ]),
      ...(query.perDay ? { perDay: await runsPerDay(tx, where) } : {}),
      ...(groups ? { groups } : {}),
    };
  });

  mount(app, routes.opsRun, async ({ tx, params, tenantIds, session, services }) => {
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
    // v0.13 W2-H: which models each step ran on (a task skill's own, the agent's, or a step's).
    const modelRows = await tx
      .select({ stepRunId: modelCall.stepRunId, model: modelCall.model })
      .from(modelCall)
      .where(and(eq(modelCall.runId, r.id), eq(modelCall.tenantId, r.tenantId)))
      .orderBy(modelCall.createdAt, modelCall.id);
    const modelsByStep = new Map<string, string[]>();
    for (const c of modelRows) {
      const list = modelsByStep.get(c.stepRunId) ?? [];
      if (!list.includes(c.model)) list.push(c.model);
      modelsByStep.set(c.stepRunId, list);
    }
    const items = await tx
      .select()
      .from(inboxItem)
      .where(and(eq(inboxItem.runId, r.id), eq(inboxItem.tenantId, r.tenantId)))
      .orderBy(inboxItem.createdAt);
    const [version] = await tx
      .select({ version: agentVersion.version, bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(and(eq(agentVersion.id, r.agentVersionId), eq(agentVersion.tenantId, r.tenantId)));
    const wf = version?.bundle.workflows.find((w) => w.slug === r.workflowSlug);
    const [ref] = await agentRefs(tx, tenantIds, [r.agentId]);
    const operatorIn = await operatorApprovers(tx, session.user.id, [r.tenantId]);
    return {
      run: opsRun(r),
      steps: steps.map((s) => ({ ...opsStep(s), models: modelsByStep.get(s.id) ?? [] })),
      toolCalls: calls.map(opsToolCall),
      actions: actions.map((a) => opsAction(a, services.platform)),
      inbox: items.map((i) => opsInboxItem(i, operatorIn(i.tenantId), services.platform)),
      agent: ref ?? null,
      version: version?.version ?? null,
      workflow: wf ? { slug: wf.slug, name: wf.name, definition: wf.workflow } : null,
      // v0.13 W2-I: each oversight decision with its note, input change, model and cost.
      oversight: await runOversight(tx, r.tenantId, r.id),
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
    if (query.assigned === "operator") {
      // DECISION: "Assigned to you" also lists every item of the Sandbox, which the operator
      // resolves whoever it is assigned to (docs/plan.md §1.5 "Sandbox inbox").
      const sandboxes = [...(await sandboxIds(tx, ctx.tenantIds))];
      const mine = eq(inboxItem.assigneeRole, "operator");
      where.push(
        sandboxes.length ? (or(mine, inArray(inboxItem.tenantId, sandboxes)) as SQL) : mine,
      );
    }
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(and(...where))
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    const operatorIn = await operatorApprovers(
      tx,
      ctx.session.user.id,
      rows.map((i) => i.tenantId),
    );
    return {
      items: rows.map((i) => opsInboxItem(i, operatorIn(i.tenantId), ctx.services.platform)),
      agents: await agentRefs(
        tx,
        ctx.tenantIds,
        rows.map((i) => i.agentId),
      ),
    };
  });

  mount(app, routes.opsResolveInbox, async (ctx) => {
    const { tx, params, body, session, services } = ctx;
    const [item] = await tx
      .select({ tenantId: inboxItem.tenantId })
      .from(inboxItem)
      .where(and(eq(inboxItem.id, params.id), inArray(inboxItem.tenantId, [...ctx.tenantIds])));
    if (!item) throw notFound("inbox item");
    // Recorded as the operator, as everywhere; in the Sandbox they may resolve any item.
    const by = (await operatorApprovers(tx, session.user.id, [item.tenantId]))(item.tenantId);
    const collect: EventRow[] = [];
    const outcome = await resolveInboxItem(tx, {
      tenantId: item.tenantId,
      itemId: params.id,
      by,
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
    return { item: opsInboxItem(outcome.item, by, services.platform) };
  });
}
