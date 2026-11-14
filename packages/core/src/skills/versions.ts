// The skill model (owner, 2026-11-10): skill versions are immutable and a step pins one (or follows
// the live one when the agent is published, as before). Moving a step from v1 to v2: a compatible
// change (only optional input fields, output fields or parameters with defaults added) moves in one
// click; a breaking one (a field removed or renamed, a type changed, a parameter removed) lists
// every reference downstream to remap before the step is saved, typed by the same validator.

import { isPlainObject } from "../json";
import type { Process, Step } from "../process/schema";
import {
  type ProcessValidationContext,
  type ProcessValidationError,
  validateProcess,
} from "../process/validate";
import { allSteps } from "../process/walk";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import { collectRefs } from "../template/template";
import { lookupSkill, schemaTypes, typesCompatible } from "../template/typer";

/** What kind of break a change is. */
export type SkillBreakKind =
  /** A field is gone (`renamedTo` when one field of the same type took its place). */
  | "removed"
  /** A field's type changed in a way its readers (or writers) can't take. */
  | "type_changed"
  /** An output field that was always there may now be missing. */
  | "now_optional"
  /** A new input field the step must now fill. */
  | "required_added"
  | "parameter_removed"
  | "parameter_type_changed"
  /** A new parameter with no default: every agent using the skill must set it. */
  | "parameter_required_added";

export interface SkillBreak {
  kind: SkillBreakKind;
  side: "input" | "output" | "parameter";
  /** Dotted, `*` for a list's items (`lines.*.amount`); a parameter's name. */
  field: string;
  /** For `removed`: the one same-typed field added beside it, a likely rename. */
  renamedTo?: string;
  message: string;
}

export interface SkillVersionChange {
  /** True when nothing breaks: the step moves in one click. */
  compatible: boolean;
  breaks: SkillBreak[];
}

function props(schema: JsonSchema | undefined): Record<string, JsonSchema> | null {
  const p = schema?.properties;
  return isPlainObject(p) ? (p as Record<string, JsonSchema>) : null;
}

function required(schema: JsonSchema | undefined): Set<string> {
  const r = schema?.required;
  return new Set(Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []);
}

function items(schema: JsonSchema | undefined): JsonSchema | undefined {
  const i = schema?.items;
  return isPlainObject(i) ? (i as JsonSchema) : undefined;
}

const join = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

/**
 * Output: what readers downstream rely on (every field, its type, that a required one is there).
 * Input: what the step gives (every field it may pass, and every field the new version requires).
 */
function compareSchemas(
  side: "input" | "output",
  from: JsonSchema | undefined,
  to: JsonSchema | undefined,
  prefix: string,
  out: SkillBreak[],
) {
  const fromTypes = schemaTypes(from);
  const toTypes = schemaTypes(to);
  if (prefix) {
    // Output: every type it may now give, readers took before. Input: every type the step gave,
    // the new version takes.
    const ok =
      side === "output"
        ? toTypes.every((t) => typesCompatible(fromTypes, [t]))
        : fromTypes.every((t) => typesCompatible(toTypes, [t]));
    if (!ok) {
      out.push({
        kind: "type_changed",
        side,
        field: prefix,
        message: `${side} ${prefix} was ${fromTypes.join(" or ") || "any"}, now ${toTypes.join(" or ") || "any"}`,
      });
      return;
    }
  }
  const fp = props(from);
  const tp = props(to);
  if (fp && tp) {
    const fr = required(from);
    const tr = required(to);
    const removed = Object.keys(fp).filter((k) => !Object.hasOwn(tp, k));
    const added = Object.keys(tp).filter((k) => !Object.hasOwn(fp, k));
    for (const k of removed) {
      const same = added.filter((a) => schemaTypes(tp[a]).join() === schemaTypes(fp[k]).join());
      const b: SkillBreak = {
        kind: "removed",
        side,
        field: join(prefix, k),
        message: `${side} ${join(prefix, k)} is gone`,
      };
      if (removed.length === 1 && same.length === 1) {
        b.renamedTo = join(prefix, same[0] as string);
        b.message = `${side} ${join(prefix, k)} is gone; ${b.renamedTo} is new, perhaps the same field renamed`;
      }
      out.push(b);
    }
    if (side === "input") {
      for (const k of added) {
        if (tr.has(k)) {
          out.push({
            kind: "required_added",
            side,
            field: join(prefix, k),
            message: `input ${join(prefix, k)} is new and required: the step must fill it`,
          });
        }
      }
    }
    for (const k of Object.keys(fp)) {
      if (!Object.hasOwn(tp, k)) continue;
      if (side === "output" && fr.has(k) && !tr.has(k)) {
        out.push({
          kind: "now_optional",
          side,
          field: join(prefix, k),
          message: `output ${join(prefix, k)} may now be missing`,
        });
      }
      if (side === "input" && !fr.has(k) && tr.has(k)) {
        out.push({
          kind: "required_added",
          side,
          field: join(prefix, k),
          message: `input ${join(prefix, k)} is now required: the step must fill it`,
        });
      }
      compareSchemas(side, fp[k], tp[k], join(prefix, k), out);
    }
    return;
  }
  const fi = items(from);
  const ti = items(to);
  if (fi && ti) compareSchemas(side, fi, ti, join(prefix, "*"), out);
}

