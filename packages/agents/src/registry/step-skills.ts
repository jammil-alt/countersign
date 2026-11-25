// Rules and AI written in a step, stored behind it as a skill (docs/step-model-plan.md §5, §10).
// A Do step done by Rules with no Uses holds its rule rows and values in the step; one done by AI
// holds its instructions and output fields. When the step is saved they are written to the
// client's skill storage (`skill_version`, as every operator skill is), so the step runs as any
// skill step does. "Save as skill" gives the same text a name, a description and a scope, in the
// library and the Uses picker, and the step then uses it.
//
// DECISION: the stored format is frozen, so a step carries no link to its backing skill. The link
// is the id: `custom:step-<step id>` (`stepSkillRef`), made by code, in the agent's own scope (the
// client's, or shared for a template). Its category is `IN_A_STEP`, which the library and the Uses
// picker leave out: it isn't a skill a person picks, it is the step's own text, stored.
// Skills never write (invariant 8): both shapes read only, and `parseOperatorSkill` refuses the rest.

import type { SkillDefinition, SkillParameter, steps } from "@countersign/core";
import { skill, skillVersion, type Tx } from "@countersign/db";
import { DEFAULT_MODELS } from "@countersign/llm";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AgentsError } from "../errors";
import { CUSTOM_PREFIX, createSkill, createSkillVersion, customSlug, publishSkill } from "./skills";
import type { ToolRegistry } from "./tools";

/** The category of a skill that only backs a step: never listed, never picked. */
export const IN_A_STEP = "in-a-step";

/** Whether a skill is only a step's own stored text. */
export function isStepSkill(def: Pick<SkillDefinition, "category">): boolean {
  return def.category === IN_A_STEP;
}

/** The slug of the skill behind a step: its id, made a slug (ids hold `_` and capitals). */
export function stepSkillSlug(stepId: string): string {
  let out = "";
  let dash = false;
  for (const ch of stepId.toLowerCase()) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (ok) {
      out += ch;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += "-";
      dash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return `step-${out || "x"}`.slice(0, 80);
}

export const stepSkillRef = (stepId: string): string => `${CUSTOM_PREFIX}${stepSkillSlug(stepId)}`;

type DoStep = steps.DoStep;

/** What a step written in itself is: the rows (rules) or the text (AI); null when it is neither. */
export function writtenInStep(step: steps.Step): "rules" | "ai" | null {
  if (step.kind !== "do" || step.uses !== undefined) return null;
  if (step.doneBy === "rules" && (step.rules?.rows?.length ?? 0) > 0) return "rules";
  if (step.doneBy === "ai" && (step.ai?.text ?? "").trim() !== "") return "ai";
  return null;
}

const TYPE_OF: Record<steps.Field["type"], string> = {
  text: "string",
  number: "number",
  money: "object",
  date: "string",
  yes_no: "boolean",
  list: "array",
  group: "object",
  record: "string",
};

/** Fields as a JSON Schema (the other way from `steps.fieldsFromSchema`). */
export function fieldsToSchema(fields: readonly steps.Field[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    const p: Record<string, unknown> = { type: TYPE_OF[f.type] };
    if (f.about) p.description = f.about;
    if (f.type === "date") p.format = "date";
    if (f.type === "money") {
      p.properties = { amount: { type: "string" }, currency: { type: "string" } };
    }
    if (f.type === "group") Object.assign(p, fieldsToSchema(f.of ?? []));
    if (f.type === "list") {
      p.items = (f.of ?? []).length > 0 ? fieldsToSchema(f.of ?? []) : {};
    }
    properties[f.name] = p;
  }
  return {
    type: "object",
    properties,
    required: fields.filter((f) => f.required).map((f) => f.name),
    additionalProperties: true,
  };
}

/** The step's own input names as the skill's input: each a value of any type, as hand-made. */
function inputSchema(step: DoStep): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const name of Object.keys(step.input ?? {})) properties[name] = {};
  return { type: "object", properties, additionalProperties: true };
}

/** Rules' values as the skill's parameters, each with its value as the default (scalars only). */
function valuesAsParameters(values: Record<string, unknown> | undefined): SkillParameter[] {
  const out: SkillParameter[] = [];
  for (const [name, value] of Object.entries(values ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) continue;
    const type =
      typeof value === "number"
        ? "number"
        : typeof value === "boolean"
          ? "boolean"
          : typeof value === "string"
            ? "text"
            : null;
    if (type) out.push({ name, label: name, type, default: value });
  }
  return out;
}

