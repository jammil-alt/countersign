// R2 (docs/plan.md §1.86, §9): a skill in the Library is a template a process step customizes.
// The step may change the skill's settings, add instructions (appended, never replacing), add or
// edit rule rows, pick the model and keep only some output fields. It never changes what the skill
// is: its method, its input and output types, its core instructions, its tools or what it reads.
//
// Settings, lowest to highest: the skill's own defaults, the agent's settings for the skill (its
// `skills[].settings`), the step's own `settings`, then the step's customization. A step is the
// most specific place, so what it sets wins; `customizeSkill` returns the customization's settings
// apart so the executor layers them last (`stepSkillSettings`).

import { z } from "zod";
import type { JsonSchema } from "../schemas/common";
import { Rules } from "../schemas/rules";
import {
  ModelChoice,
  resolveSkillSettings,
  SkillDefinition,
  SkillRule,
  SkillRuleId,
  type SkillSetting,
  skillMethod,
} from "../schemas/skill";
import { parameterValueProblem, SkillCompute, SkillCondition } from "../schemas/skill-model";
import { jsonTypeOf, schemaTypes, typesCompatible } from "../template/typer";

/** A rule row the step edits, by id: the fields given replace the row's. */
export const SkillRuleEdit = z.strictObject({
  id: SkillRuleId,
  name: z.string().max(200).optional(),
  when: Rules.optional(),
  set: z.record(z.string().min(1), z.unknown()).optional(),
  // Skill model (2026-11-10): a row's typed conditions and calculations.
  conditions: z.array(SkillCondition).max(20).optional(),
  compute: z.record(z.string().min(1), SkillCompute).optional(),
});
export type SkillRuleEdit = z.infer<typeof SkillRuleEdit>;

/** What a skill step changes about its skill (strict: anything else is refused). */
export const SkillCustomization = z
  .strictObject({
    /** Setting key to value: the skill's defaults for this step. */
    settings: z.record(z.string(), z.unknown()).optional(),
    /** Appended to the skill's instructions, never replacing them. */
    addInstructions: z.string().min(1).max(4000).optional(),
    /** Rule rows: new ones go after the skill's, edits replace fields of a row by id. */
    rules: z
      .strictObject({
        add: z.array(SkillRule).max(100).optional(),
        edit: z.array(SkillRuleEdit).max(100).optional(),
      })
      .optional(),
    /** The model a task skill runs on for this step. */
    model: ModelChoice.optional(),
    /** Output fields this step keeps (top-level); absent keeps them all. */
    keep: z.array(z.string().min(1)).min(1).max(100).optional(),
    // Skill model (2026-11-10): the step's own values for the skill's parameters, over the
    // agent's (the rare step that uses a skill differently from the rest of the agent).
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: "SkillCustomization" });
export type SkillCustomization = z.infer<typeof SkillCustomization>;

/** What makes a skill what it is: a step never changes these. */
const FIXED = [
  "id",
  "schemaVersion",
  "method",
  "mode",
  "handler",
  "input",
  "output",
  "instructions",
  "tools",
  "reads",
  "browse",
  "producesAlerts",
] as const;

export class SkillCustomizationError extends Error {
  override name = "SkillCustomizationError";
  constructor(readonly problems: string[]) {
    super(`skill customization: ${problems.join("; ")}`);
  }
}

/** The top-level properties an output schema declares, or null when it declares none. */
function outputFields(output: Record<string, unknown>): string[] | null {
  const props = output.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  return Object.keys(props);
}

function settingProblem(s: SkillSetting, value: unknown): string | null {
  switch (s.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "a number";
    case "boolean":
      return typeof value === "boolean" ? null : "true or false";
    case "string":
      return typeof value === "string" ? null : "text";
    case "enum":
      return typeof value === "string" && (s.options ?? []).includes(value)
        ? null
        : `one of ${(s.options ?? []).join(", ")}`;
  }
}