/**
 * What moving from one version of a skill to another breaks. Compatible: only optional input
 * fields, output fields, or parameters with a default added (or nothing changed).
 */
export function skillVersionChange(
  from: Pick<SkillDefinition, "input" | "output" | "parameters">,
  to: Pick<SkillDefinition, "input" | "output" | "parameters">,
): SkillVersionChange {
  const breaks: SkillBreak[] = [];
  compareSchemas("output", from.output, to.output, "", breaks);
  compareSchemas("input", from.input, to.input, "", breaks);
  const before = new Map((from.parameters ?? []).map((p) => [p.name, p]));
  const after = new Map((to.parameters ?? []).map((p) => [p.name, p]));
  for (const [name, p] of before) {
    const now = after.get(name);
    if (!now) {
      breaks.push({
        kind: "parameter_removed",
        side: "parameter",
        field: name,
        message: `parameter ${name} (${p.label}) is gone: agents that set it lose it`,
      });
    } else if (now.type !== p.type) {
      breaks.push({
        kind: "parameter_type_changed",
        side: "parameter",
        field: name,
        message: `parameter ${name} was ${p.type}, now ${now.type}: set it again`,
      });
    }
  }
  for (const [name, p] of after) {
    if (!before.has(name) && p.default === undefined) {
      breaks.push({
        kind: "parameter_required_added",
        side: "parameter",
        field: name,
        message: `parameter ${name} (${p.label}) is new and has no default: set it for the agent`,
      });
    }
  }
  return { compatible: breaks.length === 0, breaks };
}

// ── References downstream ────────────────────────────────────────────────────────────────────

/** A place in a process that reads a step's output (or, for the step itself, fills its input). */
export interface SkillStepReference {
  /** The step (or `if` path) whose config holds the reference. */
  stepId: string;
  /** Dotted location inside that step, as the validator names fields (`input.total`). */
  at: string;
  /** The reference as written, `steps.match.output.lines`. */
  expr: string;
  /** The break it is hit by: its field (or `*` for a reference to the whole output). */
  field: string;
}

/** A step's own config, without the steps nested in it (they are visited on their own). */
function ownConfig(step: Step): unknown {
  if (step.kind === "if") {
    const { paths, otherwise: _o, ...rest } = step;
    return { ...rest, paths: paths.map(({ steps: _s, ...p }) => p) };
  }
  if (step.kind === "for_each" || step.kind === "repeat") {
    const { steps: _s, ...rest } = step;
    return rest;
  }
  return step;
}

const segMatch = (want: string, got: string) => want === got || (want === "*" && /^\d+$/.test(got));

/**
 * Whether a reference's path (after `output`) meets a broken field: one is under the other (a
 * reference to the list a broken item field is in reads it too). `*` matches a list index.
 */
function under(path: readonly string[], field: string): boolean {
  const segs = field.split(".");
  const n = Math.min(path.length, segs.length);
  for (let i = 0; i < n; i += 1) if (!segMatch(segs[i] as string, path[i] as string)) return false;
  return true;
}

/**
 * Every reference in the process to the step's output that an output break hits (a reference to
 * a field under the broken one, to a field above it, or to the whole output), and the step's own
 * input for an input break.
 */
