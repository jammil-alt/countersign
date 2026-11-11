// Installing a seeded platform template version from the back office (docs/plan.md §1.47
// "Template"): environments where the seed never runs (staging, production) get the supervisor's
// v2, Sloan, by `POST /api/ops/platform-templates/:slug/install`. The bundles are the seed's own
// files, bundled into the Worker. Idempotent by bundle hash; a missing template is installed from
// its v1 first, so its lineage matches the seed's. Publishing a template changes no client agent
// (invariant 11): each client's fork moves only by the usual reviewed update merge.

import {
  createTemplate,
  createVersion,
  getVersion,
  parseBundle,
  publish,
} from "@countersign/agents";
import { bundleHash, type InstalledPlatformTemplate } from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import billClerkV1 from "@countersign/db/seed/agents/bill-clerk.v1.json";
import builderV1 from "@countersign/db/seed/agents/builder.v1.json";
import coordinatorV1 from "@countersign/db/seed/agents/coordinator.v1.json";
import documentClerkV1 from "@countersign/db/seed/agents/document-clerk.v1.json";
import supervisorV1 from "@countersign/db/seed/agents/supervisor.v1.json";
import supervisorV2 from "@countersign/db/seed/agents/supervisor.v2.json";
import supervisorV3 from "@countersign/db/seed/agents/supervisor.v3.json";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import type { Platform } from "../platform";

/** The seed's platform template versions, by slug and version number. */
const SEEDED: Readonly<Record<string, Readonly<Record<number, unknown>>>> = {
  "bill-clerk": { 1: billClerkV1 },
  builder: { 1: builderV1 },
  coordinator: { 1: coordinatorV1 },
  "document-clerk": { 1: documentClerkV1 },
  supervisor: { 1: supervisorV1, 2: supervisorV2, 3: supervisorV3 },
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
  return versions[version];
}

export async function installPlatformTemplate(
  tx: Tx,
  input: { slug: string; version: number; actorId: string | null; platform: Platform },
): Promise<InstalledPlatformTemplate> {
  const bundle = parseBundle(seeded(input.slug, input.version));
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

  let templateId = existing?.id;
  let created = false;
  if (!templateId) {
    // DECISION: a template that isn't there yet starts from its seeded v1 (published), so each
    // later version has the same parent as in a seeded database.
    const first = parseBundle(seeded(input.slug, 1));
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
    await publish(tx, {
      agentId: templateId,
      versionId: made.version.id,
      actorId: input.actorId,
      ctx: input.platform.ctx,
    });
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
