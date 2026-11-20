// Connectors C4 (docs/connectors-plan.md §3, §5, §7; docs/plan.md §1.161): the routes behind the
// client's one Connectors place and the back office's Connectors tab, Needs and Readiness panels
// (core's `connectorAccessRoutes`). Every route is mounted (audited, in the request's scope:
// withTenant for the portal, the clients served for the back office) and filters by `tenant_id`.
//
// A client admin sets what agents may read and change (`clientMayAllow`: any read, any write
// between Off and Ask me first, never On its own by themselves), allows what an agent needs, and
// says how much we may change without asking. Our changes apply at once only when tighter or
// covered by that go-ahead (`withinAuthorization`); anything else is a change request a client
// admin approves or declines. The Sandbox is ours: our edits there apply directly.

import { grantsOfClient } from "@countersign/agents";
import { BROWSER_CONNECTOR_ID } from "@countersign/connectors";
import {
  type AccessGap,
  type AgentReadinessPanel,
  allowNeeds,
  type ChangeRequestView,
  CONNECTION_REQUEST_SUBJECT,
  type ConnectionSettings,
  type ConnectorNeed,
  clientMayAllow,
  type MezonasMay,
  mezonasMayUntil,
  type NeedsBannerItem,
  type OpsConnectionChangeResult,
  type RouteSpec,
  connectorAccessRoutes as r,
  requestStale,
  rowChangeView,
  withinAuthorization,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  connectionChange,
  connectionChangeRequest,
  type Tx,
} from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AgentInfo,
  accessRows,
  addNotice,
  applySettings,
  bundleNeeds,
  type ClientAccess,
  type ConnectionRow,
  closeRequestItems,
  connectorName,
  createRequest,
  declaredOf,
  editedSettings,
  expireRequests,
  gapsOf,
  gapView,
  loadClientAccess,
  lockConnection,
  mezonasMayView,
  needView,
  opsGapView,
  opsNeedView,
  personNames,
  type RequestRow,
  rowsOf,
  rowViews,
  settingsOf,
  shownFor,
} from "../connector-access/service";
import {
  boundAgents,
  connectionPage,
  connectorCard,
  namesFor,
  opsConnectionPage,
  requestView,
  sortCards,
} from "../connector-access/views";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { newConnectionMatrix } from "./ops-connectors";

type Ctx = Pick<HandlerCtx<RouteSpec>, "tx" | "services" | "session">;

/**
 * Built for you (docs/connectors-plan.md §3.1, §6): connectors made for this client alone, and
 * the websites an agent signs in to for them (their browser logins).
 */
function forYou(c: { custom: boolean; connector: string; connections: unknown[] }): boolean {
  return c.custom || (c.connector === BROWSER_CONNECTOR_ID && c.connections.length > 0);
}

function lowerFirst(s: string): string {
  return s.length > 0 ? `${s[0]?.toLowerCase()}${s.slice(1)}` : s;
}

/** A client agent of this client by id, from what was read (404 for anything else). */
function agentIn(access: ClientAccess, id: string, agentIds?: readonly string[] | null): AgentInfo {
  const a = access.agents.find((x) => x.id === id);
  if (!a || (agentIds && !agentIds.includes(a.id))) throw notFound("agent");
  return a;
}

/** A connection of this client, from what was read. */
function connectionIn(access: ClientAccess, id: string): ConnectionRow {
  const row = access.connections.find((c) => c.id === id);
  if (!row) throw notFound("connection");
  return row;
}

/** One connector's needs of an agent. */
function needsOn(a: Pick<AgentInfo, "needs">, connector: string): ConnectorNeed[] {
  return a.needs.filter((n) => n.connector === connector);
}

async function me(tx: Tx, userId: string) {
  const names = await personNames(tx, [userId]);
  return { id: userId, name: names.get(userId) ?? null };
}

/** A request of this client, locked; open ones past their end are expired first. */
async function lockRequest(tx: Tx, tenantId: string, id: string, now: Date): Promise<RequestRow> {
  await expireRequests(tx, tenantId, now);
  const [row] = await tx
    .select()
    .from(connectionChangeRequest)
    .where(and(eq(connectionChangeRequest.id, id), eq(connectionChangeRequest.tenantId, tenantId)))
    .for("update");
  if (!row) throw notFound("request");
  return row;
}