export interface StepSkillText {
  /** The skill's id, `custom:<slug>`. */
  id: string;
  name: string;
  description: string;
  category: string;
}

/**
 * The skill a written-in-step Do is: Rules is rule rows (deterministic, no code); AI is one task on
 * a model, its answer checked against the output fields. Null when the step writes neither.
 */
export function stepSkillDefinition(step: steps.Step, text: StepSkillText): unknown | null {
  const written = writtenInStep(step);
  if (written === null || step.kind !== "do") return null;
  const common = {
    schemaVersion: 1,
    ...text,
    tools: [],
    input: inputSchema(step),
    output: fieldsToSchema(step.output ?? []),
  };
  if (written === "rules") {
    const parameters = valuesAsParameters(step.rules?.values);
    return {
      ...common,
      mode: "tool",
      method: "rules",
      rules: step.rules?.rows,
      ...(parameters.length > 0 ? { parameters } : {}),
    };
  }
  return {
    ...common,
    mode: "task",
    method: "ai",
    model: step.ai?.model ?? { id: DEFAULT_MODELS.classification },
    instructions: step.ai?.text,
  };
}

/** What a step's stored skill is called: the goal, else a plain word for what it is. */
function stepName(step: DoStep): string {
  return step.name.trim() || (step.doneBy === "ai" ? "AI step" : "Rules step");
}

async function skillIn(tx: Tx, tenantId: string | null, slug: string) {
  const [row] = await tx
    .select()
    .from(skill)
    .where(
      and(
        eq(skill.slug, slug),
        tenantId === null ? isNull(skill.tenantId) : eq(skill.tenantId, tenantId),
      ),
    );
  return row;
}

export interface StoredStepSkill {
  stepId: string;
  ref: string;
  /** The skill's version now live behind the step. */
  version: number;
  /** False when what the step wrote is what was already stored. */
  changed: boolean;
}

export interface StoreStepSkillsInput {
  /** The agent's client; null for a template (its step skills are shared). */
  tenantId: string | null;
  workflow: steps.Workflow;
  authorId: string | null;
  tools?: ToolRegistry;
}

/**
 * Stores the rules and the AI written in a workflow's steps behind them: one skill per such step,
 * a new version (made live) when the text changed, nothing when it didn't. A step that no longer
 * writes anything keeps its skill's history (versions are never deleted, invariant 3); nothing
 * reads it any more.
 */
export async function storeStepSkills(
  tx: Tx,
  input: StoreStepSkillsInput,
): Promise<StoredStepSkill[]> {
  const out: StoredStepSkill[] = [];
  for (const step of allSteps(input.workflow.steps)) {
    if (writtenInStep(step) === null || step.kind !== "do") continue;
    out.push(await storeOne(tx, input, step));
  }
  return out;
}

async function storeOne(
  tx: Tx,
  input: StoreStepSkillsInput,
  step: DoStep,
): Promise<StoredStepSkill> {
  const slug = stepSkillSlug(step.id);
  const ref = `${CUSTOM_PREFIX}${slug}`;
  const definition = stepSkillDefinition(step, {
    id: ref,
    name: stepName(step),
    description: step.purpose?.trim() || stepName(step),
    category: IN_A_STEP,
  });
  const row = await skillIn(tx, input.tenantId, slug);
  const tools = input.tools ? { tools: input.tools } : {};
  if (!row) {
    const created = await createSkill(tx, {
      tenantId: input.tenantId,
      definition,
      authorId: input.authorId,
      changeNote: "Written in a step",
      ...tools,
    });
    await publishSkill(tx, { skillId: created.skill.id, versionId: created.version.id });
    return { stepId: step.id, ref, version: created.version.version, changed: true };
  }
  const [latest] = await tx
    .select()
    .from(skillVersion)
    .where(eq(skillVersion.skillId, row.id))
    .orderBy(desc(skillVersion.version))
    .limit(1);
  try {
    const v = await createSkillVersion(tx, {
      skillId: row.id,
      definition,
      parentVersionId: latest?.id ?? null,
      authorId: input.authorId,
      changeNote: "Edited in a step",
      ...tools,
    });
    await publishSkill(tx, { skillId: row.id, versionId: v.id });
    return { stepId: step.id, ref, version: v.version, changed: true };
  } catch (error) {
    if (error instanceof AgentsError && error.code === "no_op") {
      // What the step wrote is what is stored; make sure it is the live one.
      if (latest && row.liveVersionId !== latest.id) {
        await publishSkill(tx, { skillId: row.id, versionId: latest.id });
      }
      return { stepId: step.id, ref, version: latest?.version ?? 1, changed: false };
    }
    throw error;
  }
}

