import { z } from "zod";
import { Role } from "../roles";
import { AgentBundle, AnyAgentBundle } from "./agent";
import { Slug } from "./common";
import { EventTypeSpec } from "./event";
import { SkillDefinition } from "./skill";
import { ToolSpec } from "./tool";

/** ARCHITECTURE §12.1. */
export const PackManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    requiresConnectors: z.array(z.string()).default([]),
    events: z.array(EventTypeSpec),
    tools: z.array(ToolSpec),
    skills: z.array(SkillDefinition),
    // DECISION: a pack's templates are whole agent bundles (definition + workflows), the unit
    // ARCHITECTURE v0.6 versions, rather than separate agent and workflow lists.
    // R9 (docs/plan.md §1.86, §9): `bundle` is the template's first version, as first installed
    // (never changed: invariant 3); `versions` are its later ones, v2 first, which may hold v4
    // processes. Installing adds each later version the template doesn't hold yet, by bundle hash.
    templates: z.array(
      z.object({
        slug: Slug,
        bundle: AgentBundle,
        versions: z.array(AnyAgentBundle).optional(),
      }),
    ),
    screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(Role) })),
    // §1.88 (owner, 2026-11-11): the pack's shared Library skills, operator skills (`custom:<slug>`,
    // no built-in code) the pack installs once, as shared skills (tenant_id null) with a published
    // v1, the first time it is switched on. From then on they are the operator's: edited, versioned,
    // tested and published in the Library like any skill they wrote; the pack never changes them.
    librarySkills: z.array(SkillDefinition).optional(),
    // §1.88: the pack's skills another skill replaces for new steps (skill id → its replacement's
    // id, one of the pack's skills or Library skills). Stored steps keep running the old one
    // (invariant 3); the palette and the Builder offer the replacement instead (core's
    // `newStepSkillReason`).
    superseded: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((p, ctx) => {
    const library = p.librarySkills ?? [];
    for (const [from, to] of Object.entries(p.superseded ?? {})) {
      if (!p.skills.some((s) => s.id === from)) {
        ctx.addIssue({
          code: "custom",
          message: `superseded names ${from}, which isn't one of the pack's skills`,
          path: ["superseded", from],
        });
      }
      if (!p.skills.some((s) => s.id === to) && !library.some((s) => s.id === to)) {
        ctx.addIssue({
          code: "custom",
          message: `superseded names ${to}, which isn't one of the pack's skills or Library skills`,
          path: ["superseded", from],
        });
      }
    }
    library.forEach((s, i) => {
      const slug = s.id.startsWith("custom:") ? s.id.slice("custom:".length) : "";
      if (!Slug.safeParse(slug).success || s.handler !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: `a Library skill is an operator skill (custom:<slug>, no built-in code), not ${s.id}`,
          path: ["librarySkills", i, "id"],
        });
      }
    });
    p.tools.forEach((t, i) => {
      if (t.source !== p.id) {
        ctx.addIssue({
          code: "custom",
          message: `tool ${t.id} has source ${t.source}, not ${p.id}`,
          path: ["tools", i, "source"],
        });
      }
    });
    p.events.forEach((e, i) => {
      if (!e.type.startsWith(`${p.id}.`)) {
        ctx.addIssue({
          code: "custom",
          message: `pack events are named ${p.id}.<...>`,
          path: ["events", i, "type"],
        });
      }
    });
  })
  .meta({ id: "PackManifest" });
export type PackManifest = z.infer<typeof PackManifest>;
