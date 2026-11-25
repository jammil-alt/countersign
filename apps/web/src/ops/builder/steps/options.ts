// What a Do step's form offers and how a choice changes the step (docs/step-model-plan.md §4, §5):
// pure, so the forms stay thin and the combinations the validator refuses can't be made here.
//
// - the Uses picker: connector › action, area › action, a skill, an automation, Match, Collect
//   reports, Tell, or nothing yet, and which of them each Done by allows;
// - the Input picker: "step name › field" over the steps before it, the ids kept underneath;
// - what a step hands on (its output fields) and needs (its required input).

import { type ActionCatalog, steps } from "@countersign/core";
import { stepsBefore } from "./model";
import type { DoneBy, Field, MatchProfile, Step, Uses, Workflow } from "./types";

// ── The catalog, indexed ─────────────────────────────────────────────────────────────────────────

export interface ActionEntry {
  id: string;
  /** "Create bill". */
  label: string;
  description: string;
  kind: steps.ActionKind;
  input: Field[];
  output: Field[];
  /** The connector or area it sits under: "QuickBooks Online", "Purchasing". */
  groupId: string;
  groupType: "connector" | "area";
  groupName: string;
}

export interface ActionIndex {
  groups: ActionCatalog["groups"];
  get(id: string): ActionEntry | undefined;
}

/** "QuickBooks › Create bill", as the Uses picker and the step's line say it. */
export function actionPath(a: Pick<ActionEntry, "groupName" | "label">): string {
  return `${a.groupName} › ${a.label}`;
}

export function indexCatalog(
  groups: ActionCatalog["groups"],
  label: (id: string, given: string) => string = (_id, given) => given,
): ActionIndex {
  const byId = new Map<string, ActionEntry>();
  for (const g of groups) {
    for (const a of g.actions) {
      byId.set(a.id, {
        id: a.id,
        label: label(a.id, a.label),
        description: a.description,
        kind: a.kind,
        input: a.input,
        output: a.output,
        groupId: g.id,
        groupType: g.type,
        groupName: g.name,
      });
    }
  }
  return { groups, get: (id) => byId.get(id) };
}

export interface SkillChoice {
  ref: string;
  name: string;
  description: string;
  /** Deterministic (rules) or AI: which Done by offers it. */
  kind: "rules" | "ai";
  input: Field[];
  output: Field[];
}

/**
 * A saved Loop (docs/step-model-plan.md §8): a skill with a loop block, picked in a Loop step. The
 * step takes its goal, reads, turns and checks from it; it may read fewer actions or run fewer
 * turns, never more (the runtime holds the skill's own as the ceiling).
 */
export interface LoopChoice {
  ref: string;
  name: string;
  description: string;
  goal: string;
  reads: string[];
  maxTurns: number;
  atLimit: "stop" | "hand_back";
  output: Field[];
  /** A second model's focus on the result, when the Loop sets one. */
  conferFocus?: string | undefined;
  review?: "auto" | "off" | "always" | undefined;
}

export interface AutomationChoice {
  ref: string;
  name: string;
  input: Field[];
  output: Field[];
}

/** Everything a form reads about what a step may use. */
export interface UsesContext {
  actions: ActionIndex;
  skills: readonly SkillChoice[];
  automations: readonly AutomationChoice[];
  profiles: readonly MatchProfile[];
  /** The saved Loops a Loop step may pick (absent: none). */
  loops?: readonly LoopChoice[];
}

export const NO_USES_CONTEXT: UsesContext = {
  actions: indexCatalog([]),
  skills: [],
  automations: [],
  profiles: [],
};

// ── Done by and Uses ─────────────────────────────────────────────────────────────────────────────

export const DONE_BY_CHOICES: readonly { value: DoneBy; label: string; hint: string }[] = [
  { value: "rules", label: "Rules", hint: "Code does it: the same every time." },
  { value: "ai", label: "AI", hint: "One model answer, checked against the output fields." },
  { value: "person", label: "A person", hint: "Someone approves or answers." },
  {
    value: "contact",
    label: "An outside contact",
    hint: "A back-and-forth until the goal is met.",
  },
];

