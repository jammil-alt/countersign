// The client portal (ARCHITECTURE §14, §10.6): services, inbox, run timelines and connections.
// Every handler runs inside withTenant(the session's one client). Nothing here returns an agent
// bundle, instructions, prompts, model output outside step summaries, or cost (invariant 11):
// responses are parsed against contract schemas that have no such fields, and free-form payloads
// are scrubbed besides.

import type { Session } from "@countersign/auth";
import {
  applyMatrixChange,
  type Connector,
  describeAccess,
  type MatrixChangeRefusal,
  normalizeMatrix,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  clientLabel,
  connectionAccountName,
  findStep,
  isClientVisible,
  isPlainObject,
  LEAD_ASSIGNEE,
  leadCheckLabel,
  type PermissionEntity,
  portalRunFilter,
  type Role,
  routes,
  type Step,
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
  run,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, desc, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { changeDisplay, itemDisplay, plainTitle } from "../change-display";
import { type AppEnv, HttpError, iso, mount, notFound } from "../http";
import { type InboxRow, resolveInboxItem, scrubForPortal } from "../inbox";
// v0.13 W2-I
import { timelineOversight } from "../oversight/views";
import type { Platform } from "../platform";
import {
  clientRunsPerDay,
  clientStatusWhere,
  clientWaits,
  OPEN_RUN,
  openRunsByAgent,
} from "../runs/client-status";
import { dispatchEvents } from "../runs/dispatch";
import { matrixEdit } from "./mappers";
import { runFilterWhere } from "./run-controls";
import { latestHealthSummary, portalFindings } from "./supervisor";
// v0.12 W1-C
import { leadFirstName } from "./threads";

type ConnectionRow = typeof connection.$inferSelect;

/**
 * What a client user may see of the inbox: never the operator's items (escalations, budget hits,
 * test runs); client users only what is assigned to them (ARCHITECTURE §11).
 */
export function portalInboxFilter(role: Role, userId: string): SQL {
  const notOperator = or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator"));
  if (role === "client_admin") return notOperator as SQL;
  // v0.12 W1-D: items routed to the role skip viewers (`membership.can_sign` false).
  const signs = sql`exists (select 1 from ${membership} where ${membership.tenantId} = ${inboxItem.tenantId} and ${membership.userId} = ${userId} and ${membership.canSign})`;
  return and(
    notOperator,
    or(
      eq(inboxItem.assigneeUserId, userId),
      and(isNull(inboxItem.assigneeUserId), eq(inboxItem.assigneeRole, "client_user"), signs),
    ),
  ) as SQL;
}

/** v0.12 W1-D: open items snoozed until later are out of "waiting" (ARCHITECTURE §11.1). */
export function snoozedNow(snoozed: boolean): SQL {
  return snoozed
    ? sql`${inboxItem.snoozedUntil} > now()`
    : sql`(${inboxItem.snoozedUntil} is null or ${inboxItem.snoozedUntil} <= now())`;
}

async function userNames(tx: Tx, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map<string, string | null>();
  const rows = await tx
    .select({ id: appUser.id, name: appUser.name })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** UI-1b: the client agents items belong to, by id, as the portal names them (its service name). */
async function serviceRefs(tx: Tx, rows: InboxRow[]) {
  const wanted = [...new Set(rows.map((r) => r.agentId).filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map<string, { id: string; name: string }>();
  const agents = await tx
    .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
    .from(agent)
    .where(
      and(
        inArray(agent.id, wanted),
        inArray(agent.tenantId, [...new Set(rows.map((r) => r.tenantId))]),
        eq(agent.kind, "client"),
      ),
    );
  return new Map(agents.map((a) => [a.id, { id: a.id, name: serviceName(a) }]));
}

export async function portalItems(tx: Tx, rows: InboxRow[], platform: Platform) {
  const names = await userNames(
    tx,
    rows.map((r) => r.resolvedBy),
  );
  const services = await serviceRefs(tx, rows);
  return rows.map((i) => ({
    id: i.id,
    kind: i.kind,
    title: plainTitle(i),
    payload: scrubForPortal(i.payload) as Record<string, unknown>,
    display: itemDisplay(platform, i),
    status: i.status,
    runId: i.runId,
    dueAt: iso(i.dueAt),
    createdAt: i.createdAt.toISOString(),
    resolvedAt: iso(i.resolvedAt),
    resolvedBy: i.resolvedBy ? { id: i.resolvedBy, name: names.get(i.resolvedBy) ?? null } : null,
    // v0.12 W1-D: the Desk's undo window, snooze and batch.
    deliverAfter: iso(i.deliverAfter),
    snoozedUntil: iso(i.snoozedUntil),
    batchKey: i.batchKey,
    // UI-1b: which of the client's agents asks, for the Desk's list (null for platform items).
    service: (i.agentId ? services.get(i.agentId) : undefined) ?? null,
  }));
}

const serviceName = (a: Pick<typeof agent.$inferSelect, "serviceName" | "name">) =>
  a.serviceName ?? a.name;

/** Live runs of the client's services, newest first (test runs never reach the portal). */
export async function runSummaries(tx: Tx, tenantId: string, where: SQL[], limit: number) {
  const rows = await tx
    .select({ r: run, a: agent })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
    .where(and(eq(run.tenantId, tenantId), eq(run.mode, "live"), ...where))
    .orderBy(desc(run.createdAt))
    .limit(limit);
  // QA round 1: whether each run waits on the client now, and how long it waited on the client.
  const waits = await clientWaits(
    tx,
    tenantId,
    rows.map(({ r }) => r.id),
  );
  return rows.map(({ r, a }) => {
    const w = waits.get(r.id);
    const going = (OPEN_RUN as readonly string[]).includes(r.status);
    return {
      id: r.id,
      service: { id: a.id, name: serviceName(a) },
      status: r.status,
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      waitingOnYou: going && (r.status === "waiting" || (w?.waitingOnYou ?? false)),
      waitedMs: Math.round(w?.waitedMs ?? 0),
    };
  });
}

/** A step_run's node id names its step: the id, or `${loop}:${index}:${childId}` in a loop. */
function stepOfNode(steps: (id: string) => Step | undefined, nodeId: string): Step | undefined {
  return steps(nodeId) ?? steps(nodeId.split(":").at(-1) ?? nodeId);
}

/** Record ids a step's output cites (`output.sources`, invariant 10), for the client timeline. */
// DECISION: the timeline's sources are only the string ids in `output.sources`; nothing else of a
// step's output reaches the portal (model text stays out, ARCHITECTURE §10.6).
export function sourcesOf(output: unknown): string[] {
  const s = isPlainObject(output) ? output.sources : undefined;
  return Array.isArray(s) ? s.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Whether the client can sign in to a connector from the portal now.
 */
// DECISION: connectors that need no provider sign-in (`auth: 'none'`: the testkit, webhooks)
// connect at once; OAuth connectors (Zoho CRM) sign in through the provider once the deployment
// has their client and the state secret (`isConfigured`); others show "not available yet".
export function canSignIn(
  connector: Pick<Connector, "manifest" | "isConfigured" | "authorize" | "beginLink"> | undefined,
): boolean {
  if (!connector) return false;
  // v0.14 W4-E: a connector without sign-in may still need the deployment's keys (Google Chat).
  if (connector.manifest.auth === "none") return connector.isConfigured?.() !== false;
  if (connector.manifest.auth === "oauth2") {
    // v0.12 bankfeed: or a hosted link widget (Plaid Link) in place of a redirect.
    return (
      Boolean(connector.authorize || connector.beginLink) && connector.isConfigured?.() !== false
    );
  }
  // API-key connectors with a credential form: the client admin enters the key (Access page).
  return hasCredentialForm(connector);
}

/** An API-key connector whose credentials the client admin enters (docs/plan.md §1.26). */
export function hasCredentialForm(connector: Pick<Connector, "manifest"> | undefined): boolean {
  return connector?.manifest.auth === "api_key" && Boolean(connector.manifest.credentialFields);
}

/**
 * Connectors for a person's own account: a client user may sign in to theirs (and disconnect what
 * they connected), not only the client admin (ARCHITECTURE §6.4, plan M10).
 */
// DECISION: named here, where apps/api names connectors, rather than in the manifest: Gmail is the
// only one, and the rule is the portal's, not the connector's.
export const PERSONAL_CONNECTORS: ReadonlySet<string> = new Set(["gmail"]);

export async function portalConnections(
  tx: Tx,
  tenantId: string,
  platform: Platform,
  only?: string,
  /** The signed-in person, for `connectedByYou`. */
  viewerId?: string,
): Promise<
  {
    connector: string;
    name: string;
    description: string;
    icon: string | null;
    available: boolean;
    credentialForm: boolean;
    personal: boolean;
    permissionEntities: PermissionEntity[];
    connection: {
      id: string;
      status: string;
      externalAccountId: string | null;
      accountName: string | null;
      lastSyncAt: string | null;
      permissions: ReturnType<typeof normalizeMatrix>;
      access: ReturnType<typeof describeAccess>;
      usedBy: { id: string; name: string }[];
      connectedByYou: boolean;
    } | null;
  }[]
> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const rows = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), ...(only ? [eq(connection.id, only)] : [])))
    .orderBy(connection.createdAt);
  const offered = Array.isArray(t.settings.connectors_offered)
    ? (t.settings.connectors_offered as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const agents = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.tenantId, tenantId), eq(agent.kind, "client"), eq(agent.status, "active")));
  const usedBy = (c: ConnectionRow) =>
    agents
      .filter((a) => a.runStatus !== "retired" && Object.values(a.bindings).includes(c.id))
      .map((a) => ({ id: a.id, name: serviceName(a) }));
  // Upload (with forwarding) is built in: every client has it, offered or not.
  const builtIn = platform.connectors.has(UPLOAD_CONNECTOR_ID) ? [UPLOAD_CONNECTOR_ID] : [];
  const ids = only
    ? rows.map((r) => r.connector)
    : [...new Set([...builtIn, ...offered, ...rows.map((r) => r.connector)])];
  return ids.map((id) => {
    const manifest = platform.connectors.get(id)?.manifest;
    const c = rows.find((r) => r.connector === id) ?? null;
    return {
      connector: id,
      name: manifest?.name ?? id,
      description: manifest?.description ?? "",
      icon: manifest?.icon ?? null,
      available: canSignIn(platform.connectors.get(id)),
      credentialForm: hasCredentialForm(platform.connectors.get(id)),
      personal: PERSONAL_CONNECTORS.has(id),
      // v0.12 W2-A: the record types the matrix sets levels for.
      permissionEntities: manifest?.permissionEntities ?? [],
      connection: c && {
        id: c.id,
        status: c.status,
        externalAccountId: c.externalAccountId,
        accountName: connectionAccountName(c.config),
        lastSyncAt: iso(c.lastSyncAt),
        permissions: normalizeMatrix(c.permissions),
        access: manifest ? describeAccess(manifest, c.permissions) : [],
        usedBy: usedBy(c),
        connectedByYou: viewerId !== undefined && c.connectedBy === viewerId,
      },
    };
  });
}