export function skillStepReferences(
  process: Pick<Process, "steps">,
  stepId: string,
  breaks: readonly SkillBreak[],
): SkillStepReference[] {
  const out: SkillStepReference[] = [];
  const outputBreaks = breaks.filter((b) => b.side === "output");
  for (const loc of allSteps(process)) {
    const { refs } = collectRefs(ownConfig(loc.step), []);
    for (const ref of refs) {
      const [head, id, part, ...rest] = ref.path;
      if (head !== "steps" || id !== stepId) continue;
      if (part !== undefined && part !== "output") continue;
      const at = ref.at.join(".");
      if (part === undefined || rest.length === 0) {
        if (outputBreaks.length > 0)
          out.push({ stepId: loc.step.id, at, expr: ref.expr, field: "*" });
        continue;
      }
      for (const b of outputBreaks) {
        if (under(rest, b.field)) {
          out.push({ stepId: loc.step.id, at, expr: ref.expr, field: b.field });
          break;
        }
      }
    }
  }
  for (const b of breaks) {
    if (b.side !== "input") continue;
    const top = b.field.split(".")[0] as string;
    out.push({ stepId, at: `input.${top}`, expr: `input.${top}`, field: b.field });
  }
  return out;
}

/** What happens to a process if one of its skill steps moves to another version of its skill. */
export interface SkillMoveImpact extends SkillVersionChange {
  /** The step's skill reference now, and the one it would move to. */
  from: string;
  to: string;
  /** Every place to remap before the move is saved. */
  references: SkillStepReference[];
  /** Validation errors the move would add (the same validator the builder and publish use). */
  errors: ProcessValidationError[];
}

const errorKey = (e: ProcessValidationError) => `${e.stepId}|${e.field}|${e.code}|${e.message}`;

/**
 * The impact of moving `stepId` (a skill step) to `toRef`, whose definition is `toDef`. Null when
 * the step isn't a skill step of the process. `ctx` types the rest of the process as the
 * validator does; the step's current skill is looked up in it.
 */
export function skillMoveImpact(
  process: Process,
  stepId: string,
  toRef: string,
  toDef: SkillDefinition,
  ctx: ProcessValidationContext = {},
): SkillMoveImpact | null {
  const step = allSteps(process).find((l) => l.step.id === stepId)?.step;
  if (step?.kind !== "skill") return null;
  const fromRef = step.skill;
  const fromDef = lookupSkill(fromRef, ctx);
  const change = fromDef
    ? skillVersionChange(fromDef, toDef)
    : { compatible: false, breaks: [] as SkillBreak[] };
  const moved = withStepSkill(process, stepId, toRef);
  const withTo: ProcessValidationContext = { ...ctx, skills: { ...ctx.skills, [toRef]: toDef } };
  // The agent's own skill list names the skill by id: a pinned move stays allowed.
  const before = new Set(validateProcess(process, ctx).errors.map(errorKey));
  const errors = validateProcess(moved, withTo).errors.filter((e) => !before.has(errorKey(e)));
  const compatible = change.compatible && errors.length === 0 && fromDef !== undefined;
  return {
    from: fromRef,
    to: toRef,
    compatible,
    breaks: change.breaks,
    references: skillStepReferences(process, stepId, change.breaks),
    errors,
  };
}

/** The process with one skill step naming another reference (a copy; ids unchanged). */
export function withStepSkill(process: Process, stepId: string, toRef: string): Process {
  const swap = (steps: Step[]): Step[] =>
    steps.map((s) => {
      if (s.id === stepId && s.kind === "skill") return { ...s, skill: toRef };
      if (s.kind === "if") {
        return {
          ...s,
          paths: s.paths.map((p) => ({ ...p, steps: swap(p.steps) })),
          otherwise: { ...s.otherwise, steps: swap(s.otherwise.steps) },
        };
      }
      if (s.kind === "for_each" || s.kind === "repeat") return { ...s, steps: swap(s.steps) };
      return s;
    });
  return { ...process, steps: swap(process.steps) };
}

/** The version a reference pins, or null when it follows the live one. */
export function pinnedVersion(ref: string): number | null {
  return parseSkillRef(ref).version;
}
