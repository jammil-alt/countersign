// The Weekly Table's figures and setup items (ARCHITECTURE §11.4, docs/plan.md §1.37), computed
// from the client's own rows inside its withTenant: runs done (and the change from last week),
// changes to its tools (automatic and signed), signatures given, documents read, and each
// agent's week. Every figure carries the record ids it counted (invariant 10), capped; never cost.
// The Table (routes/table.ts) reads the same counts for the week so far.

import { requiredConnectors } from "@countersign/agents";
import {
  addDays,
  WEEKLY_SOURCES_MAX,
  type WeeklySetup,
  type WeeklyStats,
  weekBounds,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  docExtraction,
  externalAction,
  inboxItem,
  membership,
  run,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, eq, gte, inArray, isNotNull, lt, type SQL } from "drizzle-orm";
// v0.12 W2-G
import { readerLocale, weekKpis } from "../kpi/view";
import type { Platform } from "../platform";

type AgentRow = typeof agent.$inferSelect;

const cap = (ids: string[]) => ids.slice(0, WEEKLY_SOURCES_MAX);
export const serviceName = (a: Pick<AgentRow, "serviceName" | "name">) => a.serviceName ?? a.name;

/**
 * What a client agent does, in one line for its client: the operator's own description of it,
 * else its role as its template states it (copied to the agent when it was forked), else none,
 * and the portal shows nothing (QA round 1: never a placeholder).
 */
// DECISION: the template's role line ("Matches vendor invoices to bills in QuickBooks and fills
// the bills in") is the template's client-facing description; templates have no other one.
export const clientDescription = (a: Pick<AgentRow, "serviceDescription" | "role">) =>
  a.serviceDescription?.trim() || a.role?.trim() || null;

/** Live runs that finished `succeeded` between the bounds, newest first. */
export async function runsDone(
  tx: Tx,
  tenantId: string,
  b: { from: Date; to: Date },
): Promise<{ id: string; agentId: string }[]> {
  return tx
    .select({ id: run.id, agentId: run.agentId })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.mode, "live"),
        eq(run.status, "succeeded"),
        gte(run.finishedAt, b.from),
        lt(run.finishedAt, b.to),
      ),
    );
}

/** Writes to the client's tools that ran between the bounds: signed (approved) or automatic. */
export async function toolChanges(
  tx: Tx,
  tenantId: string,
  b: { from: Date; to: Date },
): Promise<{ automatic: string[]; signed: string[] }> {
  const rows = await tx
    .select({ id: externalAction.id, approvedBy: externalAction.approvedBy })
    .from(externalAction)
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.status, "done"),
        gte(externalAction.executedAt, b.from),
        lt(externalAction.executedAt, b.to),
      ),
    );
  return {
    signed: rows.filter((r) => r.approvedBy !== null).map((r) => r.id),
    automatic: rows.filter((r) => r.approvedBy === null).map((r) => r.id),
  };
}

function approved(resolution: unknown): boolean {
  const r = (resolution ?? {}) as { approved?: unknown; decision?: unknown };
  return r.approved === true || r.decision === "approve";
}

/** Approvals the client's own people gave between the bounds. */
async function signaturesGiven(tx: Tx, tenantId: string, b: { from: Date; to: Date }) {
  const rows = await tx
    .select({ id: inboxItem.id, resolution: inboxItem.resolution })
    .from(inboxItem)
    .innerJoin(
      membership,
      and(eq(membership.userId, inboxItem.resolvedBy), eq(membership.tenantId, inboxItem.tenantId)),
    )
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.status, "resolved"),
        inArray(inboxItem.kind, ["approval", "external_action"]),
        inArray(membership.role, ["client_admin", "client_user"]),
        gte(inboxItem.resolvedAt, b.from),
        lt(inboxItem.resolvedAt, b.to),
      ),
    );
  return rows.filter((r) => approved(r.resolution)).map((r) => r.id);
}

