// Onboarding and settings (docs/plan.md §1.14): the back office's overview of what needs attention
// across clients, inviting a client's people (an `app_user` row with its membership is the
// invitation; the sign-in adapter sends the email), a client's settings with approval delegation,
// and the portal's Settings (users, notification settings) for client admins.

import { clientApproverSetting, updateInfo } from "@countersign/agents";
import type { InviteDelivery } from "@countersign/auth";
import {
  DEFAULT_NOTIFICATIONS,
  type ExternalApprover,
  type InvitableRole,
  type InviteResult,
  type Member,
  type NotificationSettings,
  type OpsClientSettings,
  type OpsOverview,
  type RouteSpec,
  routes,
} from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  inboxItem,
  membership,
  membershipsOfUser,
  run,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import { and, count, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, type HandlerCtx, HttpError, mount, notFound } from "../http";
import { mailerFromEnv } from "../notify/mailer";

type TenantRow = typeof tenant.$inferSelect;

/** Overview lists show this many of each kind; the counts say how many there are. */
const OVERVIEW_LIMIT = 20;
/** Failed runs count as needing attention for this long. */
// DECISION: a failed run has no "seen" state in v1, so the overview shows the last 7 days of them.
const FAILED_RUN_WINDOW_DAYS = 7;
const APPROVALS_SETTING = "approvals.external_actions";

/** Who approves a client's external actions by default: its admin unless delegated. */
export function approvalsOf(settings: Record<string, unknown>): ExternalApprover {
  return clientApproverSetting(settings) === "operator" ? "operator" : "client_admin";
}

/** The stored notification settings over the defaults (only booleans count). */
export function notificationsOf(settings: Record<string, unknown>): NotificationSettings {
  const raw = (settings.notifications ?? {}) as Record<string, unknown>;
  const pick = (k: keyof NotificationSettings) =>
    typeof raw[k] === "boolean" ? (raw[k] as boolean) : DEFAULT_NOTIFICATIONS[k];
  return { itemsWaiting: pick("itemsWaiting"), weeklyDigest: pick("weeklyDigest") };
}

/** Settings with approvals written the one way the runtime reads first (nested). */
export function withApprovals(
  settings: Record<string, unknown>,
  to: ExternalApprover,
): Record<string, unknown> {
  const { [APPROVALS_SETTING]: _dotted, ...rest } = settings;
  const approvals = (rest.approvals ?? {}) as Record<string, unknown>;
  return { ...rest, approvals: { ...approvals, external_actions: to } };
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Whether this deployment's sign-in records a first sign-in (WorkOS does; dev doesn't). */
function knowsSignIns(ctx: Pick<HandlerCtx<RouteSpec>, "services">): boolean {
  const choice = ctx.services.auth();
  return choice.ok && choice.adapter.kind === "workos";
}

async function membersOf(
  tx: Tx,
  tenantId: string,
  options: { clientRolesOnly: boolean; signIns: boolean },
): Promise<Member[]> {
  const rows = await tx
    .select({
      userId: membership.userId,
      email: appUser.email,
      name: appUser.name,
      role: membership.role,
      workosUserId: appUser.workosUserId,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        options.clientRolesOnly ? ne(membership.role, "operator") : undefined,
      ),
    )
    .orderBy(appUser.email);
  return rows.map((r) => ({
    userId: r.userId,
    email: r.email,
    name: r.name,
    role: r.role,
    signedIn: options.signIns ? r.workosUserId !== null : null,
  }));
}

function emailOf(delivery: InviteDelivery): InviteResult["email"] {
  return delivery.status === "sent"
    ? { status: "sent", reason: null }
    : { status: delivery.status, reason: delivery.reason };
}

/**
 * Invites an address into one client with a client role: the `app_user` row (made if new) and the
 * membership, in the request's transaction; the email after the commit. Refuses an address that is
 * an operator or already belongs to a client (client users belong to exactly one).
 */
