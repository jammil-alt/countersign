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

// v0.13 W2-H: task skills and a model per step (ARCHITECTURE §9.2, §10.11; docs/plan.md §1.53).
/**
 * A model by id, the same shape as the agent's `model`: a `task` skill's own default, or a skill
 * step's override. `maxTokens` falls back along the same order (step, skill, agent).
 */
// DECISION: a model id, not named tiers (Fast, Standard, Strong are the builder's labels), so
// skills, steps and agents name models the same way (docs/plan.md §1.53).
export const ModelChoice = z
  .object({
    id: z.string().min(1),
    maxTokens: z.number().int().positive().optional(),
  })
  .meta({ id: "ModelChoice" });
export type ModelChoice = z.infer<typeof ModelChoice>;

/** The skill modes (v0.13): code, a typed job on its own model, or the agent's own reasoning. */
export const SKILL_MODES = ["tool", "task", "agent"] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

/** ARCHITECTURE §9.2. */
export const SkillDefinition = z
  .object({
    schemaVersion: z.literal(1),
    id: SkillId,
    name: z.string(),
    description: z.string(),
    category: z.string(),
    /**
     * 'tool' = deterministic handler; 'task' = a typed job on the skill's own `model`, with no
     * agent instructions or memory, the same in any agent; 'agent' = the agent's reasoning loop,
     * on its model with its instructions and memory (v0.13).
     */
    mode: z.enum(SKILL_MODES),
    /** v0.13: required for `task` (the skill's default model); not allowed on `tool` or `agent`. */
    model: ModelChoice.optional(),
    /** Tool id when mode = 'tool' (built-ins only). */
    handler: ToolId.optional(),
    /** The task's instructions when mode = 'task' or 'agent' (with the agent's own for 'agent'). */
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
    /**
     * Built-ins only: input fields that become instructions (e.g. a reach-out's purpose), so a step
     * must write them itself, never from a template or a model (docs/plan.md §1.23, §1.25).
     */
    fixedInputs: z.array(z.string().min(1)).optional(),
    /**
     * Built-ins only: the skill contacts people through the agent's bound channels (each send an
     * external action), so its step has an approval setting like a write.
     */
    reachesPeople: z.boolean().optional(),
    // P-4: conversations (docs/plan.md §1.66)
    /**
     * Built-ins only: the output's `result` is typed by this input field, a JSON Schema the step
     * writes (`comms.converse`'s `result`), so later steps read the answer typed.
     */
    resultFromInput: z.string().min(1).optional(),
  })
  .refine((s) => s.mode !== "tool" || s.handler !== undefined, {
    message: "a tool-mode skill needs a handler",
    path: ["handler"],
  })
  .refine((s) => s.mode === "tool" || s.handler === undefined, {
    message: "a task- or agent-mode skill has instructions, not a handler",
    path: ["handler"],
  })
  .refine((s) => s.mode !== "task" || s.model !== undefined, {
    message: "a task-mode skill names the model it runs on",
    path: ["model"],
  })
  .refine((s) => s.mode === "task" || s.model === undefined, {
    message: "only a task-mode skill names a model (an agent-mode skill runs on the agent's)",
    path: ["model"],
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
