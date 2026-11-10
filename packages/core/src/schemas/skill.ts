import { z } from "zod";
import { BrowserSiteSlug } from "../browser/site";
import { JsonSchema, LocalizedTemplate, SkillId, ToolId } from "./common";
import { Rules } from "./rules";

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

// R2 (docs/plan.md §1.86, §9): skills think, tools act. A skill turns data in into data out by
// `rules`, `ai` or `rules_then_ai`; it may read through connectors (its declared `reads`) and never
// writes. `mode` stays: stored `skill_version` rows parse unchanged (invariant 3), and `skillMethod`
// derives the method of a definition that doesn't name one.

/** How a skill turns its input into its output. */
export const SKILL_METHODS = ["rules", "ai", "rules_then_ai"] as const;
export const SkillMethod = z.enum(SKILL_METHODS);
export type SkillMethod = z.infer<typeof SkillMethod>;

/** A page path pattern on a site: `/orders/*`, `/account/invoices`. */
export const BrowsePage = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~\-/*%]*$/, "a path from /, with * for any part, e.g. /orders/*");

/**
 * The sites and pages an `ai` skill may browse, through the client's browser connections: only
 * these, never the open web (docs/plan.md §1.86). Sites are `browser_site` slugs.
 */
export const SkillBrowse = z.strictObject({
  sites: z.array(BrowserSiteSlug).min(1).max(10),
  pages: z.array(BrowsePage).min(1).max(50),
});
export type SkillBrowse = z.infer<typeof SkillBrowse>;

/** A rule row's id: stable, so a step's customization can edit the row by id. */
export const SkillRuleId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/, "lowercase letters, digits, dashes and underscores");

/**
 * One row of a skill's rules: when the conditions hold, the output takes these values (vendor is
 * Home Depot, so the account is Materials). Rows are tried top to bottom; the first match wins.
 */
// DECISION: a rule row sets output fields to fixed values (`set`), never templates or code, so a
// customized row is data the builder can show and the client's timeline can quote.
export const SkillRule = z.strictObject({
  id: SkillRuleId,
  name: z.string().max(200).optional(),
  when: Rules,
  set: z.record(z.string().min(1), z.unknown()),
});
export type SkillRule = z.infer<typeof SkillRule>;

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
    // R2: the process model (docs/plan.md §1.86)
    /** Absent on stored rows: derived from `mode` (`skillMethod`). */
    method: SkillMethod.optional(),
    /** Read tools the skill may call through the client's connections (side effect `none`). */
    reads: z.array(ToolId).max(30).optional(),
    /** An `ai` or `rules_then_ai` skill only: the sites and pages it may browse. */
    browse: SkillBrowse.optional(),
    /** A `rules` or `rules_then_ai` skill's rule rows, tried before any model. */
    rules: z.array(SkillRule).max(500).optional(),
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
  // DECISION: until `mode` retires, a `tool`-mode skill is code and its method is `rules`; a
  // `task` or `agent` skill runs a model, so it is `ai` or `rules_then_ai`.
  .refine((s) => s.method === undefined || (s.mode === "tool") === (s.method === "rules"), {
    message: "a tool-mode skill's method is rules; a task or agent skill's is ai or rules_then_ai",
    path: ["method"],
  })
  .refine((s) => s.browse === undefined || skillMethod(s) !== "rules", {
    message: "only an ai skill may browse",
    path: ["browse"],
  })
  .refine((s) => s.rules === undefined || skillMethod(s) !== "ai", {
    message: "an ai skill has no rule rows; make it rules_then_ai",
    path: ["rules"],
  })
  .refine((s) => new Set((s.rules ?? []).map((r) => r.id)).size === (s.rules ?? []).length, {
    message: "rule ids must be unique",
    path: ["rules"],
  })
  .refine((s) => new Set(s.reads ?? []).size === (s.reads ?? []).length, {
    message: "each read tool is listed once",
    path: ["reads"],
  })
  .meta({ id: "SkillDefinition" });
export type SkillDefinition = z.infer<typeof SkillDefinition>;

/**
 * The skill's method: its own, else derived from `mode` (stored rows): `tool` is code, so `rules`;
 * `task` and `agent` run a model, so `ai`. A `tool` skill that only wraps one tool is `rules` too,
 * but it is retiring (`isToolWrapper`): a process reads or writes through the tool directly.
 */
export function skillMethod(def: {
  method?: SkillMethod | undefined;
  mode: SkillMode;
}): SkillMethod {
  return def.method ?? (def.mode === "tool" ? "rules" : "ai");
}

/**
 * A skill that is only a tool by another name: `tool` mode, a handler and no other tools. These
 * retire (docs/plan.md §9 R2): a v4 process uses the tool as a `read` or `write` step instead.
 */
export function isToolWrapper(def: Pick<SkillDefinition, "mode" | "handler" | "tools">): boolean {
  return def.mode === "tool" && def.handler !== undefined && def.tools.length === 0;
}

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