function refuseClosed(req: RequestRow): void {
  if (req.status === "open") return;
  const words =
    req.status === "expired"
      ? "This request ended unanswered; we'll send a new one if it's still needed."
      : `This request is no longer open (${req.status}).`;
  throw new HttpError(409, "closed", words);
}

// ── Our changes: decide, then apply or send ───────────────────────────────────────────────────

type Outcome = "none" | "apply" | "apply_under_authorization" | "request";

interface Decision {
  direction: ReturnType<typeof rowsOf>["direction"];
  rows: ReturnType<typeof rowsOf>["rows"];
  outcome: Outcome;
  whyNot: string | null;
}

/**
 * What our edit does (docs/connectors-plan.md §7.1, §7.2): nothing; tighter (or in the Sandbox)
 * applies at once; looser applies only where the client's go-ahead covers it, never On its own;
 * anything else goes to the client admin as a request.
 */
// DECISION (docs/plan.md §1.161, C4): under "Allow what agents need", the needs that count are
// those of the agents bound to the connection and of the agent the change is for (a Readiness
// send for an agent not bound yet).
function decide(
  access: ClientAccess,
  row: ConnectionRow,
  after: ConnectionSettings,
  forAgent: AgentInfo | null,
): Decision {
  const before = settingsOf(row);
  const { direction, rows } = rowsOf(access.platform, row.connector, before, after);
  if (direction === "none") return { direction, rows, outcome: "none", whyNot: null };
  if (access.sandbox || direction === "tighter") {
    return { direction, rows, outcome: "apply", whyNot: null };
  }
  const agents = [...boundAgents(access, row.id), ...(forAgent ? [forAgent] : [])];
  const needs = agents.flatMap((a) => needsOn(a, row.connector));
  const w = withinAuthorization(
    { before, after, declared: declaredOf(access.platform)[row.connector] },
    row.mezonasMay,
    needs,
    access.now,
  );
  if (w.fits) return { direction, rows, outcome: "apply_under_authorization", whyNot: null };
  return { direction, rows, outcome: "request", whyNot: w.reason };
}

async function carryOut(
  ctx: Ctx,
  access: ClientAccess,
  row: ConnectionRow,
  input: { after: ConnectionSettings; reason: string; forAgent: AgentInfo | null },
): Promise<OpsConnectionChangeResult> {
  const { tx, services, session } = ctx;
  const { platform } = access;
  const d = decide(access, row, input.after, input.forAgent);
  const rows = rowViews(platform, row.connector, d.rows);
  const asker = await me(tx, session.user.id);
  const page = async () => {
    const fresh = await loadClientAccess(tx, access.tenantId, services, access.now);
    const names = await namesFor(tx, fresh, fresh.openRequests);
    return opsConnectionPage(tx, fresh, connectionIn(fresh, row.id), {
      viewerId: session.user.id,
      names,
    });
  };
  const forAgentId = input.forAgent ? { forAgentId: input.forAgent.id } : {};
  if (d.outcome === "none") return { outcome: "applied", rows, connection: await page() };
  if (d.outcome === "apply") {
    await applySettings(tx, row, {
      after: input.after,
      actorId: session.user.id,
      change: { by: "operator", reason: input.reason, ...forAgentId },
    });
    if (!access.sandbox) {
      await addNotice(tx, {
        row,
        platform,
        because: "tightened",
        rows,
        reason: input.reason,
        changedBy: asker,
        authorization: null,
      });
    }
    return { outcome: "applied", rows, connection: await page() };
  }
  if (d.outcome === "apply_under_authorization") {
    const authorization = row.mezonasMay as MezonasMay;
    await applySettings(tx, row, {
      after: input.after,
      actorId: session.user.id,
      change: { by: "operator", reason: input.reason, authorization, ...forAgentId },
    });
    await addNotice(tx, {
      row,
      platform,
      because: "authorized",
      rows,
      reason: input.reason,
      changedBy: asker,
      authorization,
    });
    const names = await personNames(tx, [authorization.setBy]);
    return {
      outcome: "applied_under_authorization",
      rows,
      authorization: mezonasMayView(authorization, names, access.now) as NonNullable<
        ReturnType<typeof mezonasMayView>
      >,
      connection: await page(),
    };
  }
  const { request, replaced } = await createRequest(tx, {
    row,
    platform,
    after: input.after,
    reason: input.reason,
    requestedBy: asker,
    forAgent: input.forAgent ? { id: input.forAgent.id, name: input.forAgent.name } : null,
    now: access.now,
  });
  const fresh = await loadClientAccess(tx, access.tenantId, services, access.now);
  const names = await namesFor(tx, fresh, [request]);
  return {
    outcome: "request_sent",
    request: requestView(fresh, request, names),
    whyNot: d.whyNot ?? "",
    replaced,
  };
}