export const doneByLabel = (d: DoneBy | undefined): string =>
  DONE_BY_CHOICES.find((c) => c.value === d)?.label ?? "Not chosen yet";

/** Which kinds of Uses each Done by allows, as the publish check does (§4's table). */
export const USES_FOR: Record<DoneBy, readonly Uses["type"][]> = {
  rules: ["action", "skill", "match", "tell"],
  ai: ["skill"],
  person: ["collect"],
  contact: [],
};

export interface UsesOption {
  /** A key for the list. */
  key: string;
  label: string;
  /** What it does, in a line. */
  hint?: string | undefined;
  uses: Uses;
}

export interface UsesGroup {
  heading: string;
  options: UsesOption[];
}

/**
 * What the Uses picker offers a step done by `doneBy`: connectors and areas first, each with its
 * actions ("QuickBooks › Create bill"), then skills, automations, Match, Collect reports and Tell.
 * "Nothing yet" is not an option here: it is the picker's empty state.
 */
export function usesGroups(doneBy: DoneBy | undefined, ctx: UsesContext): UsesGroup[] {
  if (!doneBy) return [];
  const allowed = USES_FOR[doneBy];
  const out: UsesGroup[] = [];
  if (allowed.includes("action")) {
    for (const g of ctx.actions.groups) {
      if (g.actions.length === 0) continue;
      out.push({
        heading: g.name,
        options: g.actions.map((a) => {
          const entry = ctx.actions.get(a.id);
          return {
            key: `action:${a.id}`,
            label: entry?.label ?? a.label,
            hint: ACTION_KIND_WORDS[a.kind],
            uses: { type: "action", action: a.id },
          };
        }),
      });
    }
  }
  if (allowed.includes("skill")) {
    const skills = ctx.skills.filter((s) => s.kind === doneBy);
    if (skills.length > 0) {
      out.push({
        heading: "Skills",
        options: skills.map((s) => ({
          key: `skill:${s.ref}`,
          label: s.name,
          hint: s.description,
          uses: { type: "skill", skill: s.ref },
        })),
      });
    }
  }
  if (doneBy === "rules" && ctx.automations.length > 0) {
    out.push({
      heading: "Automations",
      options: ctx.automations.map((a) => ({
        key: `automation:${a.ref}`,
        label: a.name,
        uses: { type: "automation", automation: a.ref },
      })),
    });
  }
  const own: UsesOption[] = [];
  if (allowed.includes("match") && ctx.profiles.length > 0) {
    const first = ctx.profiles[0];
    if (first) {
      own.push({
        key: "match",
        label: "Match",
        hint: "Find the record it is: exact, by meaning, or both.",
        uses: { type: "match", match: defaultMatch(first) },
      });
    }
  }
  if (allowed.includes("collect")) {
    own.push({
      key: "collect",
      label: "Collect reports",
      hint: "Several people each send a report; followed up.",
      uses: { type: "collect" },
    });
  }
  if (allowed.includes("tell")) {
    own.push({
      key: "tell",
      label: "Tell",
      hint: "Tell the client's team or ours, without waiting.",
      uses: { type: "tell" },
    });
  }
  if (own.length > 0) out.push({ heading: "Built in", options: own });
  return out;
}

const ACTION_KIND_WORDS: Record<steps.ActionKind, string> = {
  get: "Get: reads",
  save: "Save: to our records",
  change: "Change: in the client's tool, needs approval",
  send: "Send: a message to someone",
};

/** A Match to a profile with the settings the schema defaults: its first match type allowed. */
export function defaultMatch(profile: MatchProfile): Extract<Uses, { type: "match" }>["match"] {
  const type = profile.types.includes("hybrid") ? "hybrid" : (profile.types[0] ?? "exact");
  return steps.MatchSettings.parse({ to: profile.id, type });
}

// ── Choosing ─────────────────────────────────────────────────────────────────────────────────────

type DoStep = Extract<Step, { kind: "do" }>;

