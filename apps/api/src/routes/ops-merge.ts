// Back office: lineage between templates and client agents (ARCHITECTURE §9.3, §14 "Lineage"):
// a template update's merge preview and its merge draft, a promotion's preview and its template
// draft (client-specific values stripped, all or selected changes), detach and re-link. Every
// handler runs inside withOperator(the clients served). Nothing here publishes a merge: the
// operator test-runs and publishes the draft as any other version.

import {
  AgentsError,
  createPromotionDraft,
  createUpdateDraft,
  detach,
  getAgent,
  getVersion,
  previewPromotion,
  previewUpdate,
  publish,
  relink,
} from "@countersign/agents";
import { diffBundles, type Resolution, routes } from "@countersign/core";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount } from "../http";
import { agentSummary, versionDetail, versionSummary } from "./mappers";
import { agentInScope, labels } from "./ops-lineage";

async function clientAgentInScope(ctx: Parameters<typeof agentInScope>[0], id: string) {
  const row = await agentInScope(ctx, id);
  if (row.kind !== "client") {
    throw new HttpError(422, "not_a_client_agent", "only client agents take updates and promote");
  }
  return row;
}

/** Zod leaves `value` optional; core's Resolution has it (undefined is a value too). */
function resolutions(rs: readonly { path: string; choice: string; value?: unknown }[]) {
  return rs as Resolution[];
}

export function opsMergeRoutes(app: Hono<AppEnv>): void {
  // DECISION: an update always merges the template's live version (plan §1.6 "Lineage routes").
  mount(app, routes.opsUpdatePreview, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const preview = await previewUpdate(ctx.tx, { agentId: row.id });
    const template = await getAgent(ctx.tx, preview.theirs.agentId);
    return {
      template: agentSummary(template),
      base: versionDetail(preview.base),
      ours: versionDetail(preview.ours),
      theirs: versionDetail(preview.theirs),
      conflicts: preview.result.conflicts,
      labels: labels(preview.base.bundle, preview.ours.bundle, preview.theirs.bundle),
    };
  });

  mount(app, routes.opsUpdate, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const { version } = await createUpdateDraft(ctx.tx, {
      agentId: row.id,
      resolutions: resolutions(ctx.body.resolutions),
      actorId: ctx.session.user.id,
      changeNote: ctx.body.changeNote ?? null,
      ctx: ctx.services.platform.ctx,
    });
    return { version: versionSummary(version) };
  });

  mount(app, routes.opsPromotePreview, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const preview = await previewPromotion(ctx.tx, {
      agentId: row.id,
      versionId: ctx.query.version ?? null,
      ctx: ctx.services.platform.ctx,
    });
    const template = await getAgent(ctx.tx, preview.ours.agentId);
    return {
      template: agentSummary(template),
      client: versionSummary(preview.client),
      base: versionDetail(preview.base),
      ours: versionDetail(preview.ours),
      theirs: { ...versionDetail(preview.client), bundle: preview.stripped },
      conflicts: preview.result.conflicts,
      leftOut: diffBundles(preview.stripped, preview.client.bundle),
      labels: labels(preview.base.bundle, preview.ours.bundle, preview.client.bundle),
    };
  });

  mount(app, routes.opsPromote, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    const { body } = ctx;
    const { version } = await createPromotionDraft(ctx.tx, {
      agentId: row.id,
      versionId: body.versionId ?? null,
      changes: body.changes ?? null,
      resolutions: resolutions(body.resolutions),
      actorId: ctx.session.user.id,
      changeNote: body.changeNote ?? null,
      releaseNote: body.releaseNote ?? null,
      ctx: ctx.services.platform.ctx,
    });
    const template = await getAgent(ctx.tx, version.agentId);
    return { template: agentSummary(template), version: versionSummary(version) };
  });

  mount(app, routes.opsDetach, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    if (!row.linked) throw new HttpError(409, "invalid_state", `${row.slug} is already detached`);
    return {
      agent: agentSummary(await detach(ctx.tx, { agentId: row.id, actorId: ctx.session.user.id })),
    };
  });

  mount(app, routes.opsRelink, async (ctx) => {
    const row = await clientAgentInScope(ctx, ctx.params.id);
    if (row.linked) {
      throw new HttpError(409, "invalid_state", `${row.slug} is linked: apply its updates instead`);
    }
    const tv = await getVersion(ctx.tx, ctx.body.templateVersionId);
    const template = await getAgent(ctx.tx, tv.agentId);
    if (template.kind !== "template") throw new HttpError(422, "not_a_template", "not a template");
    if (tv.status === "draft") {
      throw new HttpError(409, "invalid_state", "pick a published template version");
    }
    const version = await relink(ctx.tx, {
      agentId: row.id,
      templateVersionId: tv.id,
      actorId: ctx.session.user.id,
    });
    // DECISION: re-linking publishes its version at once. The bundle is the live one unchanged;
    // only its base moves, and "update available" reads the live version's base, so leaving it a
    // draft would compare the new template against the old base.
    const live = await publish(ctx.tx, {
      agentId: row.id,
      versionId: version.id,
      actorId: ctx.session.user.id,
      ctx: ctx.services.platform.ctx,
    }).catch((error: unknown) => {
      if (error instanceof AgentsError && error.code === "invalid_bundle") {
        throw new HttpError(
          422,
          "invalid_bundle",
          "the live version no longer validates: fix it, then re-link",
          error.details,
        );
      }
      throw error;
    });
    return { agent: agentSummary(await getAgent(ctx.tx, row.id)), version: versionSummary(live) };
  });
}
