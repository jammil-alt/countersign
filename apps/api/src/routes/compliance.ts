// Compliance (docs/plan.md §1.35): the audit log and the access review, a client's HIPAA mode, and
// retiring a client. Operator only; every route is itself audited by mount().

import { retire as retireAgent } from "@countersign/agents";
import {
  type ClientCompliance,
  complianceOf,
  hipaaReadiness,
  PROCESSOR_NAMES,
  PROCESSORS,
  type Processor,
  parseCoveredProcessors,
  RETIREMENT_PURGE_DAYS,
  routes,
} from "@countersign/core";
import {
  agent,
  appUser,
  auditEvent,
  connection,
  membership,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lt,
  lte,
  max,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import type { Hono } from "hono";
import type { Bindings } from "../env";
import { type AppEnv, ensureClient, HttpError, iso, mount, notFound, type Services } from "../http";
import { disconnect } from "./connections";
import { isSandbox, offeredConnectors } from "./ops-clients";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The vendors with a signed BAA, from `BAA_PROCESSORS`. */
export function coveredProcessors(env: Pick<Bindings, "BAA_PROCESSORS">): ReadonlySet<Processor> {
  return parseCoveredProcessors(env.BAA_PROCESSORS);
}

/** When a retired client's data may be purged. */
export const purgeAfter = (retiredAt: Date): Date =>
  new Date(retiredAt.getTime() + RETIREMENT_PURGE_DAYS * DAY_MS);

const COMPLIANCE_SETTINGS = ["hipaa", "retired"];

async function complianceView(tx: Tx, env: Bindings, tenantId: string): Promise<ClientCompliance> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  const covered = coveredProcessors(env);
  const settings = t.settings as Record<string, unknown>;
  const problems = hipaaReadiness(covered, offeredConnectors(settings));
  const changes = await tx
    .select({
      id: tenantChange.id,
      change: tenantChange.change,
      reason: tenantChange.reason,
      actorId: tenantChange.actorId,
      email: appUser.email,
      createdAt: tenantChange.createdAt,
    })
    .from(tenantChange)
    .leftJoin(appUser, eq(appUser.id, tenantChange.actorId))
    .where(eq(tenantChange.tenantId, tenantId))
    .orderBy(desc(tenantChange.createdAt), desc(tenantChange.id));
  return {
    clientId: t.id,
    hipaa: complianceOf(settings).hipaa,
    readiness: { ready: problems.length === 0, problems },
    processors: PROCESSORS.map((id) => ({
      id,
      name: PROCESSOR_NAMES[id],
      covered: covered.has(id),
    })),
    retiredAt: iso(t.retiredAt),
    purgeAfter: t.retiredAt ? purgeAfter(t.retiredAt).toISOString() : null,
    changes: changes
      .filter((r) => COMPLIANCE_SETTINGS.includes(String(r.change.setting)))
      .map((r) => ({
        id: r.id,
        setting: String(r.change.setting),
        to: r.change.to ?? null,
        reason: r.reason,
        by: r.actorId ? { id: r.actorId, email: r.email ?? "" } : null,
        createdAt: r.createdAt.toISOString(),
      })),
  };
}