/** Which instructions a Done by and Uses carry (the validator's own rule). */
export function ownInstructions(
  doneBy: DoneBy | undefined,
  uses: Uses | undefined,
): "rules" | "ai" | "person" | "collect" | "contact" | "tell" | null {
  if (!doneBy) return null;
  if (doneBy === "person" && uses?.type === "collect") return "collect";
  if (doneBy === "rules" && uses?.type === "tell") return "tell";
  return doneBy;
}

const INSTRUCTION_KEYS = ["rules", "ai", "person", "collect", "contact", "tell"] as const;

/** A step with only the instructions its Done by and Uses carry (the others are dropped). */
export function keepOwnInstructions(step: DoStep): DoStep {
  const own = ownInstructions(step.doneBy, step.uses);
  const next: DoStep = { ...step };
  for (const key of INSTRUCTION_KEYS) if (key !== own) delete next[key];
  return next;
}

/** Choosing who does a step: its Uses stays only if the new Done by allows it. */
export function chooseDoneBy(step: DoStep, doneBy: DoneBy): DoStep {
  const keep = step.uses && USES_FOR[doneBy].includes(step.uses.type);
  const next: DoStep = { ...step, doneBy };
  if (!keep) delete next.uses;
  return keepOwnInstructions(next);
}

/**
 * Choosing what a step uses. A Change to a client's tool starts with its approver on (invariant 8),
 * and what the step carried from a Uses it no longer has (its input, its output) is dropped.
 */
export function chooseUses(step: DoStep, uses: Uses | undefined, ctx: UsesContext): DoStep {
  const next: DoStep = { ...step };
  if (uses) next.uses = uses;
  else delete next.uses;
  if (uses?.type === "action") {
    const kind = ctx.actions.get(uses.action)?.kind ?? "change";
    if (kind === "change" && !next.checks?.approval) {
      next.checks = {
        ...next.checks,
        approval: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
      };
    }
    delete next.output;
  }
  if (uses?.type === "skill" || uses?.type === "match") delete next.output;
  // What the old Uses took no longer applies; what the person typed in a field they still have stays.
  if (uses?.type !== step.uses?.type || usesKey(uses) !== usesKey(step.uses)) {
    next.input = {};
    delete next.translation;
  }
  return keepOwnInstructions(next);
}

export function usesKey(uses: Uses | undefined): string {
  if (!uses) return "none";
  switch (uses.type) {
    case "action":
      return `action:${uses.action}`;
    case "skill":
      return `skill:${uses.skill}`;
    case "automation":
      return `automation:${uses.automation}`;
    case "match":
      return `match:${uses.match.to}`;
    default:
      return uses.type;
  }
}

/** What the step's Uses is, in words, for its line and the picker's closed state. */
export function usesLabel(step: Pick<DoStep, "uses">, ctx: UsesContext): string {
  const uses = step.uses;
  if (!uses) return "Nothing yet";
  switch (uses.type) {
    case "action": {
      const a = ctx.actions.get(uses.action);
      return a ? actionPath(a) : uses.action;
    }
    case "skill":
      return ctx.skills.find((s) => s.ref === uses.skill)?.name ?? uses.skill;
    case "automation":
      return ctx.automations.find((a) => a.ref === uses.automation)?.name ?? uses.automation;
    case "match":
      return `Match › ${ctx.profiles.find((p) => p.id === uses.match.to)?.name ?? uses.match.to}`;
    case "collect":
      return "Collect reports";
    case "tell":
      return "Tell";
    case "missing":
      return "Not built yet";
  }
}

/** The kind of action a step's Uses is (for the approver's default): a Change needs one. */
export function actionKindOf(
  step: Pick<DoStep, "uses">,
  ctx: UsesContext,
): steps.ActionKind | null {
  return step.uses?.type === "action"
    ? (ctx.actions.get(step.uses.action)?.kind ?? "change")
    : null;
}

// ── What it hands on and needs ───────────────────────────────────────────────────────────────────

