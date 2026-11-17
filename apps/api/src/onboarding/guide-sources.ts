// Where an intake's questions come from (docs/cases-plan.md §4.2 step 2; docs/plan.md §1.126.2): core's
// general section, each covered area's section (its pack's manifest, as data, else core's generic
// one) and each covered template's client intake form, read into core's `GuideSectionSource`. Invite
// and Sign up now (stream SALES) hand these with the file's `theirs` facts to core's `buildGuide`.
// The platform never imports a pack: the packs' sections come from the registered manifests.

import { requiredConnectors } from "@countersign/agents";
import {
  areaSection,
  type Covers,
  GENERAL_SECTION,
  type GuideSectionSource,
  readFitGap,
  type TemplateCard,
  templateSection,
} from "@countersign/core";
import { agent, agentVersion, build, type Tx } from "@countersign/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Services } from "../http";

export interface GuideSources {
  general: GuideSectionSource | null;
  areas: GuideSectionSource[];
  agents: GuideSectionSource[];
}

type Platform = Services["platform"];

/** The packs' own area sections, from their manifests. */
export function packAreaSections(platform: Pick<Platform, "packs">): GuideSectionSource[] {
  return platform.packs.flatMap((p) =>
    p.manifest.intakeSection ? [p.manifest.intakeSection] : [],
  );
}

/**
 * Each template's card: what it does (its client-facing description), the tools it needs (its live
 * version's connectors, by name) and its client intake form (the latest template build's fit-gap
 * `setup`, §1.108). Only templates (no client) are read; another id is left out.
 */
export async function templateCards(
  tx: Tx,
  platform: Pick<Platform, "catalog" | "tools" | "connectors">,
  templateIds: readonly string[],
): Promise<TemplateCard[]> {
  if (templateIds.length === 0) return [];
  const rows = await tx
    .select({
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      serviceDescription: agent.serviceDescription,
      role: agent.role,
      bundle: agentVersion.bundle,
    })
    .from(agent)
    .leftJoin(agentVersion, eq(agentVersion.id, agent.liveVersionId))
    .where(
      and(inArray(agent.id, [...templateIds]), isNull(agent.tenantId), eq(agent.kind, "template")),
    );
  const forms = await tx
    .select({ agentId: build.agentId, fitgap: build.fitgap })
    .from(build)
    .where(
      and(
        inArray(build.agentId, [...templateIds]),
        isNull(build.clientId),
        eq(build.kind, "agent"),
      ),
    )
    .orderBy(desc(build.updatedAt));
  const skills = Object.fromEntries(platform.catalog.list().map((d) => [d.id, d]));
  return rows.map((r) => {
    let connectors: string[] = [];
    try {
      connectors = r.bundle ? requiredConnectors(r.bundle, skills, platform.tools) : [];
    } catch {
      // An unreadable bundle asks for no tools; the build's Connect stage finds them.
      connectors = [];
    }
    const form = forms.find((f) => f.agentId === r.id);
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      // DECISION (review, invariant 11): the card says what the template does in its client-facing
      // words (its service description, else its role), never its mission: that is part of the
      // agent's instructions, and the intake goes to the client's people.
      description: r.serviceDescription?.trim() || r.role?.trim() || "",
      connectors: connectors.map((id) => ({
        id,
        name: platform.connectors.get(id)?.manifest.name ?? id,
      })),
      form: form ? readFitGap(form.fitgap).setup : [],
    };
  });
}

/** The sections a covers asks, in covers' order. */
export async function guideSources(
  tx: Tx,
  services: Pick<Services, "platform">,
  covers: Covers,
): Promise<GuideSources> {
  const platform = services.platform;
  const packs = packAreaSections(platform);
  const cards = await templateCards(tx, platform, covers.templateIds);
  return {
    general: covers.general ? GENERAL_SECTION : null,
    areas: covers.areas.map((a) => areaSection(a, packs)),
    agents: covers.templateIds.flatMap((id) => {
      const card = cards.find((c) => c.id === id);
      return card ? [templateSection(card)] : [];
    }),
  };
}
