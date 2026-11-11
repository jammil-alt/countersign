// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14 "Versions"): moving a skill step to
// another version of its skill. The server says what the move breaks (core's `skillMoveImpact`,
// through `POST /api/ops/agents/:id/skill-move`): a compatible move (only optional fields added)
// goes in one click; a breaking one lists every reference downstream to remap first. This file is
// the builder's side: the move itself, and each reference rewritten to the field it now reads.
// Pure, so the rewrite is tested without rendering. Step ids never change (invariant 3).
import { type SkillMoveView, withStepSkill } from "@countersign/core";
import { type Process, type Step, updateStep } from "./model";

export type SkillReference = SkillMoveView["references"][number];

/** A reference a picked field can fix: one to an output field (not the whole output, not input). */
export function remappable(ref: SkillReference, movedStepId: string): boolean {
  return ref.field !== "*" && ref.stepId !== movedStepId;
}

function getAt(value: unknown, path: readonly string[]): unknown {
  let at: unknown = value;
  for (const seg of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[seg];
  }
  return at;
}

function setAt(value: unknown, path: readonly string[], next: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return next;
  if (Array.isArray(value)) {
    const i = Number(head);
    return value.map((x, j) => (j === i ? setAt(x, rest, next) : x));
  }
  const obj = (value ?? {}) as Record<string, unknown>;
  return { ...obj, [head]: setAt(obj[head], rest, next) };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text with every reference to `steps.<id>.output.<field>` (and below it) reading `<to>`
 * instead; a reference to another field that only starts the same (`total` vs `totals`) is kept.
 */
export function rewriteReference(text: string, stepId: string, field: string, to: string): string {
  const from = new RegExp(
    `steps\\.${escapeRegex(stepId)}\\.output\\.${escapeRegex(field)}(?![A-Za-z0-9_])`,
    "g",
  );
  return text.replace(from, `steps.${stepId}.output.${to}`);
}

/** The process with one reference remapped to another output field of the moved step. */
export function remapReference(
  process: Process,
  movedStepId: string,
  ref: SkillReference,
  to: string,
): Process {
  if (!remappable(ref, movedStepId)) return process;
  const path = ref.at.split(".");
  return updateStep(process, ref.stepId, (step) => {
    const value = getAt(step, path);
    if (typeof value !== "string") return step;
    const next = rewriteReference(value, movedStepId, ref.field, to);
    return next === value ? step : (setAt(step, path, next) as Step);
  });
}

/** The move: the step names the new reference, and each picked reference reads its new field. */
export function applySkillMove(
  process: Process,
  stepId: string,
  toRef: string,
  remaps: ReadonlyMap<SkillReference, string>,
): Process {
  let out = withStepSkill(process, stepId, toRef);
  for (const [ref, to] of remaps) out = remapReference(out, stepId, ref, to);
  return out;
}

/** The output fields a skill version gives back, top level, for the remap pickers. */
export function outputFields(definition: unknown): string[] {
  const output = (definition as { output?: { properties?: unknown } } | null)?.output;
  const props = output?.properties;
  return props && typeof props === "object" ? Object.keys(props as object) : [];
}
