// The agent's SOP (docs/sop-plan.md S1): the portal's SOP tab (in the Manual tab's place) and the
// back office's view of a client agent's SOP. Both are core's `sopView`, made by code from the
// agent's setup now (./sop/inputs.ts), with its revision and history (./sop/revisions.ts). The
// portal's never carries the bundle, instructions, prompts or cost (invariant 11).

import { getAgent } from "@countersign/agents";
import { type SopView, sopListItem, sopRoutes, sopView } from "@countersign/core";
import { agent, sopRevision, type Tx } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { agentWhere, ensureSeesAgent } from "../assigned";
import { type AppEnv, mount, notFound } from "../http";
import { agentKpisNow, liveClientView, readerLocale } from "../kpi/view";
import { tenantRow } from "../notify/people";
import { reportProblem } from "../observability/report";
import type { Platform } from "../platform";
import { sopInputFor } from "../sop/inputs";
import { recordSopRevision, sopHistory, sopSettings } from "../sop/revisions";
import { learnedNotes } from "./manual";

type AgentRow = typeof agent.$inferSelect;

/**
 * The SOP for one reader. The portal's SOP tab, the Procedures page and Sloan's `sop.read` all read
 * it here, so they can't disagree. The current revision is made first if the setup changed without one
 * (a safety net: every change site records its own, so this is reported when it finds one).
 */
export async function readSop(
  tx: Tx,
  platform: Platform,
  a: AgentRow,
  reader: { userId: string | null; admin: boolean },
): Promise<SopView> {
  const tenantId = a.tenantId as string;
  const [had] = await tx
    .select({ id: sopRevision.id })
    .from(sopRevision)
    .where(and(eq(sopRevision.tenantId, tenantId), eq(sopRevision.agentId, a.id)))
    .limit(1);
  const made = await recordSopRevision(tx, platform, {
    tenantId,
    agentIds: [a.id],
    by: { userId: null, side: "system" },
    source: "check",
  });
  if (had && made.length > 0) reportProblem("sop revision made by a read", { agent: a.id });

  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  const now = new Date();
  const view = (await liveClientView(tx, a))?.view;
  const kpis = view
    ? await agentKpisNow(tx, a, view, {
        locale: readerLocale(t, reader.userId),
        timezone: t.timezone,
        now,
      })
    : [];
  const read = await sopInputFor(tx, platform, a, {
    // What it learned is the client admin's to read, as on the manual.
    learned: reader.admin ? await learnedNotes(tx, a) : null,
    measures: kpis.map((k) => ({ label: k.label, value: k.display ?? "No value yet" })),
    settings: await sopSettings(tx, platform, tenantId, a.id),
    asOf: now,
  });
  if (!read) throw notFound("service");
  const history = await sopHistory(tx, tenantId, a.id);
  const [revision, previous] = history;
  return sopView({
    ...read.input,
    revision: revision ?? null,
    previous: previous ? { number: previous.number, at: previous.at } : null,
    history,
  });
}

export function sopRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, sopRoutes.portalAgentSop, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    // §1.122: an agent off a limited client user's list is "not found", as another client's.
    ensureSeesAgent(ctx.agents, ctx.params.id);
    const [a] = await ctx.tx
      .select()
      .from(agent)
      .where(
        and(eq(agent.id, ctx.params.id), eq(agent.tenantId, tenantId), eq(agent.kind, "client")),
      );
    if (!a || a.testCopy) throw notFound("service");
    return readSop(ctx.tx, ctx.services.platform, a, {
      userId: ctx.session.user.id,
      admin: ctx.role === "client_admin",
    });
  });

  // S2 (docs/sop-plan.md §6 "Across agents"): every agent's SOP the reader can open, in a row
  // each, made from its own SOP. The agents the portal lists (live or paused, never a test copy);
  // §1.122: a limited client user's own agents only.
  mount(app, sopRoutes.portalSops, async (ctx) => {
    const tenantId = ctx.tenantIds[0] as string;
    const rows = await ctx.tx
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          eq(agent.testCopy, false),
          inArray(agent.runStatus, ["active", "paused"]),
          agentWhere(agent.id, ctx.agents),
        ),
      )
      .orderBy(agent.slug);
    const reader = { userId: ctx.session.user.id, admin: ctx.role === "client_admin" };
    // DECISION: one SOP after another in the request's transaction (a client has a handful of
    // agents); each row is made from the view its SOP tab shows, so a row never says what the
    // SOP doesn't.
    const sops = [];
    for (const a of rows) {
      sops.push(sopListItem(await readSop(ctx.tx, ctx.services.platform, a, reader)));
    }
    return { sops };
  });

  mount(app, sopRoutes.opsAgentSop, async (ctx) => {
    const row = await getAgent(ctx.tx, ctx.params.id);
    if (row.kind !== "client" || row.tenantId === null || !ctx.tenantIds.includes(row.tenantId)) {
      throw notFound("agent");
    }
    const [a] = await ctx.tx.select().from(agent).where(eq(agent.id, row.id));
    if (!a) throw notFound("agent");
    // The back office reads it as the client admin does, what it learned included.
    return readSop(ctx.tx, ctx.services.platform, a, { userId: null, admin: true });
  });
}