export async function inviteToClient(
  ctx: Pick<HandlerCtx<RouteSpec>, "tx" | "services" | "afterCommit">,
  tenantId: string,
  input: { email: string; name?: string | undefined; role: InvitableRole },
  options: { surface: "ops" | "portal" },
): Promise<InviteResult> {
  const { tx } = ctx;
  const email = input.email.trim().toLowerCase();
  const name = input.name?.trim() || null;
  const [existing] = await tx.select().from(appUser).where(eq(appUser.email, email));
  if (existing) {
    const theirs = await membershipsOfUser(tx, existing.id);
    const operator = theirs.some((m) => m.role === "operator");
    if (!operator && theirs.some((m) => m.tenantId === tenantId)) {
      throw new HttpError(409, "already_member", "that address is already in this client");
    }
    if (theirs.length > 0) {
      // DECISION: the portal never says why (Mezonas staff, or another client's person): that
      // would tell one client about another. The back office names the reason.
      if (options.surface === "portal") {
        throw new HttpError(409, "unavailable", "that address can't be invited here");
      }
      throw operator
        ? new HttpError(409, "is_operator", "that address is a Mezonas operator")
        : new HttpError(409, "other_client", "that address belongs to another client");
    }
  }
  let userId = existing?.id;
  if (!userId) {
    const [row] = await tx
      .insert(appUser)
      .values({ email, name })
      .onConflictDoNothing()
      .returning({ id: appUser.id });
    userId = row?.id;
    if (!userId) throw new HttpError(409, "conflict", "that address was just invited; try again");
  } else if (name && !existing?.name) {
    await tx.update(appUser).set({ name }).where(eq(appUser.id, userId));
  }
  await tx.insert(membership).values({ tenantId, userId, role: input.role });

  const signIns = knowsSignIns(ctx);
  const result: InviteResult = {
    member: {
      userId,
      email,
      name: name ?? existing?.name ?? null,
      role: input.role,
      signedIn: signIns ? !!existing?.workosUserId : null,
    },
    email: { status: "failed", reason: "not_attempted" },
  };
  if (existing?.workosUserId) {
    // They have signed in before (to a client they have since left): no invitation to accept.
    result.email = { status: "not_sent", reason: "already_signed_up" };
  } else {
    // DECISION: the email goes after the commit, so nobody is emailed about an invite that rolled
    // back; after-commit work runs before the response, which then reports how it went.
    ctx.afterCommit(async () => {
      const choice = ctx.services.auth();
      if (!choice.ok) return;
      result.email = emailOf(await choice.adapter.invite(email));
    });
  }
  return result;
}

// ── Overview ─────────────────────────────────────────────────────────────────────────────────────

/** The first line of a run's error, short. */
function errorText(error: unknown): string | null {
  const raw =
    typeof error === "string"
      ? error
      : error &&
          typeof error === "object" &&
          typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : null;
  if (!raw) return null;
  const line = raw.split("\n")[0] ?? raw;
  return line.length > 300 ? `${line.slice(0, 297)}…` : line;
}