export interface SaveAsSkillInput {
  /** Null: shared by every client (the agent is a template, or the person chose shared). */
  tenantId: string | null;
  step: steps.Step;
  name: string;
  description: string;
  authorId: string | null;
  tools?: ToolRegistry;
}

export interface SavedAsSkill {
  ref: string;
  slug: string;
  /** The step as it is now: it uses the skill, and what it wrote is in the skill. */
  step: DoStep;
}

/** Why a step can't be saved as a skill, in plain words; null when it can. */
export function saveAsSkillRefusal(step: steps.Step): string | null {
  if (step.kind === "loop") {
    return "A Loop is saved as a skill from the Loop designer, which isn't built yet.";
  }
  if (step.kind !== "do") return "Only a Do step can be saved as a skill.";
  if (step.uses !== undefined) {
    return "This step already uses something. Save as skill is for rules or AI written in the step.";
  }
  if (step.doneBy !== "rules" && step.doneBy !== "ai") {
    return "Only a step done by rules or by AI can be saved as a skill.";
  }
  if (writtenInStep(step) === null) {
    return step.doneBy === "rules"
      ? "Add at least one rule before saving it as a skill."
      : "Write what the AI does before saving it as a skill.";
  }
  return null;
}

/**
 * Save as skill: the step's rules or instructions become a named skill in the library, this
 * client's or shared, and the step switches to using it. A shared skill reaches a client's agent
 * with its next publish, as every shared skill does (invariant 11).
 */
export async function saveStepAsSkill(tx: Tx, input: SaveAsSkillInput): Promise<SavedAsSkill> {
  const refusal = saveAsSkillRefusal(input.step);
  if (refusal !== null || input.step.kind !== "do") {
    throw new AgentsError(
      "invalid_definition",
      refusal ?? "Only a Do step can be saved as a skill.",
    );
  }
  const step = input.step;
  const taken = new Set(
    (
      await tx
        .select({ slug: skill.slug })
        .from(skill)
        .where(
          input.tenantId === null ? isNull(skill.tenantId) : eq(skill.tenantId, input.tenantId),
        )
    ).map((r) => r.slug),
  );
  const root = nameSlug(input.name) || "skill";
  let slug = root;
  for (let n = 2; taken.has(slug); n += 1) slug = `${root}-${n}`;
  const ref = `${CUSTOM_PREFIX}${slug}`;
  const definition = stepSkillDefinition(step, {
    id: ref,
    name: input.name.trim(),
    description: input.description.trim(),
    category: "Saved from a step",
  });
  const created = await createSkill(tx, {
    tenantId: input.tenantId,
    definition,
    authorId: input.authorId,
    changeNote: "Saved from a step",
    ...(input.tools ? { tools: input.tools } : {}),
  });
  await publishSkill(tx, { skillId: created.skill.id, versionId: created.version.id });
  // What was written now lives in the skill: the step uses it, and it takes its fields from it.
  const { rules: _r, ai: _a, output: _o, ...rest } = step;
  return { ref, slug: customSlug(ref), step: { ...rest, uses: { type: "skill", skill: ref } } };
}

function nameSlug(text: string): string {
  let out = "";
  let dash = false;
  for (const ch of text.toLowerCase().slice(0, 200)) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (ok) {
      out += ch;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += "-";
      dash = true;
    }
  }
  let end = Math.min(out.length, 60);
  while (end > 0 && out[end - 1] === "-") end--;
  return out.slice(0, end);
}

/** Every step of a workflow, containers' steps included. */
export function allSteps(list: readonly steps.Step[]): steps.Step[] {
  const out: steps.Step[] = [];
  for (const s of list) {
    out.push(s);
    if (s.kind === "fork") {
      for (const p of s.paths) out.push(...allSteps(p.steps));
      out.push(...allSteps(s.otherwise.steps));
    } else if (s.kind === "for_each" || s.kind === "repeat") out.push(...allSteps(s.steps));
  }
  return out;
}