/** The fields a step hands on: the action's, the skill's, the Match result, or written in the step. */
export function outputFields(step: Step, ctx: UsesContext): Field[] {
  switch (step.kind) {
    case "do": {
      const uses = step.uses;
      if (uses?.type === "action") return ctx.actions.get(uses.action)?.output ?? [];
      if (uses?.type === "skill") return ctx.skills.find((s) => s.ref === uses.skill)?.output ?? [];
      if (uses?.type === "automation") {
        return ctx.automations.find((a) => a.ref === uses.automation)?.output ?? [];
      }
      if (uses?.type === "match") {
        const profile = ctx.profiles.find((p) => p.id === uses.match.to);
        return profile ? steps.matchResultFields(profile) : [];
      }
      return step.output ?? [];
    }
    case "loop":
      return step.output;
    default:
      return [];
  }
}

/** The fields a step takes in: the action's, the skill's, the profile's, or none written. */
export function inputFields(step: Step, ctx: UsesContext): Field[] {
  if (step.kind !== "do" || !step.uses) return [];
  const uses = step.uses;
  if (uses.type === "action") return ctx.actions.get(uses.action)?.input ?? [];
  if (uses.type === "skill") return ctx.skills.find((s) => s.ref === uses.skill)?.input ?? [];
  if (uses.type === "automation")
    return ctx.automations.find((a) => a.ref === uses.automation)?.input ?? [];
  if (uses.type === "match") return ctx.profiles.find((p) => p.id === uses.match.to)?.input ?? [];
  return [];
}

/** The names of the fields it requires, for the validator's "doesn't fit". */
export function requiredInput(uses: Uses, ctx: UsesContext): string[] {
  const probe = { kind: "do", id: "", name: "", input: {}, uses } as DoStep;
  return inputFields(probe, ctx)
    .filter((f) => f.required)
    .map((f) => f.name);
}

// ── The Input picker ─────────────────────────────────────────────────────────────────────────────

export interface InputOption {
  /** "Read the invoice › header › vendorName": the step's name, then the field's path. */
  label: string;
  /** What is stored: `{{steps.<id>.output.header.vendorName}}`; the id stays underneath. */
  ref: string;
  type: Field["type"];
  /** The step it comes from (absent: the trigger). */
  stepId?: string | undefined;
}

/** A field and what is in it, flattened to one option each: groups open, a list is one option. */
function flatten(
  fields: readonly Field[],
  prefix: string,
  label: string,
  out: InputOption[],
  from: string | undefined,
) {
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    const words = `${label} › ${f.name}`;
    out.push({ label: words, ref: `{{${path}}}`, type: f.type, ...(from ? { stepId: from } : {}) });
    if (f.type === "group" && f.of) flatten(f.of, path, words, out, from);
  }
}

/** The fields the trigger hands on, as a payload's JSON Schema properties (`trigger.<field>`). */
export function triggerOptions(fields: readonly Field[]): InputOption[] {
  const out: InputOption[] = [];
  flatten(fields, "trigger", "Trigger", out, undefined);
  return out;
}

/**
 * What a step's Input may pick from: the trigger's fields, then each earlier step's output, as
 * "step name › field". The step's own name stands in when it has none yet.
 */
export function inputOptions(
  workflow: Pick<Workflow, "steps">,
  stepId: string,
  ctx: UsesContext,
  trigger: readonly Field[] = [],
): InputOption[] {
  const out = triggerOptions(trigger);
  for (const before of stepsBefore(workflow, stepId)) {
    const fields = outputFields(before, ctx);
    if (fields.length === 0) continue;
    flatten(
      fields,
      `steps.${before.id}.output`,
      before.name.trim() || "An earlier step",
      out,
      before.id,
    );
  }
  return out;
}

/** The option a stored reference is, if it is one of them (the form shows its words, not the id). */
export function optionFor(
  options: readonly InputOption[],
  value: unknown,
): InputOption | undefined {
  return typeof value === "string" ? options.find((o) => o.ref === value) : undefined;
}

/**
 * The best earlier field for one of a step's own: by the same name, then by type. The Suggest
 * stub and a new step's "Use the default" both start here (the real work is wave 2).
 */
export function guessInput(field: Field, options: readonly InputOption[]): InputOption | undefined {
  const byName = options.filter(
    (o) => o.label.split(" › ").at(-1)?.toLowerCase() === field.name.toLowerCase(),
  );
  return byName.find((o) => o.type === field.type) ?? byName[0];
}
