import { z } from "zod";
import { JsonSchema, LocalizedTemplate, SkillId, ToolId } from "./common";

export const SkillSetting = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case"),
  label: z.string(),
  type: z.enum(["number", "boolean", "string", "enum"]),
  default: z.unknown(),
  options: z.array(z.string()).optional(),
  /** e.g. a vendor list: never promoted into a template. */
  clientSpecific: z.boolean().default(false),
});
export type SkillSetting = z.infer<typeof SkillSetting>;

/** ARCHITECTURE §9.2. */
export const SkillDefinition = z
  .object({
    schemaVersion: z.literal(1),
    id: SkillId,
    name: z.string(),
    description: z.string(),
    category: z.string(),
    /** 'tool' = deterministic handler; 'agent' = reasoning loop. */
    mode: z.enum(["tool", "agent"]),
    /** Tool id when mode = 'tool' (built-ins only). */
    handler: ToolId.optional(),
    /** Added to the agent's prompt when mode = 'agent'. */
    instructions: z.string().optional(),
    /** Tools the agent may use while running this skill. */
    tools: z.array(ToolId),
    input: JsonSchema,
    output: JsonSchema,
    settings: z.array(SkillSetting).default([]),
    /** Client timeline line over the skill's output (docs/plan.md §1.2 "Client run timeline"). */
    summary: LocalizedTemplate.optional(),
    requiresConnectors: z.array(z.string()).default([]),
    requiresPacks: z.array(z.string()).default([]),
    /** Outputs must carry `sources` (CLAUDE.md invariant 10). */
    producesAlerts: z.boolean().default(false),
  })
  .refine((s) => s.mode !== "tool" || s.handler !== undefined, {
    message: "a tool-mode skill needs a handler",
    path: ["handler"],
  })
  .refine((s) => s.mode !== "agent" || s.handler === undefined, {
    message: "an agent-mode skill has instructions, not a handler",
    path: ["handler"],
  })
  .refine((s) => new Set(s.settings.map((x) => x.key)).size === s.settings.length, {
    message: "setting keys must be unique",
    path: ["settings"],
  })
  .refine((s) => s.settings.every((x) => x.type !== "enum" || (x.options?.length ?? 0) > 0), {
    message: "enum settings need options",
    path: ["settings"],
  })
  .meta({ id: "SkillDefinition" });
export type SkillDefinition = z.infer<typeof SkillDefinition>;

/** Every tool a skill may call: its handler plus its listed tools. */
export function skillTools(skill: Pick<SkillDefinition, "handler" | "tools">): string[] {
  return [...new Set([...(skill.handler ? [skill.handler] : []), ...skill.tools])];
}

/** The skill's settings with defaults applied under the given overrides. */
export function resolveSkillSettings(
  skill: Pick<SkillDefinition, "settings">,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of skill.settings) out[s.key] = s.default;
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) out[k] = v;
  return out;
}