/**
 * A run's client timeline, as `GET /api/runs/:id` returns it: visible steps, approvals and
 * changes. v0.12 W2-D: a function, so Sloan's `account.run` reads exactly what the portal shows.
 */
export async function portalRunView(tx: Tx, tenantId: string, runId: string, platform: Platform) {
  // Test runs are hidden from the portal (ARCHITECTURE §10.4).
  const [summary] = await runSummaries(tx, tenantId, [eq(run.id, runId)], 1);
  if (!summary) throw notFound("run");
  const [r] = await tx
    .select({ versionId: run.agentVersionId, slug: run.workflowSlug })
    .from(run)
    .where(and(eq(run.id, runId), eq(run.tenantId, tenantId)));
  const [v] = r
    ? await tx
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(and(eq(agentVersion.id, r.versionId), eq(agentVersion.tenantId, tenantId)))
    : [];
  const workflow = v?.bundle.workflows.find((w) => w.slug === r?.slug)?.workflow;
  const lookup = (id: string) => (workflow ? findStep(workflow, id)?.step : undefined);

  const steps = await tx
    .select()
    .from(stepRun)
    .where(and(eq(stepRun.runId, runId), eq(stepRun.tenantId, tenantId)))
    .orderBy(stepRun.startedAt, stepRun.id);
  // v0.12 W1-C: a lead check's label carries the lead's first name ("Ana: Check new matches").
  const isLeadCheck = (step: Step) => step.kind === "person" && step.assignee === LEAD_ASSIGNEE;
  const leadName = steps.some((s) => {
    const step = stepOfNode(lookup, s.nodeId);
    return !!step && isLeadCheck(step);
  })
    ? await leadFirstName(tx, tenantId)
    : null;
  // v0.13 W2-I: run oversight in the platform's words only, never the agent's note (§10.11).
  const oversight = await timelineOversight(tx, tenantId, runId, platform, workflow);
  const timeline = steps.flatMap((s) => {
    const step = stepOfNode(lookup, s.nodeId);
    // Unknown nodes (agent tasks, internal bookkeeping) are internal steps: not shown.
    if (!step || !isClientVisible(step)) return [];
    return [
      {
        id: s.id,
        label: isLeadCheck(step) ? leadCheckLabel(clientLabel(step), leadName) : clientLabel(step),
        status: s.status,
        summary: s.summary,
        sources: sourcesOf(s.output),
        startedAt: iso(s.startedAt),
        finishedAt: iso(s.finishedAt),
        // v0.13 W2-I
        ...(oversight.has(s.id) ? { oversight: oversight.get(s.id) } : {}),
      },
    ];
  });

  const items = await tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.runId, runId),
        eq(inboxItem.tenantId, tenantId),
        inArray(inboxItem.kind, ["approval", "external_action"]),
        or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
      ),
    )
    .orderBy(inboxItem.createdAt);
  const names = await userNames(
    tx,
    items.map((i) => i.resolvedBy),
  );
  const approvals = items.map((i) => {
    const res = (i.resolution ?? {}) as { approved?: unknown; decision?: unknown };
    const approved =
      typeof res.approved === "boolean"
        ? res.approved
        : res.decision === undefined
          ? null
          : res.decision === "approve";
    return {
      id: i.id,
      title: plainTitle(i),
      status: i.status,
      approved: i.status === "resolved" ? approved : null,
      by: i.resolvedBy ? { id: i.resolvedBy, name: names.get(i.resolvedBy) ?? null } : null,
      resolvedAt: iso(i.resolvedAt),
    };
  });

  const actions = await tx
    .select()
    .from(externalAction)
    .where(and(eq(externalAction.runId, runId), eq(externalAction.tenantId, tenantId)))
    .orderBy(externalAction.createdAt);
  return {
    run: summary,
    steps: timeline,
    approvals,
    actions: actions.map((a) => ({
      id: a.id,
      tool: a.tool,
      description: platform.tools.get(a.tool)?.spec.description ?? a.tool,
      display: changeDisplay(platform, a.tool),
      status: a.status,
      executedAt: iso(a.executedAt),
    })),
  };
}