// ── The back office's agent panels ───────────────────────────────────────────────────────────

/** An agent the operator may see (a template, or a client agent of a client they serve). */
async function opsAgent(ctx: Pick<HandlerCtx<RouteSpec>, "tx" | "tenantIds">, id: string) {
  const [row] = await ctx.tx.select().from(agent).where(eq(agent.id, id));
  if (!row) throw notFound("agent");
  if (row.tenantId) ensureClient(ctx, row.tenantId);
  return row;
}

async function shownBundle(tx: Tx, row: typeof agent.$inferSelect): Promise<unknown> {
  if (row.liveVersionId) {
    const [live] = await tx
      .select({ bundle: agentVersion.bundle })
      .from(agentVersion)
      .where(eq(agentVersion.id, row.liveVersionId));
    if (live) return live.bundle;
  }
  const [latest] = await tx
    .select({ bundle: agentVersion.bundle })
    .from(agentVersion)
    .where(eq(agentVersion.agentId, row.id))
    .orderBy(desc(agentVersion.version))
    .limit(1);
  return latest?.bundle ?? null;
}

const READINESS: Record<AccessGap["kind"], AgentReadinessPanel["connectors"][number]["state"]> = {
  not_connected: "not_connected",
  broken: "broken",
  not_bound: "not_bound",
  off_on_connection: "needs_access",
  scope_excludes: "needs_access",
  off_in_grant: "grant_too_narrow",
  could_run_alone: "could_run_alone",
};

