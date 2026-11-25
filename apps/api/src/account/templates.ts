// Installing a seeded platform template version from the back office (docs/plan.md §1.47
// "Template"): environments where the seed never runs (staging, production) get a platform agent
// by `POST /api/ops/platform-templates/:slug/install`. The bundles are the seed's own files,
// bundled into the Worker. Idempotent by bundle hash; a missing template is installed from its v1
// first, so its lineage matches the seed's. Publishing a template changes no client agent
// (invariant 11): each client's fork moves only by the usual reviewed update merge. Step model
// (docs/step-model-plan.md §12, R0): each platform agent is seeded once, as v1 in the step model;
// a later version file may still name the version it changes (`seedVersionBundle`), read here
// exactly as the seed reads it, so the hashes agree.

import {
  createTemplate,
  createVersion,
  getVersion,
  parseVersionBundle,
  publish,
  validateForPublish,
} from "@countersign/agents";
import { bundleHash, type InstalledPlatformTemplate } from "@countersign/core";
import { agent, agentVersion, seedVersionBundle, type Tx } from "@countersign/db";
import billClerk from "@countersign/db/seed/agents/bill-clerk.v1.json";
import builder from "@countersign/db/seed/agents/builder.v1.json";
import coordinator from "@countersign/db/seed/agents/coordinator.v1.json";
import documentClerk from "@countersign/db/seed/agents/document-clerk.v1.json";
import supervisor from "@countersign/db/seed/agents/supervisor.v1.json";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import type { Platform } from "../platform";

/** The seed's platform template version files, by slug and version number. */
// DECISION (step model, stream C): after the purge (docs/step-model-plan.md §12, R0) each platform
// agent is seeded once, as v1 in the step model (workflow `schemaVersion: 5`); its earlier v3 and
// v4 versions are in git history, not in the seed.
const SEEDED: Readonly<Record<string, Readonly<Record<number, unknown>>>> = {
  "bill-clerk": { 1: billClerk },
  builder: { 1: builder },
  coordinator: { 1: coordinator },
  "document-clerk": { 1: documentClerk },
  supervisor: { 1: supervisor },
};

/** The newest seeded version of a platform template, or null when the seed has none. */
export function latestSeededVersion(slug: string): number | null {
  const versions = Object.hasOwn(SEEDED, slug) ? SEEDED[slug] : undefined;
  if (!versions) return null;
  const numbers = Object.keys(versions).map(Number);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function seeded(slug: string, version: number): unknown {
  // Own keys only: a slug like `__proto__` or `constructor` finds nothing.
  const versions = Object.hasOwn(SEEDED, slug) ? SEEDED[slug] : undefined;
  if (!versions || !Object.hasOwn(versions, version)) {
    throw notFound(`seeded version ${version} of ${slug}`);
  }
  return seedVersionBundle(versions, version, `seeded ${slug}`);
}

export async function installPlatformTemplate(
  tx: Tx,
  input: { slug: string; version: number; actorId: string | null; platform: Platform },
): Promise<InstalledPlatformTemplate> {
  // A seeded version holds step-model (v5) workflows; `parseVersionBundle` reads every version.
  const bundle = parseVersionBundle(seeded(input.slug, input.version));
  if (bundle.definition.kind !== "platform") {
    throw new HttpError(422, "not_platform", "only platform templates are installed this way");
  }
  const hash = await bundleHash(bundle);
  const [existing] = await tx
    .select()
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.slug, input.slug)));
  if (existing && existing.kind !== "template") {
    throw new HttpError(409, "not_a_template", `${input.slug} is not a template`);
  }

  if (existing) {
    // A seeded version older than one the template already holds would be published over it.
    const newest = await newestSeededHeld(tx, input.slug, existing.id);
    if (newest !== null && input.version < newest) {
      throw new HttpError(
        409,
        "older_version",
        `${input.slug} already has seeded v${newest}; v${input.version} is older and is not installed over it`,
      );
    }
  }

  let templateId = existing?.id;
  let created = false;
  if (!templateId) {
    // DECISION: a template that isn't there yet starts from its seeded v1 (published), so each
    // later version has the same parent as in a seeded database.
    const first = parseVersionBundle(seeded(input.slug, 1));
    const made = await createTemplate(tx, {
      slug: input.slug,
      bundle: first,
      authorType: "operator",
      authorId: input.actorId,
      changeNote: "Installed platform template",
      releaseNote: "First version",
    });
    templateId = made.agent.id;
    created = true;
    // DECISION (R9): asked for a later version, v1 is published only when it passes publishing's
    // checks; otherwise it stays the template's first version, a draft under the one asked for.
    const v1Errors =
      input.version === 1
        ? []
        : await validateForPublish(tx, made.agent, made.version.bundle, input.platform.ctx);
    if (v1Errors.length === 0) {
      await publish(tx, {
        agentId: templateId,
        versionId: made.version.id,
        // Review: the platform's first version, from code: none of its steps is new work.
        installed: true,
        actorId: input.actorId,
        ctx: input.platform.ctx,
      });
    }
  }

  const [same] = await tx
    .select()
    .from(agentVersion)
    .where(and(eq(agentVersion.agentId, templateId), eq(agentVersion.bundleHash, hash)))
    .limit(1);
  if (same) return result(input.slug, templateId, same, created);

  const draft = await createVersion(tx, {
    agentId: templateId,
    bundle,
    authorType: "operator",
    authorId: input.actorId,
    changeNote: `Installed platform template v${input.version}`,
    releaseNote: `Seeded v${input.version}`,
  });
  const live = await publish(tx, {
    agentId: templateId,
    versionId: draft.id,
    actorId: input.actorId,
    ctx: input.platform.ctx,
  });
  return result(input.slug, templateId, await getVersion(tx, live.id), true);
}

/**
 * The newest seeded version whose bundle the template holds (any status), or null when it holds
 * none of them (only versions the operator built).
 */
// DECISION: compared with the newest seeded version the template has ever held, not only its live
// one, so a template whose live version is an operator's edit of seeded v6 still refuses v3. Going
// back is a rollback in the back office, which keeps the history; an install never goes back.
async function newestSeededHeld(tx: Tx, slug: string, templateId: string): Promise<number | null> {
  const rows = await tx
    .select({ hash: agentVersion.bundleHash })
    .from(agentVersion)
    .where(eq(agentVersion.agentId, templateId));
  const held = new Set(rows.map((r) => r.hash));
  const versions = Object.hasOwn(SEEDED, slug) ? SEEDED[slug] : undefined;
  let newest: number | null = null;
  for (const n of Object.keys(versions ?? {}).map(Number)) {
    if (newest !== null && n <= newest) continue;
    if (held.has(await bundleHash(parseVersionBundle(seeded(slug, n))))) newest = n;
  }
  return newest;
}

function result(
  slug: string,
  templateId: string,
  v: typeof agentVersion.$inferSelect,
  installed: boolean,
): InstalledPlatformTemplate {
  return {
    template: { id: templateId, slug },
    version: { id: v.id, version: v.version, status: v.status },
    installed,
  };
}
