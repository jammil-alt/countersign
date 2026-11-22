// Clearing the lab's Drafts on a test environment (docs/plan.md §1.173; owner, 2026-11-21: "is
// there a way to remove the agents in progress from staging so that we can test through some of
// these basic agents again? … staging only … we should have an archive … it is more now that we
// are trying to test and rebuild").
//
// One press stops every build in progress on the Drafts board and discards the drafts never
// published: those builds' own agents, and the templates with no build. Nothing is deleted
// (CLAUDE.md invariant 3): a stopped build keeps its page, records and events, and a discarded
// draft keeps its versions and can be restored from its page. The lab's Drafts lists both as its
// Archive. Never in production: the preview says so and the action is refused there.
//
// DECISION: by the environment's name, not a setting someone could turn on: it runs where
// ENVIRONMENT is `staging` or `development`, and nowhere else.

import { discardDraft } from "@countersign/agents";
import { type ClearedDrafts, routes } from "@countersign/core";
import { agent, build, type Tx } from "@countersign/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { addEvent, listBuilds } from "../build/store";
import type { Bindings } from "../env";
import { type AppEnv, HttpError, mount } from "../http";

type BuildRow = typeof build.$inferSelect;

/** What the build's event says, so its page shows why it stopped. */
export const CLEARED_REASON = "Cleared from Drafts to test again.";

/** Whether this environment's Drafts may be cleared: staging and development only. */
export function clearsDrafts(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  const name = env.ENVIRONMENT?.trim().toLowerCase();
  return name === "staging" || name === "development";
}

/** The builds on the Drafts board, and the drafts the clear discards, in the request's scope. */
async function clearable(
  tx: Tx,
  tenantIds: readonly string[],
): Promise<{ builds: BuildRow[]; drafts: string[] }> {
  // The board's own list: new agents and skills in progress (a build from a template is Build's).
  const builds = await listBuilds(tx, { status: "open", path: "new" });
  const theirs = builds.flatMap((b) => (b.agentId ? [b.agentId] : []));
  // Never published, not discarded already, not a test copy: what Discard draft takes.
  const unpublished = and(
    isNull(agent.liveVersionId),
    eq(agent.status, "active"),
    eq(agent.testCopy, false),
  );
  const ofBuilds = theirs.length
    ? await tx
        .select({ id: agent.id, tenantId: agent.tenantId })
        .from(agent)
        .where(and(unpublished, inArray(agent.id, theirs)))
    : [];
  // "Drafts without a build" on the board: templates never published.
  const templates = await tx
    .select({ id: agent.id, tenantId: agent.tenantId })
    .from(agent)
    .where(and(unpublished, isNull(agent.tenantId), eq(agent.kind, "template")));
  const drafts = new Set<string>();
  for (const a of [...ofBuilds, ...templates]) {
    if (a.tenantId === null || tenantIds.includes(a.tenantId)) drafts.add(a.id);
  }
  return { builds, drafts: [...drafts] };
}

export function opsLabClearRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsClearDraftsPreview, async (ctx) => {
    if (!clearsDrafts(ctx.services.env)) return { allowed: false, builds: 0, drafts: 0 };
    const found = await clearable(ctx.tx, ctx.tenantIds);
    return { allowed: true, builds: found.builds.length, drafts: found.drafts.length };
  });

  mount(app, routes.opsClearDrafts, async (ctx): Promise<ClearedDrafts> => {
    if (!clearsDrafts(ctx.services.env)) {
      throw new HttpError(403, "not_here", "Drafts are cleared on a test environment only");
    }
    const userId = ctx.session.user.id;
    const found = await clearable(ctx.tx, ctx.tenantIds);
    for (const row of found.builds) {
      await ctx.tx.update(build).set({ status: "stopped" }).where(eq(build.id, row.id));
      await addEvent(ctx.tx, row, {
        kind: "decision",
        payload: { stopped: true, cleared: true },
        reason: CLEARED_REASON,
        userId,
      });
    }
    for (const agentId of found.drafts) {
      await discardDraft(ctx.tx, { agentId, actorId: userId });
    }
    return { builds: found.builds.length, drafts: found.drafts.length };
  });
}