export function connectorAccessRouteHandlers(app: Hono<AppEnv>): void {
  // ── The portal ─────────────────────────────────────────────────────────────────────────────

  mount(app, r.portalConnectors, async ({ tx, tenantIds, services, agents }) => {
    const access = await loadClientAccess(tx, tenantIds[0] as string, services);
    const names = await namesFor(tx, access, []);
    const cards = shownFor(access, services).map((s) => connectorCard(access, s, names, agents));
    const theirs = access.agents.filter((a) => agents === null || agents.includes(a.id));
    const waiting: NeedsBannerItem[] = theirs.flatMap((a) =>
      a.gaps
        .filter((g) => g.blocking && g.fixBy === "client")
        .map((g) => ({
          agent: { id: a.id, name: a.name },
          connector: g.connector,
          connectorName: connectorName(access.platform, g.connector),
          kind: g.kind,
          words: `${a.name}: ${lowerFirst(gapView(access.platform, g, a.name).words)}`,
        })),
    );
    return {
      connected: sortCards(cards.filter((c) => !forYou(c) && c.connections.length > 0)),
      builtForYou: sortCards(cards.filter(forYou)),
      browse: sortCards(cards.filter((c) => !c.custom)),
      waiting,
      openRequests: access.openRequests.length,
    };
  });

  mount(
    app,
    r.portalConnector,
    async ({ tx, tenantIds, services, params, query, role, session, agents }) => {
      const access = await loadClientAccess(tx, tenantIds[0] as string, services);
      const shown = shownFor(access, services).find(
        (s) => s.connector.manifest.id === params.connector,
      );
      if (!shown) throw notFound("connector");
      const m = shown.connector.manifest;
      const forAgent = query.for ? agentIn(access, query.for, agents) : null;
      const names = await namesFor(tx, access, access.openRequests);
      const editor = role === "client_admin" ? "client_admin" : "none";
      // §5.2: what a new connection starts with, plus the picked agent's needs at their least level.
      const low = await newConnectionMatrix(tx, m);
      const startMatrix = forAgent
        ? allowNeeds(low, needsOn(forAgent, m.id), m.permissionEntities).matrix
        : low;
      const start = accessRows({
        connector: shown.connector,
        matrix: startMatrix,
        editor,
        agents: [],
        connectionId: null,
      });
      if (forAgent) {
        const mark = (row: (typeof start.read)[number]) => ({
          ...row,
          neededBy: needsOn(forAgent, m.id).some(
            (n) =>
              n.verb === row.verb && (row.entity === null ? !n.entity : n.entity === row.entity),
          )
            ? [{ id: forAgent.id, name: forAgent.name }]
            : [],
        });
        start.read = start.read.map(mark);
        start.change = start.change.map(mark);
      }
      const rows = access.connections.filter((c) => c.connector === m.id);
      const connections = [];
      for (const row of rows) {
        connections.push(
          await connectionPage(tx, access, row, {
            editor,
            viewerId: session.user.id,
            names,
            agentIds: agents,
          }),
        );
      }
      const forGaps = forAgent ? forAgent.gaps.filter((g) => g.connector === m.id) : [];
      return {
        connector: connectorCard(access, shown, names, agents),
        permissionEntities: m.permissionEntities ?? [],
        start: { read: start.read, change: start.change },
        connections,
        forAgent: forAgent
          ? {
              agent: { id: forAgent.id, name: forAgent.name },
              ready: forGaps.every((g) => !g.blocking),
              gaps: forGaps.map((g) => gapView(access.platform, g, forAgent.name)),
            }
          : null,
        mayEdit: role === "client_admin",
      };
    },
  );

  mount(app, r.portalAllowForAgent, async ({ tx, tenantIds, services, params, session }) => {
    const tenantId = tenantIds[0] as string;
    const access = await loadClientAccess(tx, tenantId, services);
    const a = agentIn(access, params.agentId);
    const row = await lockConnection(tx, tenantId, params.connectionId);
    const declared = declaredOf(access.platform)[row.connector];
    const needs = needsOn(a, row.connector);
    const allowed = allowNeeds(row.permissions, needs, declared);
    const before = settingsOf(row);
    const after: ConnectionSettings = { permissions: allowed.matrix, config: before.config };
    // allowNeeds never sets On its own or delete: this always fits the client admin's rule.
    const ok = clientMayAllow(before, after, declared);
    if (!ok.ok) throw new HttpError(422, "not_allowed", "this needs Mezonas to propose it");
    const { rows } = rowsOf(access.platform, row.connector, before, after);
    if (rows.length > 0) {
      await applySettings(tx, row, {
        after,
        actorId: session.user.id,
        change: { by: "client", forAgentId: a.id },
      });
    }
    const fresh = await loadClientAccess(tx, tenantId, services, access.now);
    const names = await namesFor(tx, fresh, fresh.openRequests);
    return {
      connection: await connectionPage(tx, fresh, connectionIn(fresh, row.id), {
        editor: "client_admin",
        viewerId: session.user.id,
        names,
        agentIds: null,
      }),
      rows: rowViews(access.platform, row.connector, rows),
      unresolved: allowed.unresolved.map((n) => needView(access.platform, n)),
    };
  });

  mount(app, r.portalSetAccess, async ({ tx, tenantIds, services, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await lockConnection(tx, tenantId, params.connectionId);
    const { platform } = services;
    const declared = declaredOf(platform)[row.connector];
    const before = settingsOf(row);
    const after = editedSettings(row, { permissions: body.permissions }, platform);
    const ok = clientMayAllow(before, after, declared);
    if (!ok.ok) {
      throw new HttpError(
        422,
        "not_allowed",
        ok.refused[0]?.reason ?? "That change isn't yours to make.",
        {
          refused: ok.refused.map((x) => ({
            row: rowChangeView(x.row, declared),
            reason: x.reason,
          })),
        },
      );
    }
    const { rows } = rowsOf(platform, row.connector, before, after);
    if (rows.length > 0) {
      await applySettings(tx, row, { after, actorId: session.user.id, change: { by: "client" } });
    }
    const access = await loadClientAccess(tx, tenantId, services);
    const names = await namesFor(tx, access, access.openRequests);
    return {
      connection: await connectionPage(tx, access, connectionIn(access, row.id), {
        editor: "client_admin",
        viewerId: session.user.id,
        names,
        agentIds: null,
      }),
      rows: rowViews(platform, row.connector, rows),
    };
  });

  mount(app, r.portalSetMezonasMay, async ({ tx, tenantIds, params, body, session }) => {
    const tenantId = tenantIds[0] as string;
    const row = await lockConnection(tx, tenantId, params.connectionId);
    const now = new Date();
    const after: MezonasMay | null =
      body.choice === "ask"
        ? null
        : {
            choice: body.choice,
            until: mezonasMayUntil(body.duration, now),
            setBy: session.user.id,
            setAt: now.toISOString(),
          };
    if (row.mezonasMay !== null || after !== null) {
      await tx
        .update(connection)
        .set({ mezonasMay: after })
        .where(and(eq(connection.id, row.id), eq(connection.tenantId, tenantId)));
      const choice =
        after === null
          ? "Ask me each time"
          : after.choice === "needs"
            ? "Allow what agents need"
            : "Allow any change";
      const until = after?.until ? `, until ${after.until.slice(0, 10)}` : "";
      await tx.insert(connectionChange).values({
        tenantId,
        connectionId: row.id,
        actorId: session.user.id,
        change: {
          kind: "mezonas_may",
          by: "client",
          before: row.mezonasMay,
          after,
          words: `Changes by Mezonas: ${choice}${until}`,
        },
      });
    }
    const names = await personNames(tx, [session.user.id]);
    return { mezonasMay: mezonasMayView(after, names, now) };
  });

  mount(app, r.portalConnectionRequests, async ({ tx, tenantIds, services }) => {
    const access = await loadClientAccess(tx, tenantIds[0] as string, services);
    const names = await namesFor(tx, access, access.openRequests);
    return { requests: access.openRequests.map((q) => requestView(access, q, names)) };
  });

  mount(app, r.portalApproveConnectionRequest, async (ctx) => {
    const { tx, tenantIds, services, params, body, session } = ctx;
    const tenantId = tenantIds[0] as string;
    const now = new Date();
    const req = await lockRequest(tx, tenantId, params.id, now);
    refuseClosed(req);
    const row = await lockConnection(tx, tenantId, req.connectionId);
    // A request never overwrites a change the client made since we asked (§7.1): refused, and
    // nothing is marked applied; we send a new one.
    if (requestStale(req, settingsOf(row))) {
      throw new HttpError(
        409,
        "out_of_date",
        "This connection changed since we asked, so this request is out of date. We'll send a new one.",
      );
    }
    await applySettings(tx, row, {
      after: req.proposed,
      actorId: session.user.id,
      change: {
        by: "client",
        reason: req.reason,
        requestedBy: req.requestedBy,
        ...(req.forAgentId ? { forAgentId: req.forAgentId } : {}),
      },
      requestId: req.id,
    });
    const [closed] = await tx
      .update(connectionChangeRequest)
      .set({
        status: "approved",
        closedAt: now,
        closedBy: session.user.id,
        answerNote: body.note ?? null,
      })
      .where(
        and(eq(connectionChangeRequest.id, req.id), eq(connectionChangeRequest.tenantId, tenantId)),
      )
      .returning();
    await closeRequestItems(tx, tenantId, [req.id], "resolved", session.user.id, now, {
      decision: "approve",
      approved: true,
      by: session.user.id,
      ...(body.note ? { note: body.note } : {}),
    });
    const access = await loadClientAccess(tx, tenantId, services, now);
    const names = await namesFor(tx, access, [closed as RequestRow]);
    return {
      request: requestView(access, closed as RequestRow, names),
      connection: await connectionPage(tx, access, connectionIn(access, row.id), {
        editor: "client_admin",
        viewerId: session.user.id,
        names,
        agentIds: null,
      }),
    };
  });

  mount(app, r.portalDeclineConnectionRequest, async (ctx) => {
    const { tx, tenantIds, services, params, body, session } = ctx;
    const tenantId = tenantIds[0] as string;
    const now = new Date();
    const req = await lockRequest(tx, tenantId, params.id, now);
    refuseClosed(req);
    const [closed] = await tx
      .update(connectionChangeRequest)
      .set({
        status: "declined",
        closedAt: now,
        closedBy: session.user.id,
        answerNote: body.note ?? null,
      })
      .where(
        and(eq(connectionChangeRequest.id, req.id), eq(connectionChangeRequest.tenantId, tenantId)),
      )
      .returning();
    await closeRequestItems(tx, tenantId, [req.id], "resolved", session.user.id, now, {
      decision: "reject",
      approved: false,
      by: session.user.id,
      ...(body.note ? { note: body.note } : {}),
    });
    const access = await loadClientAccess(tx, tenantId, services, now);
    const names = await namesFor(tx, access, [closed as RequestRow]);
    return { request: requestView(access, closed as RequestRow, names) };
  });

  // ── The back office ────────────────────────────────────────────────────────────────────────

  mount(app, r.opsClientConnectors, async (ctx) => {
    const { tx, services, params } = ctx;
    ensureClient(ctx, params.id);
    const access = await loadClientAccess(tx, params.id, services);
    const names = await namesFor(tx, access, access.openRequests);
    const cards = shownFor(access, services).map((s) => connectorCard(access, s, names, null));
    return {
      connected: sortCards(cards.filter((c) => !forYou(c) && c.connections.length > 0)),
      builtForYou: sortCards(cards.filter(forYou)),
      recommended: sortCards(
        cards.filter((c) => !c.custom && c.recommended && c.connections.length === 0),
      ),
      requests: access.openRequests.map((q) => requestView(access, q, names)),
      agents: access.agents
        .filter((a) => a.gaps.length > 0)
        .map((a) => ({
          agent: { id: a.id, name: a.name },
          ready: a.gaps.every((g) => !g.blocking),
          gaps: a.gaps.map((g) => opsGapView(access.platform, g, a.name)),
        })),
      sandbox: access.sandbox,
    };
  });

  mount(app, r.opsClientConnector, async (ctx) => {
    const { tx, services, params, query, session } = ctx;
    ensureClient(ctx, params.id);
    const access = await loadClientAccess(tx, params.id, services);
    const shown = shownFor(access, services).find(
      (s) => s.connector.manifest.id === params.connector,
    );
    if (!shown) throw notFound("connector");
    const m = shown.connector.manifest;
    const forAgent = query.for ? agentIn(access, query.for) : null;
    const names = await namesFor(tx, access, access.openRequests);
    const connections = [];
    for (const row of access.connections.filter((c) => c.connector === m.id)) {
      connections.push(
        await opsConnectionPage(tx, access, row, { viewerId: session.user.id, names }),
      );
    }
    const forGaps = forAgent ? forAgent.gaps.filter((g) => g.connector === m.id) : [];
    return {
      connector: connectorCard(access, shown, names, null),
      permissionEntities: m.permissionEntities ?? [],
      connections,
      forAgent: forAgent
        ? {
            agent: { id: forAgent.id, name: forAgent.name },
            ready: forGaps.every((g) => !g.blocking),
            gaps: forGaps.map((g) => opsGapView(access.platform, g, forAgent.name)),
          }
        : null,
      sandbox: access.sandbox,
    };
  });

  mount(app, r.opsPreviewConnectionChange, async (ctx) => {
    const { tx, services, params, body } = ctx;
    ensureClient(ctx, params.id);
    const access = await loadClientAccess(tx, params.id, services);
    const row = connectionIn(access, params.connectionId);
    const after = editedSettings(row, body, services.platform);
    const d = decide(access, row, after, null);
    const names = await namesFor(tx, access, []);
    return {
      direction: d.direction,
      rows: rowViews(access.platform, row.connector, d.rows),
      outcome: d.outcome,
      whyNot: d.whyNot,
      mezonasMay: mezonasMayView(row.mezonasMay, names, access.now),
    };
  });

  mount(app, r.opsConnectionChange, async (ctx) => {
    const { tx, services, params, body } = ctx;
    ensureClient(ctx, params.id);
    const row = await lockConnection(tx, params.id, params.connectionId);
    const access = await loadClientAccess(tx, params.id, services);
    const forAgent = body.forAgentId ? agentIn(access, body.forAgentId) : null;
    const after = editedSettings(row, body, services.platform);
    return carryOut(ctx, access, row, { after, reason: body.reason, forAgent });
  });

  mount(app, r.opsWithdrawConnectionRequest, async (ctx) => {
    const { tx, services, params, session } = ctx;
    ensureClient(ctx, params.id);
    const now = new Date();
    const req = await lockRequest(tx, params.id, params.requestId, now);
    refuseClosed(req);
    const [closed] = await tx
      .update(connectionChangeRequest)
      .set({ status: "withdrawn", closedAt: now, closedBy: session.user.id })
      .where(
        and(
          eq(connectionChangeRequest.id, req.id),
          eq(connectionChangeRequest.tenantId, params.id),
        ),
      )
      .returning();
    await closeRequestItems(tx, params.id, [req.id], "resolved", null, now, { withdrawn: true });
    const access = await loadClientAccess(tx, params.id, services, now);
    const names = await namesFor(tx, access, [closed as RequestRow]);
    return { request: requestView(access, closed as RequestRow, names) };
  });

  mount(app, r.opsAgentNeeds, async (ctx) => {
    const { tx, services, params } = ctx;
    const row = await opsAgent(ctx, params.id);
    const needs = await bundleNeeds(
      tx,
      row.tenantId,
      await shownBundle(tx, row),
      services.platform,
    );
    const connectors = [...new Set(needs.map((n) => n.connector))];
    return {
      agent: { id: row.id, name: row.serviceName ?? row.name, template: row.kind === "template" },
      connectors: connectors.map((c) => ({
        connector: c,
        name: connectorName(services.platform, c),
        needs: needs.filter((n) => n.connector === c).map((n) => opsNeedView(services.platform, n)),
      })),
    };
  });

  mount(app, r.opsAgentReadiness, async (ctx) => {
    const { tx, services, params, query } = ctx;
    const row = await opsAgent(ctx, params.id);
    const template = row.kind === "template";
    const clientId = template ? query.client : row.tenantId;
    if (!clientId) {
      throw new HttpError(422, "client_required", "say which client to check this template for");
    }
    ensureClient(ctx, clientId);
    if (!template && query.client && query.client !== clientId) throw notFound("agent");
    const access = await loadClientAccess(tx, clientId, services);
    const needs = await bundleNeeds(
      tx,
      row.tenantId,
      await shownBundle(tx, row),
      services.platform,
    );
    const grants: Record<string, NonNullable<AgentInfo["grants"][string]>> = {};
    if (!template) {
      for (const g of await grantsOfClient(tx, clientId)) {
        if (g.agentId === row.id) grants[g.connectionId] = g.limits;
      }
    }
    const gaps = gapsOf(needs, {
      connections: access.connections,
      platform: services.platform,
      ...(template ? {} : { bindings: row.bindings, grants }),
    });
    const names = await namesFor(tx, access, access.openRequests);
    const name = row.serviceName ?? row.name;
    const connectors = [...new Set(needs.map((n) => n.connector))].map((c) => {
      const mine = gaps.filter((g) => g.connector === c);
      const blocking = mine.find((g) => g.blocking);
      const state = blocking
        ? READINESS[blocking.kind]
        : mine.length > 0
          ? "could_run_alone"
          : "ready";
      const connectionId =
        mine.find((g) => g.connectionId)?.connectionId ??
        (template ? undefined : row.bindings[c]) ??
        access.connections.find((x) => x.connector === c)?.id ??
        null;
      const open = connectionId
        ? access.openRequests.find((q) => q.connectionId === connectionId)
        : undefined;
      return {
        connector: c,
        name: connectorName(services.platform, c),
        state,
        connectionId,
        gaps: mine.map((g) => opsGapView(services.platform, g, name)),
        openRequest: open ? (requestView(access, open, names) as ChangeRequestView) : null,
      };
    });
    return {
      agent: { id: row.id, name, template },
      clientId,
      ready: gaps.every((g) => !g.blocking),
      connectors,
    };
  });

  mount(app, r.opsAgentReadinessSend, async (ctx) => {
    const { tx, services, params, body } = ctx;
    const row = await opsAgent(ctx, params.id);
    if (row.kind !== "client" || !row.tenantId) {
      throw new HttpError(422, "not_a_client_agent", "send to a client from its own agent");
    }
    const tenantId = row.tenantId;
    const conn = await lockConnection(tx, tenantId, body.connectionId);
    const access = await loadClientAccess(tx, tenantId, services);
    const needs = await bundleNeeds(tx, tenantId, await shownBundle(tx, row), services.platform);
    const forAgent: AgentInfo = access.agents.find((a) => a.id === row.id) ?? {
      id: row.id,
      name: row.serviceName ?? row.name,
      bindings: row.bindings,
      grants: {},
      needs,
      gaps: [],
    };
    const declared = declaredOf(services.platform)[conn.connector];
    const allowed = allowNeeds(conn.permissions, needsOn({ needs }, conn.connector), declared);
    const after: ConnectionSettings = {
      permissions: allowed.matrix,
      config: settingsOf(conn).config,
    };
    if (rowsOf(services.platform, conn.connector, settingsOf(conn), after).rows.length === 0) {
      throw new HttpError(
        409,
        "nothing_missing",
        `${forAgent.name} already has what it needs on ${connectorName(services.platform, conn.connector)}`,
      );
    }
    return carryOut(ctx, access, conn, { after, reason: body.reason, forAgent });
  });
}

/** Whether an inbox item is a change request (answered only by its own routes). */
export function isConnectionRequest(item: { subjectType: string | null }): boolean {
  return item.subjectType === CONNECTION_REQUEST_SUBJECT;
}
