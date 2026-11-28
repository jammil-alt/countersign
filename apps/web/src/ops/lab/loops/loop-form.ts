// The Loop designer's form (docs/step-model-plan.md §8): a Loop skill as plain fields, and back to
// the definition the server saves. A Loop reads only: its actions are the catalog's Gets, and the
// same checks the server makes (`definitionProblems`) show as it is typed.
import { type SkillDefinition, steps, type ToolSpec } from "@countersign/core";
import { toolTitle } from "../../builder/model";
import {
  clean,
  definitionProblems,
  type FieldRow,
  fieldsFromSchema,
  SLUG_RE,
  schemaFromFields,
} from "../../skills/skill-form";

export type AtLimit = "stop" | "hand_back";
export type LoopReview = "auto" | "off" | "always";

export interface LoopForm {
  slug: string;
  name: string;
  description: string;
  goal: string;
  input: FieldRow[];
  output: FieldRow[];
  /** The Get actions it may call (tool ids). */
  reads: string[];
  instructions: string;
  maxTurns: number;
  atLimit: AtLimit;
  /** A second model's focus on the result; empty: no Confer. */
  conferFocus: string;
  review: LoopReview;
}

export const DEFAULT_MAX_TURNS = 10;

export const EMPTY_LOOP: LoopForm = {
  slug: "",
  name: "",
  description: "",
  goal: "",
  input: [],
  output: [],
  reads: [],
  instructions: "",
  maxTurns: DEFAULT_MAX_TURNS,
  atLimit: "stop",
  conferFocus: "",
  review: "auto",
};

export const AT_LIMIT_LABEL: Record<AtLimit, string> = {
  stop: "Stop, and fail the step",
  hand_back: "Hand back what it has",
};

export const REVIEW_LABEL: Record<LoopReview, string> = {
  auto: "The owner decides",
  always: "Always review",
  off: "Never review",
};

/** Whether a skill is a Loop (it has a loop block: agent mode alone is retired). */
export function isLoopDefinition(def: Pick<SkillDefinition, "loop">): boolean {
  return def.loop !== undefined;
}

export function formFromLoop(def: SkillDefinition): LoopForm {
  return {
    slug: def.id.startsWith("custom:") ? def.id.slice("custom:".length) : def.id,
    name: def.name,
    description: def.description,
    goal: def.loop?.goal ?? "",
    input: fieldsFromSchema(def.input),
    output: fieldsFromSchema(def.output),
    reads: [...(def.reads ?? [])],
    instructions: def.instructions ?? "",
    maxTurns: def.loop?.maxTurns ?? DEFAULT_MAX_TURNS,
    atLimit: def.loop?.atLimit ?? "stop",
    conferFocus: def.loop?.confer?.focus ?? "",
    review: def.loop?.review ?? "auto",
  };
}

/**
 * The definition to save. Which connections it needs is read from its actions when an agent uses
 * it (their connectors), so `requiresConnectors` stays empty.
 */
export function loopDefinition(form: LoopForm): SkillDefinition {
  return clean({
    schemaVersion: 1,
    id: `custom:${form.slug.trim()}`,
    name: form.name.trim(),
    description: form.description.trim(),
    category: "data",
    mode: "agent",
    instructions: form.instructions.trim(),
    tools: [],
    reads: form.reads,
    loop: {
      goal: form.goal.trim(),
      maxTurns: form.maxTurns,
      atLimit: form.atLimit,
      ...(form.conferFocus.trim() ? { confer: { focus: form.conferFocus.trim() } } : {}),
      ...(form.review !== "auto" ? { review: form.review } : {}),
    },
    input: schemaFromFields(form.input),
    output: schemaFromFields(form.output),
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  }) as SkillDefinition;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What is missing or wrong in a form, by field, in plain words. Empty: it can be saved. */
export function validateLoop(form: LoopForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.name.trim()) errors.name = "Give it a name.";
  if (!SLUG_RE.test(form.slug)) {
    errors.slug = "Use lowercase words joined by hyphens, like find-the-match.";
  }
  if (!form.description.trim()) errors.description = "Say in one sentence what it finds out.";
  if (!form.goal.trim()) errors.goal = "Say what 'done' means for this Loop.";
  if (form.reads.length === 0) errors.reads = "Pick at least one action it may read with.";
  if (form.output.length === 0) errors.output = "Say what it hands back.";
  if (!Number.isInteger(form.maxTurns) || form.maxTurns < 1 || form.maxTurns > 50) {
    errors.maxTurns = "Between 1 and 50 turns.";
  }
  for (const side of ["input", "output"] as const) {
    const seen = new Set<string>();
    form[side].forEach((r, i) => {
      if (!KEY_RE.test(r.key))
        errors[`${side}.${i}`] = "Letters, digits and _, starting with a letter.";
      else if (seen.has(r.key)) errors[`${side}.${i}`] = "Used twice.";
      seen.add(r.key);
    });
  }
  return errors;
}

/** What the server would refuse on a save (the skill model's checks, a Loop's reads), in words. */
export function loopProblems(
  form: LoopForm,
  tools: readonly Pick<ToolSpec, "id" | "sideEffect" | "connector">[],
): string[] {
  return definitionProblems(loopDefinition(form), tools);
}

// ── The actions a Loop may pick (the action catalog's Gets) ───────────────────────────────────

export interface ReadGroup {
  key: string;
  name: string;
  type: "connector" | "area";
  actions: { id: string; label: string; description: string }[];
}

const AREA_NAMES: Record<string, string> = {
  shared: "Shared",
  purchasing: "Purchasing",
  materials: "Purchasing",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
  sales: "Sales",
};

/**
 * The offered actions of kind Get, grouped under their connector or area (the catalog's grouping,
 * `packages/core/src/steps/catalog.ts`). Nothing that changes, saves or sends is listed.
 */
export function readGroups(
  tools: readonly ToolSpec[],
  connectors: readonly { id: string; name: string }[],
): ReadGroup[] {
  const names = new Map(connectors.map((c) => [c.id, c.name]));
  const ids = new Set(names.keys());
  const groups = new Map<string, ReadGroup>();
  for (const spec of tools) {
    if (!steps.isOfferedAction(spec) || steps.actionKind(spec) !== "get") continue;
    const owner = steps.actionOwner(spec, ids);
    const key = `${owner.type}:${owner.id}`;
    const group = groups.get(key) ?? {
      key,
      type: owner.type,
      name:
        owner.type === "connector"
          ? (names.get(owner.id) ?? owner.id)
          : (AREA_NAMES[owner.id] ?? owner.id),
      actions: [],
    };
    group.actions.push({ id: spec.id, label: toolTitle(spec), description: spec.description });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, actions: g.actions.sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "connector" ? -1 : 1,
    );
}
