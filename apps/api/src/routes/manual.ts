// The agent manual (docs/builder-plan.md §5, B3): the back office's Manual tab and the portal's.
// Both are core's `manualView`, made by code from the agent's version (its manual and its steps'
// names and kinds) and, for a client agent, its memory notes for that client read live
// (invariant 1). The portal's never carries the bundle, instructions, prompts or cost
// (invariant 11).

import { getAgent, getVersion, latestVersion } from "@countersign/agents";
import {
  type AnyAgentBundle,
  adjustRoutes,
  type HandledText,
  manualRoutes,
  manualView,
  readManual,
  riskHits,
} from "@countersign/core";
import { agent, agentVersion, inboxItem, memoryNote, run, type Tx } from "@countersign/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
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

/** How many of the agent's handled items the count reads, newest first. */
const HANDLED_MAX = 1000;

/** The words a person wrote when they resolved an item: its reason, note, comment or answer. */
function resolutionWords(resolution: unknown): string {
  if (!resolution || typeof resolution !== "object") return "";
  const r = resolution as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["reason", "note", "comment", "answer"]) {
    const v = r[k];
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const x of Object.values(v)) if (typeof x === "string") out.push(x);
    }
  }
  return out.join(" ").slice(0, 2000);
}

/**
 * How many of a client agent's live runs hit each known risk in its manual (G5), counted when the
 * manual is read from what people wrote where they handled those runs. Null for an agent with no
 * client (a template has no runs of its own: its copies count, each for its own client).
 */
// DECISION (G5): counted at read time from the agent's live runs (test and dry runs left out),
// over its latest 1000 resolved items, with no stored count and no migration. A person step's
// title counts (the drafter hands a known risk to a person, §1.153), an approval's title doesn't
// (it names the write, not the case). Counted per agent: a template's manual shows no count.
export async function knownRiskHits(
  tx: Tx,
  a: { id: string; tenantId: string | null },
  bundle: AnyAgentBundle,
): Promise<Map<string, number> | undefined> {
  if (!a.tenantId) return undefined;
  const risks = readManual(bundle.definition.manual)?.knownRisks ?? [];
  if (risks.length === 0) return new Map();
  const rows = await tx
    .select({
      runId: inboxItem.runId,
      kind: inboxItem.kind,
      title: inboxItem.title,
      resolution: inboxItem.resolution,
    })
    .from(inboxItem)
    .innerJoin(run, and(eq(run.id, inboxItem.runId), eq(run.tenantId, inboxItem.tenantId)))
    .where(
      and(
        eq(inboxItem.tenantId, a.tenantId),
        eq(run.agentId, a.id),
        eq(run.mode, "live"),
        eq(inboxItem.status, "resolved"),
        isNotNull(inboxItem.runId),
      ),
    )
    .orderBy(desc(inboxItem.resolvedAt), desc(inboxItem.id))
    .limit(HANDLED_MAX);
  const handled: HandledText[] = rows.map((r) => ({
    runId: r.runId as string,
    text: [
      r.kind === "approval" || r.kind === "external_action" ? "" : r.title,
      resolutionWords(r.resolution),
    ].join(" "),
  }));
  return riskHits(risks, handled);
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
      hits: await knownRiskHits(tx, a, v.bundle),
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
      hits: row.kind === "client" ? await knownRiskHits(tx, row, v.bundle) : undefined,
    });
  });

  // G5: the back office deletes one of what a client agent learned for its client. A note is the
  // client's own record, read live (invariant 1), not part of the agent's version: deleting it
  // makes no version (the version history, invariant 3, holds no note) and is audited by `mount`.
  // DECISION (G5): back office only, as an area owner's notes are (opsOwnerForget); the portal's
  // manual stays read only, and a client asks us. Only the agent's own `agent`-scope notes, the
  // ones the manual shows; a test run's or another agent's is not found.
  mount(app, manualRoutes.opsAgentForgetNote, async ({ tx, tenantIds, params }) => {
    const row = await getAgent(tx, params.id);
    if (row.kind !== "client" || !row.tenantId || !tenantIds.includes(row.tenantId)) {
      throw notFound("agent");
    }
    const gone = await tx
      .delete(memoryNote)
      .where(
        and(
          eq(memoryNote.id, params.noteId),
          eq(memoryNote.tenantId, row.tenantId),
          eq(memoryNote.agentId, row.id),
          eq(memoryNote.scope, "agent"),
        ),
      )
      .returning({ id: memoryNote.id });
    if (gone.length === 0) throw notFound("memory note");
    return { ok: true as const };
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
