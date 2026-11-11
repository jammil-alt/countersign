// Installing a seeded platform template version from the back office (docs/plan.md §1.47
// "Template"): environments where the seed never runs (staging, production) get the supervisor's
// v2, Sloan, by `POST /api/ops/platform-templates/:slug/install`. The bundles are the seed's own
// files, bundled into the Worker. Idempotent by bundle hash; a missing template is installed from
// its v1 first, so its lineage matches the seed's. Publishing a template changes no client agent
// (invariant 11): each client's fork moves only by the usual reviewed update merge. R9: the latest
// seeded versions hold v4 processes, and a later version file may name the version it changes
// (`seedVersionBundle`), read here exactly as the seed reads it, so the hashes agree.

import {
  createTemplate,
  createVersion,
  getVersion,
  parseBundle,
  parseVersionBundle,
  publish,
  validateForPublish,
} from "@countersign/agents";
import { bundleHash, type InstalledPlatformTemplate } from "@countersign/core";
import { agent, agentVersion, seedVersionBundle, type Tx } from "@countersign/db";
import billClerkV1 from "@countersign/db/seed/agents/bill-clerk.v1.json";
import billClerkV2 from "@countersign/db/seed/agents/bill-clerk.v2.json";
import billClerkV3 from "@countersign/db/seed/agents/bill-clerk.v3.json";
import builderV1 from "@countersign/db/seed/agents/builder.v1.json";
import builderV2 from "@countersign/db/seed/agents/builder.v2.json";
import coordinatorV1 from "@countersign/db/seed/agents/coordinator.v1.json";
import coordinatorV2 from "@countersign/db/seed/agents/coordinator.v2.json";
import documentClerkV1 from "@countersign/db/seed/agents/document-clerk.v1.json";
import documentClerkV2 from "@countersign/db/seed/agents/document-clerk.v2.json";
import supervisorV1 from "@countersign/db/seed/agents/supervisor.v1.json";
import supervisorV2 from "@countersign/db/seed/agents/supervisor.v2.json";
import supervisorV3 from "@countersign/db/seed/agents/supervisor.v3.json";
import supervisorV4 from "@countersign/db/seed/agents/supervisor.v4.json";
import supervisorV5 from "@countersign/db/seed/agents/supervisor.v5.json";
import { and, eq, isNull } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import type { Platform } from "../platform";

/** The seed's platform template version files, by slug and version number. */
const SEEDED: Readonly<Record<string, Readonly<Record<number, unknown>>>> = {
  // Skill model (2026-11-10): the Bill clerk's v3, the Document clerk's v2 and Sloan's v5 are
  // built from AI skills, deterministic skills and write steps (docs/plan.md §1.86).
  "bill-clerk": { 1: billClerkV1, 2: billClerkV2, 3: billClerkV3 },
  builder: { 1: builderV1, 2: builderV2 },
  coordinator: { 1: coordinatorV1, 2: coordinatorV2 },
  "document-clerk": { 1: documentClerkV1, 2: documentClerkV2 },
  supervisor: {
    1: supervisorV1,
    2: supervisorV2,
    3: supervisorV3,
    4: supervisorV4,
    5: supervisorV5,
  },
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
  input: { slug: string; version: number; actorId: string; platform: Platform },
): Promise<InstalledPlatformTemplate> {
  // R9: a later version may hold v4 processes (a v3 one parses as `parseBundle` gives it).
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
    // DECISION (R9): v1 is published only when it passes publishing's checks. The Builder's and
    // the Coordinator's v1 name skills nothing registers (R2), so they never could; asked for
    // their v2, v1 stays the template's first version, a draft under it, and v2 is published.
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