export function complianceRouteHandlers(app: Hono<AppEnv>): void {
  // ── The audit log ──────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsAudit, async ({ tx, query }) => {
    // Row-level security already limits rows to the clients this operator serves (and `?client=`
    // narrows the scope), plus rows with no client.
    const where: SQL[] = [];
    if (query.client) where.push(eq(auditEvent.tenantId, query.client));
    if (query.user) where.push(eq(auditEvent.actorUserId, query.user));
    if (query.action) where.push(like(auditEvent.action, `${escapeLike(query.action)}%`));
    if (query.outcome) where.push(eq(auditEvent.outcome, query.outcome));
    if (query.from) where.push(gte(auditEvent.createdAt, new Date(query.from)));
    if (query.to) where.push(lte(auditEvent.createdAt, new Date(query.to)));
    if (query.before) where.push(lt(auditEvent.id, query.before));
    const rows = await tx
      .select({ e: auditEvent, clientName: tenant.name })
      .from(auditEvent)
      .leftJoin(tenant, eq(tenant.id, auditEvent.tenantId))
      .where(where.length ? and(...where) : undefined)
      // uuid v7 ids sort by time: the id is the page cursor.
      .orderBy(desc(auditEvent.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return {
      events: page.map(({ e, clientName }) => ({
        id: e.id,
        client: e.tenantId ? { id: e.tenantId, name: clientName ?? null } : null,
        actor: {
          kind: e.actorKind,
          id: e.actorUserId,
          email: e.actorEmail,
          role: e.actorRole,
        },
        action: e.action,
        outcome: e.outcome,
        httpStatus: e.httpStatus,
        target: e.target,
        ip: e.ip,
        userAgent: e.userAgent,
        createdAt: e.createdAt.toISOString(),
      })),
      nextBefore: rows.length > query.limit ? (page.at(-1)?.e.id ?? null) : null,
    };
  });

  // ── The access review ──────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsAccessReview, async ({ tx, tenantIds }) => {
    if (tenantIds.length === 0) return { users: [], generatedAt: new Date().toISOString() };
    const rows = await tx
      .select({
        userId: appUser.id,
        email: appUser.email,
        name: appUser.name,
        tenantId: tenant.id,
        tenantName: tenant.name,
        retiredAt: tenant.retiredAt,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(appUser, eq(appUser.id, membership.userId))
      .innerJoin(tenant, eq(tenant.id, membership.tenantId))
      .where(inArray(membership.tenantId, [...tenantIds]))
      .orderBy(appUser.email, tenant.name);
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const lastSignIn = new Map<string, Date>();
    const lastSeen = new Map<string, Date>();
    if (userIds.length > 0) {
      for (const r of await tx
        .select({ id: auditEvent.actorUserId, at: max(auditEvent.createdAt) })
        .from(auditEvent)
        .where(
          and(
            inArray(auditEvent.actorUserId, userIds),
            eq(auditEvent.action, "session.sign_in"),
            eq(auditEvent.outcome, "ok"),
          ),
        )
        .groupBy(auditEvent.actorUserId)) {
        if (r.id && r.at) lastSignIn.set(r.id, r.at);
      }
      for (const r of await tx
        .select({ id: auditEvent.actorUserId, at: max(auditEvent.createdAt) })
        .from(auditEvent)
        .where(inArray(auditEvent.actorUserId, userIds))
        .groupBy(auditEvent.actorUserId)) {
        if (r.id && r.at) lastSeen.set(r.id, r.at);
      }
    }
    const users = new Map<string, ReturnType<typeof userOut>>();
    function userOut(r: (typeof rows)[number]) {
      return {
        id: r.userId,
        email: r.email,
        name: r.name,
        memberships: [] as {
          client: { id: string; name: string; retired: boolean };
          role: string;
        }[],
        lastSignInAt: iso(lastSignIn.get(r.userId)),
        lastSeenAt: iso(lastSeen.get(r.userId)),
      };
    }
    for (const r of rows) {
      const u = users.get(r.userId) ?? userOut(r);
      u.memberships.push({
        client: { id: r.tenantId, name: r.tenantName, retired: r.retiredAt !== null },
        role: r.role,
      });
      users.set(r.userId, u);
    }
    return { users: [...users.values()], generatedAt: new Date().toISOString() };
  });

  // ── HIPAA mode ─────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsClientCompliance, async ({ tx, params, tenantIds, services }) => {
    ensureClient({ tenantIds }, params.id);
    return complianceView(tx, services.env, params.id);
  });

  mount(
    app,
    routes.opsClientComplianceSet,
    async ({ tx, params, tenantIds, services, session, body }) => {
      ensureClient({ tenantIds }, params.id);
      const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id)).for("update");
      if (!t) throw notFound("client");
      if (t.retiredAt) throw new HttpError(409, "retired", "this client is retired");
      const settings = t.settings as Record<string, unknown>;
      const before = complianceOf(settings).hipaa;
      if (before === body.hipaa) return complianceView(tx, services.env, t.id);
      if (body.hipaa) {
        const problems = hipaaReadiness(
          coveredProcessors(services.env),
          offeredConnectors(settings),
        );
        if (problems.length > 0) {
          throw new HttpError(409, "not_ready", problems.join("; "), { problems });
        }
      }
      await tx
        .update(tenant)
        .set({
          settings: { ...settings, compliance: { ...complianceOf(settings), hipaa: body.hipaa } },
        })
        .where(eq(tenant.id, t.id));
      await tx.insert(tenantChange).values({
        tenantId: t.id,
        actorId: session.user.id,
        change: { setting: "hipaa", from: before, to: body.hipaa },
        reason: body.reason,
      });
      return complianceView(tx, services.env, t.id);
    },
  );

  // ── Retiring a client ──────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsClientRetire, async ({ tx, params, tenantIds, services, session, body }) => {
    ensureClient({ tenantIds }, params.id);
    const [t] = await tx.select().from(tenant).where(eq(tenant.id, params.id)).for("update");
    if (!t) throw notFound("client");
    if (t.retiredAt) throw new HttpError(409, "retired", "this client is already retired");
    if (isSandbox(t.settings as Record<string, unknown>)) {
      throw new HttpError(409, "sandbox", "the Sandbox client can't be retired");
    }
    if (body.confirmName.toLowerCase() !== t.name.trim().toLowerCase()) {
      throw new HttpError(422, "confirm_name", "type the client's name exactly to retire it");
    }
    await retireClient(tx, services, t.id, session.user.id);
    await tx.insert(tenantChange).values({
      tenantId: t.id,
      actorId: session.user.id,
      change: { setting: "retired", from: null, to: new Date().toISOString() },
      reason: body.reason,
    });
    return complianceView(tx, services.env, t.id);
  });
}

/**
 * Retires a client (docs/plan.md §1.35): every client agent retired (no new runs), every
 * connection disconnected (grants revoked at the provider, credentials removed), and
 * `retired_at` set, which ends its users' access.
 */
export async function retireClient(
  tx: Tx,
  services: Services,
  tenantId: string,
  actorId: string,
): Promise<void> {
  const agents = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        or(isNull(agent.runStatus), ne(agent.runStatus, "retired")),
      ),
    );
  for (const a of agents) await retireAgent(tx, { agentId: a.id, actorId });
  const connections = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), ne(connection.status, "disconnected")));
  for (const row of connections) {
    await disconnect(tx, services, row, { actorId, by: "operator" });
  }
  await tx
    .update(tenant)
    .set({ retiredAt: new Date() })
    .where(and(eq(tenant.id, tenantId), isNull(tenant.retiredAt)));
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
