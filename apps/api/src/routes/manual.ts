// The agent manual (docs/builder-plan.md §5, B3): the back office's Manual tab and the portal's.
// Both are core's `manualView`, made by code from the agent's version (its manual and its steps'
// names and kinds) and, for a client agent, its memory notes for that client read live
// (invariant 1). The portal's never carries the bundle, instructions, prompts or cost
// (invariant 11).

import { getAgent, getVersion, latestVersion } from "@countersign/agents";
import { adjustRoutes, manualRoutes, manualView } from "@countersign/core";
import { agent, agentVersion, memoryNote, type Tx } from "@countersign/db";
import { and, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { ensureSeesAgent } from "../assigned";
import { type AppEnv, mount, notFound } from "../http";
import { adjustSetting, manualFeedback, portalAdjustable } from "../setup/adjust";

/** How many of the agent's notes the manual shows, newest first. */
const LEARNED_MAX = 50;

/**
 * The agent's own live notes for its client: never a test run's (their scope is the run's), never
 * an area owner's or a person's, never another agent's or client's.
 */
export async function learnedNotes(tx: Tx, a: { id: string; tenantId: string | null }) {
  if (!a.tenantId) return [];
  const rows = await tx
    .select({ id: memoryNote.id, note: memoryNote.note, createdAt: memoryNote.createdAt })
    .from(memoryNote)
    .where(
      and(
        eq(memoryNote.tenantId, a.tenantId),
        eq(memoryNote.agentId, a.id),
        eq(memoryNote.scope, "agent"),
      ),
    )
    .orderBy(desc(memoryNote.createdAt), desc(memoryNote.id))
    .limit(LEARNED_MAX);
  return rows.map((r) => ({ id: r.id, note: r.note, at: r.createdAt.toISOString() }));
}

export function manualRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, manualRoutes.portalAgentManual, async ({ tx, tenantIds, params, agents, role }) => {
    const tenantId = tenantIds[0] as string;
    // §1.122: an agent off a limited client user's list is "not found", as another client's.
    ensureSeesAgent(agents, params.id);
    const [a] = await tx
      .select()
      .from(agent)
      .where(and(eq(agent.id, params.id), eq(agent.tenantId, tenantId), eq(agent.kind, "client")));
    if (!a || a.testCopy) throw notFound("service");
    // DECISION: the version that runs (its live one); before it has one, the version being set up.
    const v = a.liveVersionId
      ? await getVersion(tx, a.liveVersionId)
      : await latestVersion(tx, a.id);
    if (!v || v.agentId !== a.id || v.tenantId !== tenantId) throw notFound("service");
    // DECISION: what it learned is the client admin's to read, as the client's knowledge is: a
    // note may come from an admin's conversation a client user doesn't see.
    const admin = role === "client_admin";
    return manualView({
      agent: { id: a.id, name: a.serviceName ?? a.name },
      bundle: v.bundle,
      learned: admin ? await learnedNotes(tx, a) : [],
      audience: "client",
      fallbackWhat: a.serviceDescription,
    });
  });

  mount(app, manualRoutes.opsAgentManual, async ({ tx, tenantIds, params, query }) => {
    const row = await getAgent(tx, params.id);
    if (row.tenantId !== null && !tenantIds.includes(row.tenantId)) throw notFound("agent");
    const v = query.version
      ? (
          await tx
            .select()
            .from(agentVersion)
            .where(and(eq(agentVersion.agentId, row.id), eq(agentVersion.version, query.version)))
        )[0]
      : await latestVersion(tx, row.id);
    if (!v) throw notFound("version");
    return manualView({
      agent: { id: row.id, name: row.name },
      bundle: v.bundle,
      // A template has no client, so it has learned nothing: its copies learn, each for its own.
      learned: row.kind === "client" ? await learnedNotes(tx, row) : [],
      audience: "operator",
      fallbackWhat: row.serviceDescription,
    });
  });

  // ── B5 (docs/builder-plan.md §7): client adjustments and feedback on the manual ──────────────

  mount(app, adjustRoutes.portalAgentAdjustable, async (ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    return {
      settings: await portalAdjustable(
        ctx.tx,
        ctx.tenantIds[0] as string,
        ctx.params.id,
        ctx.services.platform.ctx,
      ),
    };
  });

  mount(app, adjustRoutes.portalAgentAdjust, async (ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    return adjustSetting(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      agentId: ctx.params.id,
      settingId: ctx.params.settingId,
      body: ctx.body,
      actor: { userId: ctx.session.user.id, name: personName(ctx), side: "client" },
      ctx: ctx.services.platform.ctx,
    });
  });

  mount(app, adjustRoutes.portalManualFeedback, async (ctx) => {
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const request = await manualFeedback(ctx.tx, {
      tenantId: ctx.tenantIds[0] as string,
      agentId: ctx.params.id,
      body: ctx.body,
      actor: { userId: ctx.session.user.id, name: personName(ctx), side: "client" },
    });
    return { request };
  });
}

/** The person's name as the manual records who changed a setting (else their email). */
function personName(ctx: { session: { user: { name?: string | null; email: string } } }) {
  return ctx.session.user.name?.trim() || ctx.session.user.email || null;
}