function by(session: Session, role: Role) {
  return { userId: session.user.id, role };
}

export function portalRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalOverview, async ({ tx, tenantIds, role, session }) => {
    const tenantId = tenantIds[0] as string;
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
    if (!t) throw notFound("client");
    const services = await tx
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          inArray(agent.runStatus, ["active", "paused"]),
        ),
      )
      .orderBy(agent.slug);
    const going = await openRunsByAgent(tx, tenantId);
    const open = await tx
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.status, "open"),
          portalInboxFilter(role, session.user.id),
          snoozedNow(false),
        ),
      );
    return {
      client: { id: t.id, name: t.name },
      services: services.map((a) => ({
        id: a.id,
        name: serviceName(a),
        description: a.serviceDescription,
        status: a.runStatus ?? "draft",
        // QA round 1: for its state in the sidebar (Working, Waiting on you, Ready, …).
        stage: a.stage,
        runsNow: going.get(a.id) ?? { running: 0, waitingOnYou: 0 },
      })),
      needsYou: { inbox: open.length },
      recentRuns: await runSummaries(tx, tenantId, [], 5),
      health: {
        summary: await latestHealthSummary(tx, tenantId),
        findings: await portalFindings(tx, tenantId, role, session.user.id),
      },
    };
  });

  mount(app, routes.portalInbox, async ({ tx, tenantIds, role, session, query, services }) => {
    const tenantId = tenantIds[0] as string;
    const rows = await tx
      .select()
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.status, query.status),
          ...(query.kind ? [eq(inboxItem.kind, query.kind)] : []),
          portalInboxFilter(role, session.user.id),
          // v0.12 W1-D: snoozed open items show only in `view=snoozed`.
          ...(query.status === "open" ? [snoozedNow(query.view === "snoozed")] : []),
        ),
      )
      .orderBy(desc(inboxItem.createdAt))
      .limit(200);
    return { items: await portalItems(tx, rows, services.platform) };
  });

  mount(app, routes.portalResolveInbox, async (ctx) => {
    const { tx, tenantIds, role, session, params, body, services } = ctx;
    const tenantId = tenantIds[0] as string;
    const [visible] = await tx
      .select({ id: inboxItem.id })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.id, params.id),
          eq(inboxItem.tenantId, tenantId),
          portalInboxFilter(role, session.user.id),
        ),
      );
    if (!visible) throw notFound("inbox item");
    const collect: EventRow[] = [];
    const outcome = await resolveInboxItem(tx, {
      tenantId,
      itemId: params.id,
      by: by(session, role),
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
    const [item] = await portalItems(tx, [outcome.item], services.platform);
    return { item: item as NonNullable<typeof item> };
  });

  mount(app, routes.portalRuns, async ({ tx, tenantIds, query, services }) => {
    // v0.12 W1-E: RunFilter without the back office's keys (refused by the query schema), the
    // client's own live runs only.
    const tenantId = tenantIds[0] as string;
    // QA round 1: statuses are the client's (a run waiting on the client is "waiting" whatever
    // its stored status), so the filter, the list and the chart agree.
    const { statuses, ...filter } = portalRunFilter(query.filter);
    const where = [
      ...runFilterWhere(filter, services.platform.ctx.tools.specs()),
      ...clientStatusWhere(statuses),
    ];
    const runs = await runSummaries(tx, tenantId, where, query.limit);
    if (!query.perDay) return { runs };
    const scope = [eq(run.tenantId, tenantId), eq(run.mode, "live"), ...where];
    const [t] = await tx
      .select({ timezone: tenant.timezone })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    return { runs, perDay: await clientRunsPerDay(tx, scope, t?.timezone ?? "UTC") };
  });

  mount(app, routes.portalRun, async ({ tx, tenantIds, params, services }) =>
    portalRunView(tx, tenantIds[0] as string, params.id, services.platform),
  );

  mount(app, routes.portalConnections, async ({ tx, tenantIds, services, session }) => ({
    connections: await portalConnections(
      tx,
      tenantIds[0] as string,
      services.platform,
      undefined,
      session.user.id,
    ),
  }));

  mount(app, routes.portalTightenPermissions, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const tenantId = tenantIds[0] as string;
    const [row] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.id), eq(connection.tenantId, tenantId)));
    if (!row) throw notFound("connection");
    const r = applyMatrixChange({
      current: row.permissions,
      proposed: matrixEdit(body),
      by: "client",
      // v0.12 W2-A: tighten-only per entity too (403 `loosening`).
      declared: services.platform.connectors.get(row.connector)?.manifest.permissionEntities,
    });
    if (!r.ok) {
      const refusal: MatrixChangeRefusal = r;
      // v0.12 W2-A: entities the connector doesn't have are a bad request, not a refusal.
      const status = refusal.reason === "invalid_entities" ? 422 : 403;
      throw new HttpError(status, refusal.reason, refusal.message);
    }
    if (r.changed) {
      await tx
        .update(connection)
        .set({ permissions: r.matrix })
        .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change: { ...r.change },
      });
    }
    const [out] = await portalConnections(tx, tenantId, services.platform, row.id);
    if (!out) throw notFound("connection");
    return { connection: out };
  });
}