/** Why a rule row can't set `key` to `value` in this output; null when it can. */
function setProblem(
  id: string,
  key: string,
  value: unknown,
  props: Record<string, unknown>,
): string | null {
  if (!Object.hasOwn(props, key)) return `rule ${id} sets ${key}, not an output field`;
  const prop = props[key] as JsonSchema;
  const accepted = schemaTypes(prop);
  const actual = jsonTypeOf(value);
  if (!typesCompatible(accepted, [actual])) {
    return `rule ${id} sets ${key} to ${actual === "integer" ? "number" : actual}, but it is ${accepted.join(" or ")}`;
  }
  if (
    Array.isArray(prop.enum) &&
    !prop.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  ) {
    return `rule ${id} sets ${key} to a value it can't take (${prop.enum.map((e) => JSON.stringify(e)).join(", ")})`;
  }
  return null;
}

interface Applied {
  definition: SkillDefinition | null;
  problems: string[];
}

function apply(def: SkillDefinition, raw: unknown): Applied {
  const problems: string[] = [];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of FIXED) {
      if (key in raw) problems.push(`a step can't change a skill's ${key}`);
    }
  }
  if (problems.length > 0) return { definition: null, problems };
  const parsed = SkillCustomization.safeParse(raw);
  if (!parsed.success) {
    return { definition: null, problems: parsed.error.issues.map((i) => i.message) };
  }
  const c = parsed.data;
  const method = skillMethod(def);
  const fields = outputFields(def.output);
  const out: SkillDefinition = { ...def };

  if (c.settings) {
    const byKey = new Map(def.settings.map((s) => [s.key, s]));
    for (const [key, value] of Object.entries(c.settings)) {
      const s = byKey.get(key);
      if (!s) {
        problems.push(`no setting ${key}`);
        continue;
      }
      const want = settingProblem(s, value);
      if (want) problems.push(`setting ${key} is ${want}`);
    }
    out.settings = def.settings.map((s) =>
      c.settings && Object.hasOwn(c.settings, s.key) ? { ...s, default: c.settings[s.key] } : s,
    );
  }

  if (c.addInstructions !== undefined) {
    if (method === "rules") problems.push("a rules skill has no instructions to add to");
    out.instructions = def.instructions
      ? `${def.instructions}\n\n${c.addInstructions}`
      : c.addInstructions;
  }

  if (c.rules) {
    if (method === "ai") problems.push("an ai skill has no rule rows");
    const rows = [...(def.rules ?? [])];
    const index = new Map(rows.map((r, i) => [r.id, i]));
    for (const e of c.rules.edit ?? []) {
      const i = index.get(e.id);
      const row = i === undefined ? undefined : rows[i];
      if (i === undefined || !row) {
        problems.push(`no rule ${e.id} to edit`);
        continue;
      }
      rows[i] = {
        ...row,
        ...(e.name !== undefined ? { name: e.name } : {}),
        ...(e.when !== undefined ? { when: e.when } : {}),
        ...(e.set !== undefined ? { set: e.set } : {}),
        ...(e.conditions !== undefined ? { conditions: e.conditions } : {}),
        ...(e.compute !== undefined ? { compute: e.compute } : {}),
      };
    }
    for (const r of c.rules.add ?? []) {
      if (index.has(r.id)) problems.push(`rule ${r.id} is already there; edit it instead`);
      else index.set(r.id, rows.push(r) - 1);
    }
    out.rules = rows;
  }

  if (c.parameters) {
    const byName = new Map((def.parameters ?? []).map((p) => [p.name, p]));
    for (const [name, value] of Object.entries(c.parameters)) {
      const param = byName.get(name);
      if (!param) {
        problems.push(`no parameter ${name}`);
        continue;
      }
      const problem = parameterValueProblem(param, value);
      if (problem) problems.push(problem);
    }
  }

  if (c.model) {
    // DECISION: the customization's model is a task skill's own model for this step. An agent
    // skill runs on the agent's model (the step's `model` overrides that); a rules skill has none.
    if (def.mode !== "task") problems.push("only a task skill's model can be picked here");
    else out.model = c.model;
  }

  if (c.keep) {
    if (!fields) problems.push("the skill's output names no fields to keep");
    else {
      for (const k of c.keep) if (!fields.includes(k)) problems.push(`no output field ${k}`);
      // DECISION: an alert skill's `sources` is always kept (invariant 10), listed or not.
      const keep = new Set([...c.keep, ...(def.producesAlerts ? ["sources"] : [])]);
      const props = def.output.properties as Record<string, unknown>;
      const required = Array.isArray(def.output.required) ? (def.output.required as unknown[]) : [];
      const kept = required.filter((r) => typeof r === "string" && keep.has(r));
      out.output = {
        ...def.output,
        properties: Object.fromEntries(Object.entries(props).filter(([k]) => keep.has(k))),
        ...(Array.isArray(def.output.required) ? { required: kept } : {}),
      };
    }
  }

  // A rule sets output fields, so a row the step adds or edits can only name fields the output
  // has after `keep` (when it says), each with a value of the field's type.
  // DECISION: the skill's own rows aren't held to `keep`: a field a step drops is dropped from
  // what the row sets too. Only the rows the step writes are its to get right.
  const props = out.output.properties;
  if (c.rules && props && typeof props === "object" && !Array.isArray(props)) {
    for (const r of [...(c.rules.add ?? []), ...(c.rules.edit ?? [])]) {
      for (const [k, v] of Object.entries(r.set ?? {})) {
        const problem = setProblem(r.id, k, v, props as Record<string, unknown>);
        if (problem) problems.push(problem);
      }
      for (const k of Object.keys(r.compute ?? {})) {
        if (!Object.hasOwn(props, k))
          problems.push(`rule ${r.id} works out ${k}, not an output field`);
      }
    }
  }

  if (problems.length > 0) return { definition: null, problems };
  // The result is a skill like any other: the same checks hold (unique rules, method and mode).
  const checked = SkillDefinition.safeParse(out);
  if (!checked.success) {
    return { definition: null, problems: checked.error.issues.map((i) => i.message) };
  }
  return { definition: checked.data, problems: [] };
}

