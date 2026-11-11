// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"):
// two kinds of skill only. **Deterministic**: typed data in, rules (rule rows, or built-in code),
// typed data out, the same every time. **AI**: typed data in, instructions and a model, JSON out,
// checked against the skill's output schema. A skill that needs both is two skills chained.
//
// A built-in's kind is derived, never stored: stored definitions (and the hashes that pin them)
// stay as they are (invariant 3). An `ai`, `rules_then_ai`, `task` or `agent` skill is AI; a
// `tool`-mode skill is deterministic unless a tool it calls declares that it calls a model inside
// (`ToolSpec.usesModel`), the "hidden AI" that must never be labelled deterministic.

import { type SkillDefinition, skillMethod, skillTools } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";

export const SKILL_KINDS = ["deterministic", "ai"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

/** The label shown wherever a skill is: in the Library, the palette, a step, a run. */
export const SKILL_KIND_LABEL: Record<SkillKind, string> = {
  deterministic: "Deterministic",
  ai: "AI",
};

/** A tool by id, as far as the kind and the write rules need it; undefined when unknown. */
export type SkillToolLookup = (
  toolId: string,
) => Pick<ToolSpec, "usesModel" | "sideEffect"> | undefined;

/** A lookup over a map of specs (the registry's `specs()`, the builder catalog's tools). */
export function toolLookup(
  specs: Readonly<Record<string, Pick<ToolSpec, "usesModel" | "sideEffect">>> | readonly ToolSpec[],
): SkillToolLookup {
  if (Array.isArray(specs)) {
    const byId = new Map((specs as readonly ToolSpec[]).map((t) => [t.id, t]));
    return (id) => byId.get(id);
  }
  const map = specs as Readonly<Record<string, Pick<ToolSpec, "usesModel" | "sideEffect">>>;
  return (id) => (Object.hasOwn(map, id) ? map[id] : undefined);
}

type KindFields = Pick<SkillDefinition, "mode" | "method" | "handler" | "tools" | "reads">;

/** The tools a skill calls that call a model inside them (their `usesModel`). */
export function modelTools(def: KindFields, tools?: SkillToolLookup): string[] {
  if (!tools) return [];
  return [...skillTools(def), ...(def.reads ?? [])].filter(
    (id) => tools(id)?.usesModel !== undefined,
  );
}

/**
 * Deterministic or AI. Without `tools`, a code skill reads as deterministic: pass the registry's
 * specs wherever the label is shown, so a code skill whose tool calls a model reads as AI.
 */
export function skillKind(def: KindFields, tools?: SkillToolLookup): SkillKind {
  if (def.mode !== "tool" || skillMethod(def) !== "rules") return "ai";
  return modelTools(def, tools).length > 0 ? "ai" : "deterministic";
}

/** The label of the skill's kind. */
export function skillKindLabel(def: KindFields, tools?: SkillToolLookup): string {
  return SKILL_KIND_LABEL[skillKind(def, tools)];
}

// ── What retires for new use ─────────────────────────────────────────────────────────────────

/**
 * Why a skill can't be used in a new skill version or a new step, in plain words; null when it
 * can. `rules_then_ai` becomes two skills chained; an agent-mode skill (the agent's reasoning loop
 * with tools that may propose writes) becomes an AI skill followed by write steps. Stored versions
 * and the steps already using them keep running (invariant 3).
 */
export function retiredSkillReason(def: Pick<SkillDefinition, "mode" | "method">): string | null {
  if (def.method === "rules_then_ai") {
    return "Rules then AI is retired: make two skills, a deterministic one and an AI one, and chain them (the deterministic checks after the AI one veto it).";
  }
  if (def.mode === "agent") {
    return "Skills that run the agent's own reasoning are retired: use an AI skill, then a write step for each change.";
  }
  return null;
}

/**
 * The tools a skill calls or reads that change something (`sideEffect` other than "none"). Skills
 * never write ("skills think, tools act"): a skill with any is not offered for a new step.
 */
export function skillWriteTools(
  def: Pick<SkillDefinition, "handler" | "tools" | "reads">,
  tools?: SkillToolLookup,
): string[] {
  if (!tools) return [];
  return [...new Set([...skillTools(def), ...(def.reads ?? [])])].filter((id) => {
    const t = tools(id);
    return t !== undefined && t.sideEffect !== "none";
  });
}

/**
 * Whether a skill calls or reads a tool that writes (`skillWriteTools`), our own records included.
 * (Not v3's `skillWrites`, which lists only the external tools a skill reference may call.)
 */
export function skillIsWriter(
  def: Pick<SkillDefinition, "handler" | "tools" | "reads">,
  tools?: SkillToolLookup,
): boolean {
  return skillWriteTools(def, tools).length > 0;
}

/**
 * Why a skill isn't offered for a new step, in plain words; null when it is: a retired kind
 * (`retiredSkillReason`), or a skill that writes (`skillIsWriter`). A tool wrapper is not covered
 * here (`isToolWrapper`): its tool is offered as a step instead.
 */
export function newStepSkillReason(
  def: Pick<SkillDefinition, "mode" | "method" | "handler" | "tools" | "reads">,
  tools?: SkillToolLookup,
): string | null {
  const retired = retiredSkillReason(def);
  if (retired) return retired;
  const writes = skillWriteTools(def, tools);
  if (writes.length > 0) {
    return `Skills never write: this one changes something through "${writes[0]}". Use the skill that only reads, then a write step.`;
  }
  return null;
}

/**
 * What a new skill version breaks of the skill model, in plain words (empty: none). Checked when
 * a version is saved, never on a stored one. `tools` checks that a skill never writes.
 */
export function newSkillVersionProblems(
  def: Pick<
    SkillDefinition,
    "mode" | "method" | "handler" | "tools" | "reads" | "rules" | "model" | "parameters"
  >,
  tools?: SkillToolLookup,
): string[] {
  const problems: string[] = [];
  const retired = retiredSkillReason(def);
  if (retired) problems.push(retired);
  if (def.mode === "tool" && def.handler !== undefined && (def.rules?.length ?? 0) > 0) {
    problems.push("A deterministic skill runs its rule rows or its built-in code, not both.");
  }
  if (tools) {
    for (const id of [...skillTools(def), ...(def.reads ?? [])]) {
      const t = tools(id);
      if (t && t.sideEffect !== "none") {
        problems.push(
          `A skill never writes: "${id}" changes something. Put a write step after the skill instead.`,
        );
      }
    }
  }
  return problems;
}