/** Documents read (an extraction made) between the bounds. */
async function documentsRead(tx: Tx, tenantId: string, b: { from: Date; to: Date }) {
  const rows = await tx
    .selectDistinct({ id: docExtraction.documentId })
    .from(docExtraction)
    .where(
      and(
        eq(docExtraction.tenantId, tenantId),
        gte(docExtraction.createdAt, b.from),
        lt(docExtraction.createdAt, b.to),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The client's services offered now: client agents that are not test copies, active or paused.
 * One predicate for the Weekly Table and the portal's Table (`agentsNow`, routes/usage.ts).
 */
export const isLiveService = (tenantId: string): SQL =>
  and(
    eq(agent.tenantId, tenantId),
    eq(agent.kind, "client"),
    eq(agent.testCopy, false),
    inArray(agent.runStatus, ["active", "paused"]),
  ) as SQL;

/** The client's services: client agents that are not test copies and not drafts. */
export async function services(tx: Tx, tenantId: string): Promise<AgentRow[]> {
  return tx.select().from(agent).where(isLiveService(tenantId)).orderBy(agent.slug);
}

/** The week's figures, computed now. */
export async function weeklyStats(
  tx: Tx,
  input: { tenantId: string; timezone: string; weekStart: string; now: Date },
): Promise<WeeklyStats> {
  const b = weekBounds(input.weekStart, input.timezone);
  const before = weekBounds(addDays(input.weekStart, -7), input.timezone);
  const done = await runsDone(tx, input.tenantId, b);
  const lastWeek = await runsDone(tx, input.tenantId, before);
  const changes = await toolChanges(tx, input.tenantId, b);
  const signatures = await signaturesGiven(tx, input.tenantId, b);
  const documents = await documentsRead(tx, input.tenantId, b);
  const agents = await services(tx, input.tenantId);
  // v0.12 W2-G: each agent's KPIs over the week, in the client's language.
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, input.tenantId));
  const kpis = await weekKpis(tx, agents, {
    locale: readerLocale({ settings: t?.settings ?? {} }, null),
    bounds: b,
  });
  return {
    weekStart: input.weekStart,
    from: b.from.toISOString(),
    to: b.to.toISOString(),
    runs: {
      done: done.length,
      lastWeek: lastWeek.length,
      change: done.length - lastWeek.length,
      sources: cap(done.map((r) => r.id)),
    },
    changes: {
      automatic: changes.automatic.length,
      signed: changes.signed.length,
      sources: cap([...changes.signed, ...changes.automatic]),
    },
    signatures: { given: signatures.length, sources: cap(signatures) },
    documents: { read: documents.length, sources: cap(documents) },
    agents: agents.map((a) => ({
      id: a.id,
      name: serviceName(a),
      runsDone: done.filter((r) => r.agentId === a.id).length,
      // v0.12 W2-G
      kpis: kpis.get(a.id) ?? [],
    })),
    computedAt: input.now.toISOString(),
  };
}

/**
 * Setup items from code: agents on the bench or in trial with a connection still to make ("Connect
 * your Amex"): a connector their live version needs that is unbound, or bound to a connection
 * that isn't connected.
 */
// DECISION: the connectors an agent needs are its bindings plus those its live version's platform
// skills, extra tools and action steps name (agents' `requiredConnectors` over the platform's
// catalog); a client's own custom skills count through their bindings only.
export async function setupItems(
  tx: Tx,
  tenantId: string,
  platform: Platform,
): Promise<WeeklySetup> {
  const agents = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        inArray(agent.stage, ["bench", "trial"]),
        inArray(agent.runStatus, ["draft", "testing", "active", "paused"]),
      ),
    )
    .orderBy(agent.slug);
  if (agents.length === 0) return { items: [] };
  const conns = await tx
    .select({ id: connection.id, connector: connection.connector, status: connection.status })
    .from(connection)
    .where(eq(connection.tenantId, tenantId));
  const skills = Object.fromEntries(platform.catalog.list().map((d) => [d.id, d]));
  const items: WeeklySetup["items"] = [];
  for (const a of agents) {
    const needed = new Set(Object.keys(a.bindings));
    if (a.liveVersionId) {
      const [v] = await tx
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(and(eq(agentVersion.id, a.liveVersionId), eq(agentVersion.tenantId, tenantId)));
      if (v) for (const c of requiredConnectors(v.bundle, skills, platform.tools)) needed.add(c);
    }
    for (const connector of [...needed].sort()) {
      const manifest = platform.connectors.get(connector)?.manifest;
      const bound = conns.find((c) => c.id === a.bindings[connector] && c.connector === connector);
      const usable =
        bound &&
        (bound.status === "connected" || (bound.status === "pending" && manifest?.auth === "none"));
      if (usable) continue;
      items.push({
        kind: "connect",
        agentId: a.id,
        agentName: serviceName(a),
        connector,
        tool: manifest?.name ?? connector,
      });
    }
  }
  return { items };
}

/** A user's display name, for the note's byline. */
export async function userName(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [u] = await tx
    .select({ name: appUser.name })
    .from(appUser)
    .where(and(eq(appUser.id, userId), isNotNull(appUser.id)));
  return u?.name ?? null;
}
