import { z } from "zod";
import { Role } from "../roles";
import { AgentBundle } from "./agent";
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
    templates: z.array(z.object({ slug: Slug, bundle: AgentBundle })),
    screens: z.array(z.object({ route: z.string(), title: z.string(), roles: z.array(Role) })),
  })
  .superRefine((p, ctx) => {
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