/** Why a customization can't apply to this skill; empty when it can. */
export function customizationProblems(def: SkillDefinition, customization: unknown): string[] {
  return apply(def, customization).problems;
}

/** A skill as one step runs it, and the settings its customization sets (layered last). */
export interface CustomizedSkill {
  /**
   * The definition with the customization applied (its settings' defaults show the step's
   * values, so the builder shows them).
   */
  definition: SkillDefinition;
  /** The customization's own settings, by key: the executor layers them over every other. */
  settings: Record<string, unknown>;
  /** The customization's own parameter values, by name: layered over the agent's. */
  parameters: Record<string, unknown>;
}

/**
 * The skill as this step runs it, with the customization's settings apart. Throws
 * `SkillCustomizationError` as `applyCustomization` does.
 */
export function customizeSkill(
  def: SkillDefinition,
  customization: SkillCustomization | undefined,
): CustomizedSkill {
  return {
    definition: applyCustomization(def, customization),
    settings: { ...(customization?.settings ?? {}) },
    parameters: { ...(customization?.parameters ?? {}) },
  };
}

/**
 * The settings a skill step runs with: the skill's defaults, under the agent's settings for the
 * skill, under the step's `settings`, under the customization's (highest).
 */
export function stepSkillSettings(
  skill: Pick<SkillDefinition, "settings">,
  layers: {
    agent?: Record<string, unknown> | undefined;
    step?: Record<string, unknown> | undefined;
    customization?: Record<string, unknown> | undefined;
  },
): Record<string, unknown> {
  return resolveSkillSettings(skill, {
    ...(layers.agent ?? {}),
    ...(layers.step ?? {}),
    ...(layers.customization ?? {}),
  });
}

/**
 * The skill as this step runs it: the definition with the customization applied. Throws
 * `SkillCustomizationError` naming every problem (a fixed part changed, an unknown setting or
 * rule, a value of the wrong type).
 */
export function applyCustomization(
  def: SkillDefinition,
  customization: SkillCustomization | undefined,
): SkillDefinition {
  if (customization === undefined) return def;
  const { definition, problems } = apply(def, customization);
  if (!definition) throw new SkillCustomizationError(problems);
  return definition;
}