async function overview(
  ctx: HandlerCtx<typeof routes.opsOverview>,
  now: Date,
): Promise<OpsOverview> {
  const { tx, tenantIds, session, services } = ctx;
  const since = new Date(now.getTime() - FAILED_RUN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const empty: OpsOverview = {
    since: since.toISOString(),
    clients: 0,
    failedRuns: [],
    inbox: [],
    connections: [],
    updates: [],
    counts: { failedRuns: 0, inbox: 0, connections: 0, updates: 0 },
  };
  if (tenantIds.length === 0) return empty;
  const ids = [...tenantIds];

  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, ids));
  const clientRef = (id: string | null) => ({
    id: id ?? "",
    name: clients.find((c) => c.id === id)?.name ?? "",
  });

  // Failed live runs (test runs are the operator's own experiments).
  const failedWhere = and(
    inArray(run.tenantId, ids),
    eq(run.mode, "live"),
    eq(run.status, "failed"),
    or(gte(run.finishedAt, since), and(isNull(run.finishedAt), gte(run.createdAt, since))),
  );
  const failed = await tx
    .select()
    .from(run)
    .where(failedWhere)
    .orderBy(desc(run.createdAt))
    .limit(OVERVIEW_LIMIT);
  const [failedCount] = await tx.select({ n: count() }).from(run).where(failedWhere);

  // The operator inbox: open items for the operator role or this operator.
  const inboxWhere = and(
    inArray(inboxItem.tenantId, ids),
    eq(inboxItem.status, "open"),
    or(eq(inboxItem.assigneeRole, "operator"), eq(inboxItem.assigneeUserId, session.user.id)),
  );
  const items = await tx
    .select()
    .from(inboxItem)
    .where(inboxWhere)
    .orderBy(desc(inboxItem.createdAt))
    .limit(OVERVIEW_LIMIT);
  const [inboxCount] = await tx.select({ n: count() }).from(inboxItem).where(inboxWhere);

  // Client agents: who uses which connection, and whose template moved on.
  const agents = await tx
    .select()
    .from(agent)
    .where(
      and(
        inArray(agent.tenantId, ids),
        eq(agent.kind, "client"),
        eq(agent.status, "active"),
        eq(agent.testCopy, false),
        or(isNull(agent.runStatus), ne(agent.runStatus, "retired")),
      ),
    )
    .orderBy(agent.slug);
  const agentRef = (id: string | null) => {
    const a = agents.find((x) => x.id === id);
    return a ? { id: a.id, slug: a.slug, name: a.serviceName ?? a.name } : null;
  };

  // DECISION: a connection needs the client when it is in error (sign in again), or disconnected
  // while an agent still uses it. A disconnected connection nobody uses is the client's choice.
  const names = new Map(
    services.platform.connectors.list().map((c) => [c.manifest.id, c.manifest.name]),
  );
  const troubled = await tx
    .select()
    .from(connection)
    .where(
      and(inArray(connection.tenantId, ids), inArray(connection.status, ["error", "disconnected"])),
    )
    .orderBy(connection.connector);
  const connections = troubled
    .map((c) => ({
      id: c.id,
      client: clientRef(c.tenantId),
      connector: c.connector,
      connectorName: names.get(c.connector) ?? c.connector,
      status: c.status,
      usedBy: agents
        .filter((a) => a.tenantId === c.tenantId && Object.values(a.bindings).includes(c.id))
        .map((a) => a.serviceName ?? a.name),
    }))
    .filter((c) => c.status === "error" || c.usedBy.length > 0);

  const updates: OpsOverview["updates"] = [];
  const linked = agents.filter((a) => a.linked && a.templateId && a.liveVersionId);
  const templates = linked.length
    ? await tx
        .select({ id: agent.id, name: agent.name })
        .from(agent)
        .where(
          and(
            inArray(agent.id, [...new Set(linked.map((a) => a.templateId as string))]),
            isNull(agent.tenantId),
          ),
        )
    : [];
  for (const a of linked) {
    const info = await updateInfo(tx, { agentId: a.id });
    if (!info.available) continue;
    const ref = agentRef(a.id);
    if (!ref) continue;
    updates.push({
      agent: ref,
      client: clientRef(a.tenantId),
      template: {
        id: a.templateId as string,
        name: templates.find((t) => t.id === a.templateId)?.name ?? "",
      },
      behind: info.behind,
      releaseNote: info.releaseNote,
    });
  }

  return {
    since: since.toISOString(),
    clients: clients.length,
    failedRuns: failed.map((r) => ({
      id: r.id,
      client: clientRef(r.tenantId),
      agent: agentRef(r.agentId),
      workflowSlug: r.workflowSlug,
      error: errorText(r.error),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    inbox: items.map((i) => ({
      id: i.id,
      client: clientRef(i.tenantId),
      kind: i.kind,
      title: i.title,
      dueAt: i.dueAt?.toISOString() ?? null,
      createdAt: i.createdAt.toISOString(),
    })),
    connections: connections.slice(0, OVERVIEW_LIMIT),
    updates: updates.slice(0, OVERVIEW_LIMIT),
    counts: {
      failedRuns: failedCount?.n ?? 0,
      inbox: inboxCount?.n ?? 0,
      connections: connections.length,
      updates: updates.length,
    },
  };
}

// ── Client settings ──────────────────────────────────────────────────────────────────────────────

async function clientRow(tx: Tx, tenantId: string): Promise<TenantRow> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return t;
}

async function opsSettings(
  ctx: Pick<HandlerCtx<RouteSpec>, "tx" | "services">,
  t: TenantRow,
): Promise<OpsClientSettings> {
  const { tx } = ctx;
  const changes = await tx
    .select({
      id: tenantChange.id,
      change: tenantChange.change,
      reason: tenantChange.reason,
      actorId: tenantChange.actorId,
      email: appUser.email,
      name: appUser.name,
      createdAt: tenantChange.createdAt,
    })
    .from(tenantChange)
    .leftJoin(appUser, eq(appUser.id, tenantChange.actorId))
    .where(eq(tenantChange.tenantId, t.id))
    .orderBy(desc(tenantChange.createdAt), desc(tenantChange.id));
  const approver = (v: unknown): ExternalApprover =>
    v === "operator" ? "operator" : "client_admin";
  return {
    client: { id: t.id, name: t.name, timezone: t.timezone, sandbox: t.settings.sandbox === true },
    approvals: {
      externalActions: approvalsOf(t.settings),
      changes: changes
        .filter((c) => c.change.setting === APPROVALS_SETTING)
        .map((c) => ({
          id: c.id,
          from: approver(c.change.from),
          to: approver(c.change.to),
          reason: c.reason,
          by: c.actorId ? { id: c.actorId, email: c.email ?? "", name: c.name } : null,
          createdAt: c.createdAt.toISOString(),
        })),
    },
    notifications: notificationsOf(t.settings),
    members: await membersOf(tx, t.id, { clientRolesOnly: false, signIns: knowsSignIns(ctx) }),
  };
}

export function onboardingRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ────────────────────────────────────────────────────────────────────────────────
  mount(app, routes.opsOverview, (ctx) => overview(ctx, new Date()));

  mount(app, routes.opsClientSettings, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return opsSettings(ctx, await clientRow(ctx.tx, ctx.params.id));
  });

  mount(app, routes.opsUpdateClientSettings, async (ctx) => {
    const { tx, params, body, session } = ctx;
    ensureClient(ctx, params.id);
    const t = await clientRow(tx, params.id);
    const set: Partial<typeof tenant.$inferInsert> = {};
    if (body.name !== undefined && body.name !== t.name) set.name = body.name;
    if (body.timezone !== undefined && body.timezone !== t.timezone) {
      if (!validTimezone(body.timezone)) {
        throw new HttpError(422, "invalid_timezone", body.timezone);
      }
      set.timezone = body.timezone;
    }
    const from = approvalsOf(t.settings);
    const approvalsChange = body.approvals !== undefined && body.approvals !== from;
    if (approvalsChange && body.approvals) set.settings = withApprovals(t.settings, body.approvals);
    if (Object.keys(set).length === 0) throw new HttpError(409, "no_op", "nothing changed");
    await tx.update(tenant).set(set).where(eq(tenant.id, t.id));
    if (approvalsChange) {
      // DECISION: who approves a client's external actions is logged like the feedback switch
      // (tenant_change), with the reason when one is given (stored empty otherwise).
      await tx.insert(tenantChange).values({
        tenantId: t.id,
        actorId: session.user.id,
        change: { setting: APPROVALS_SETTING, from, to: body.approvals },
        reason: body.reason ?? "",
      });
    }
    return opsSettings(ctx, await clientRow(tx, t.id));
  });

  mount(app, routes.opsInvite, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const t = await clientRow(ctx.tx, ctx.params.id);
    // The Sandbox is the operator's own test client: it has no client people (§1.5).
    if (t.settings.sandbox === true) {
      throw new HttpError(409, "sandbox", "the Sandbox client has no client people");
    }
    return inviteToClient(ctx, ctx.params.id, ctx.body, { surface: "ops" });
  });

  // ── Portal (client admins) ─────────────────────────────────────────────────────────────────────
  mount(app, routes.portalUsers, async (ctx) => ({
    users: await membersOf(ctx.tx, ctx.tenantIds[0] as string, {
      clientRolesOnly: true,
      signIns: knowsSignIns(ctx),
    }),
  }));

  mount(app, routes.portalInvite, (ctx) =>
    // The session's one client, never one from the request.
    inviteToClient(ctx, ctx.tenantIds[0] as string, ctx.body, { surface: "portal" }),
  );

  mount(app, routes.portalSettings, async (ctx) => {
    const t = await clientRow(ctx.tx, ctx.tenantIds[0] as string);
    return {
      client: { id: t.id, name: t.name, timezone: t.timezone },
      approvals: approvalsOf(t.settings),
      notifications: notificationsOf(t.settings),
      // v0.12 W1-B: notification emails are sent (docs/plan.md §1.37) wherever Mezonas' sending
      // key is set up.
      // DECISION: `emailsOn` is the mailer's `isConfigured`: true with RESEND_API_KEY and
      // RESEND_FALLBACK_DOMAIN, false (rows `skipped`, `not_configured`) without them.
      emailsOn: mailerFromEnv(ctx.services.env).isConfigured,
    };
  });

  mount(app, routes.portalNotifications, async (ctx) => {
    const { tx, body } = ctx;
    const t = await clientRow(tx, ctx.tenantIds[0] as string);
    // DECISION: notification settings are the client's, not each person's: the client admin
    // chooses for everyone (ARCHITECTURE §4 gives notification settings to the client admin).
    const notifications = { ...notificationsOf(t.settings) };
    if (body.itemsWaiting !== undefined) notifications.itemsWaiting = body.itemsWaiting;
    if (body.weeklyDigest !== undefined) notifications.weeklyDigest = body.weeklyDigest;
    await tx
      .update(tenant)
      .set({ settings: { ...t.settings, notifications } })
      .where(eq(tenant.id, t.id));
    return { notifications };
  });
}
