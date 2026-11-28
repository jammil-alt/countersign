// The wiring between steps, checked at publish (docs/step-model-plan.md §6, ARCHITECTURE §10.2):
// every `{{…}}` a step reads (its input, a Fork's rules, a For each's list, an output's input) is
// followed into what the step or trigger it names really hands on, and what it finds must fit
// the field it fills. Every step kind has a known output shape here, so the server's publish
// checks and the web builder read the same: what passes here is what the run finds.
//
// Staging, 2026-11-27/28: agents failed at run time on wiring nothing checked: a Match's record
// read as `items.0.matched.id` (it is the id itself), lines read as `vendorSku` matched on `sku`,
// money handed to a tool that takes decimals, a Fork's and a For each's results, a conversation's
// findings. Pure; references the registries can't type (an untyped JSON field) pass.

import type { Trigger } from "../schemas/workflow";
import { collectRefs, singleRef, type TemplateRef } from "../template/template";
import { type MatchProfile, matchResultFields } from "./match-profile";
import type { DoStep, Step, Uses, Workflow, WorkflowOutput } from "./schema";
import {
  ANY,
  type Conversion,
  fieldList,
  fieldsShape,
  fitShape,
  group,
  mergeShapes,
  type Shape,
  shapeAt,
  shapeWords,
  withFields,
} from "./shape";
import { isSourceKey } from "./translate";
import type { StepIssue } from "./validate";
import { eachStep } from "./walk";

/** What the wiring checks may know of the registries; each part optional (absent: not known). */
export interface ShapeContext {
  /** What an action, a skill or an automation hands on. */
  outputShape?(uses: Uses): Shape | undefined;
  /** What an action, a skill or an automation takes. */
  inputShape?(uses: Uses): Shape | undefined;
  /** A match profile by its id. */
  profile?(id: string): MatchProfile | undefined;
  /** What a trigger puts in `{{trigger.…}}`. */
  triggerShape?(trigger: Trigger): Shape | undefined;
}

const TEXT: Shape = { type: "text" };
const SOURCES: Shape = { type: "list", of: TEXT, about: "the records it rests on" };

/** Every Do step's result may carry its sources (invariant 10), whatever else it names. */
const withSources = (shape: Shape): Shape =>
  shape.type === "group" && !Object.hasOwn(shape.fields, "sources")
    ? withFields(shape, { sources: SOURCES })
    : shape;

/** What a person step hands on: whether they approved, their answer, and who. */
const PERSON: Shape = group(
  { approved: { type: "yes_no" }, answer: ANY, by: TEXT },
  { required: ["approved"] },
);

/** Whether a list of steps can't run past its last step (an End, or a Fork whose every path ends). */
function ends(list: readonly Step[]): boolean {
  const last = list.at(-1);
  if (!last) return false;
  if (last.kind === "end") return true;
  if (last.kind === "fork")
    return last.paths.every((p) => ends(p.steps)) && ends(last.otherwise.steps);
  return false;
}

/** What a Match step hands on, for its profile: each item matched, and the counts (§7). */
export function matchShape(profile: Pick<MatchProfile, "record" | "input">): Shape {
  const result = fieldsShape(matchResultFields(profile));
  // Each item is handed back as it came in, with whatever else it had beside the profile's fields
  // (an invoice line's `vendorSku`, `quantity`): open.
  const items = result.fields.items;
  if (items?.type === "list" && items.of.type === "group") {
    const item = items.of.fields.item;
    const each = item?.type === "group" ? { ...item, open: true } : ANY;
    return withSources(
      withFields(result, {
        items: { ...items, of: withFields(items.of, { item: each }) },
      }),
    );
  }
  return withSources(result);
}

/**
 * What a step hands on to the steps after it (`{{steps.<id>.output…}}`), as the executor records
 * it. `any` where it can't be known from here.
 */
export function stepOutputShape(step: Step, ctx: ShapeContext = {}): Shape {
  switch (step.kind) {
    case "do":
      return doOutput(step, ctx);
    case "loop":
      // A Loop's output schema is the runtime's (`loopRequest`): money as a decimal string. With
      // no fields, it answers in words with its sources.
      return step.output.length > 0
        ? withSources(fieldsShape(step.output, { money: "decimal" }))
        : ANY;
    case "fork": {
      // DECISION (wiring checks): after a Fork, what any path that rejoins hands on (its last
      // step's output), with `pathId` and `pathName`. The union, not the intersection: a path that
      // hands nothing on (an empty Otherwise, "nothing to ask") is the common case, and the owner's
      // "Ask the employee" inside one path, read after the Fork, must publish. A path that always
      // ends (on an End) never reaches the steps after the Fork, so it doesn't count.
      const rejoin = [...step.paths.map((p) => p.steps), step.otherwise.steps].filter(
        (list) => !ends(list),
      );
      let merged: Shape | undefined;
      for (const list of rejoin) {
        const last = list.at(-1);
        const given = last ? stepOutputShape(last, ctx) : group({});
        const one = given.type === "group" || given.type === "any" ? given : group({});
        merged = merged ? mergeShapes(merged, one) : one;
      }
      const path = { pathId: TEXT, pathName: TEXT };
      if (merged?.type === "any") return ANY;
      return withFields(merged ?? group({}), path);
    }
    case "for_each": {
      const last = step.steps.at(-1);
      // A failed item hands on null; over the most a step may hand on, the count only.
      return group(
        {
          count: { type: "number" },
          failed: { type: "number" },
          items: { type: "list", of: last ? stepOutputShape(last, ctx) : ANY },
          itemsTooLarge: { type: "yes_no" },
        },
        { required: ["count"] },
      );
    }
    case "repeat": {
      const last: Record<string, Shape> = {};
      eachStep(step.steps, ({ step: s, parents }) => {
        if (parents.length === 0) last[s.id] = stepOutputShape(s, ctx);
      });
      return group(
        { passes: { type: "number" }, done: { type: "yes_no" }, last: group(last) },
        { required: ["passes", "done"] },
      );
    }
    case "wait":
    case "handoff":
    case "end":
      return ANY;
  }
}

function doOutput(step: DoStep, ctx: ShapeContext): Shape {
  const own =
    step.output && step.output.length > 0
      ? withSources(fieldsShape(step.output, { money: "object" }))
      : ANY;
  const uses = step.uses;
  switch (uses?.type) {
    case "action":
    case "skill":
    case "automation": {
      const known = ctx.outputShape?.(uses);
      return known ? withSources(known) : own;
    }
    case "match": {
      const profile = ctx.profile?.(uses.match.to);
      return profile ? matchShape(profile) : ANY;
    }
    case "collect":
    case "tell":
    case "missing":
      return ANY;
    case undefined:
      break;
  }
  if (step.doneBy === "person") return PERSON;
  if (step.doneBy === "contact") {
    // What it finds is handed on under its own names and under `found` (the executor's output).
    const find = fieldsShape(step.output ?? [], { money: "object" });
    return group({
      ...find.fields,
      status: TEXT,
      found: find,
      summary: TEXT,
      conversationId: TEXT,
      sources: SOURCES,
    });
  }
  return own;
}

/** What the workflow's triggers put in `{{trigger.…}}`: any of them (unknown if one is). */
export function triggerShape(triggers: readonly Trigger[], ctx: ShapeContext = {}): Shape {
  let out: Shape | undefined;
  for (const t of triggers) {
    const one = ctx.triggerShape?.(t);
    if (!one) return ANY;
    out = out ? mergeShapes(out, one) : one;
  }
  return out ?? ANY;
}

/** What a Do step takes: its action's, skill's or automation's input, or its Match profile's. */
export function stepInputShape(step: DoStep, ctx: ShapeContext = {}): Shape {
  const uses = step.uses;
  if (!uses) return ANY;
  if (uses.type === "match") {
    const profile = ctx.profile?.(uses.match.to);
    return profile ? fieldsShape(profile.input) : ANY;
  }
  if (uses.type === "action" || uses.type === "skill" || uses.type === "automation") {
    return ctx.inputShape?.(uses) ?? ANY;
  }
  return ANY;
}

// ── The checks ───────────────────────────────────────────────────────────────────────────────────

/** A reference's source: what it is in words, and what it hands on. */
interface Source {
  /** `"Match the vendor"`, the trigger, each item. */
  label: string;
  shape: Shape;
  /** The path inside the source (`items.0.matched`). */
  rel: string[];
}

interface Scope {
  trigger: Shape;
  byId: ReadonlyMap<string, Step>;
  shapes: Map<string, Shape>;
  ctx: ShapeContext;
  /** The innermost For each's item, when inside one. */
  item?: Source | undefined;
  /** The steps that run before the reader on its path (and itself); absent: any (an output). */
  ran?: ReadonlySet<string> | undefined;
}

const quote = (name: string) => `"${name.trim() || "An earlier step"}"`;
const code = (path: readonly string[]) => `\`${path.join(".")}\``;

function shapeOfStep(scope: Scope, id: string): Shape | undefined {
  const step = scope.byId.get(id);
  if (!step) return undefined;
  let shape = scope.shapes.get(id);
  if (!shape) {
    shape = stepOutputShape(step, scope.ctx);
    scope.shapes.set(id, shape);
  }
  return shape;
}

/** The source a reference reads; undefined when it reads something these checks don't follow. */
function sourceOf(ref: readonly string[], scope: Scope): Source | undefined {
  const [head, id, out, ...rest] = ref;
  if (head === "trigger") {
    return { label: "the trigger", shape: scope.trigger, rel: ref.slice(1) };
  }
  if (head === "item" && scope.item) {
    return { ...scope.item, rel: [...scope.item.rel, ...ref.slice(1)] };
  }
  if (head === "steps" && id !== undefined && out === "output") {
    // One that doesn't run before the reader is the scope check's (`stepModelRefErrors`): said once.
    if (scope.ran && !scope.ran.has(id)) return undefined;
    const shape = shapeOfStep(scope, id);
    if (!shape) return undefined;
    return { label: quote(scope.byId.get(id)?.name ?? id), shape, rel: rest };
  }
  return undefined;
}

type Read = { ok: true; source: Source; shape: Shape } | { ok: false; message: string };

/** What a reference finds, or why it finds nothing, in plain words. */
function read(ref: readonly string[], scope: Scope, field?: string): Read | undefined {
  const source = sourceOf(ref, scope);
  if (!source) return undefined;
  const at = shapeAt(source.shape, source.rel);
  if (at.ok) return { ok: true, source, shape: at.shape };
  const reached = source.rel.slice(0, at.reached);
  const next = source.rel[at.reached] as string;
  const there = at.shape;
  let hint: string;
  if (reached.length === 0) {
    hint =
      there.type === "group"
        ? `it hands on ${fieldList(there)}`
        : `it hands on ${shapeWords(there)}`;
  } else if (there.type === "list") {
    hint = `${code(reached)} is a list: read one of its items by position (${code([...reached, "0", next])})`;
  } else if (there.type === "group") {
    hint = `${code(reached)} holds ${fieldList(there)}`;
  } else {
    hint = `it hands on ${code(reached)} (${shapeWords(there)})`;
  }
  const forField = field ? ` for "${field}"` : "";
  return {
    ok: false,
    message: `Reads ${code(source.rel)}${forField}, which ${source.label} doesn't hand on: ${hint}.`,
  };
}

/** A conversion the run makes for a field, as the checks found it (shown, never refused). */
export interface WiringConversion {
  /** The step or output it is on. */
  at: string;
  /** The input field (`lines`, `expectedTotal`). */
  field: string;
  conversions: Conversion[];
}

export interface Wiring {
  issues: StepIssue[];
  conversions: WiringConversion[];
}

/**
 * Every reference a workflow's steps and outputs make, followed into what it reads: an unknown
 * path is `reference_unknown`, a value that doesn't fit the field it fills `reference_type`, a
 * Match given a list whose items lack a field the profile needs `match_item_missing`. The
 * conversions the run will make (`convertToShape`) are listed, not refused.
 */
export function workflowWiring(workflow: Workflow, ctx: ShapeContext = {}): Wiring {
  const byId = new Map<string, Step>();
  eachStep(workflow.steps, ({ step }) => {
    byId.set(step.id, step);
  });
  const root: Scope = {
    trigger: triggerShape(workflow.triggers, ctx),
    byId,
    shapes: new Map(),
    ctx,
  };
  const out: Wiring = { issues: [], conversions: [] };

  const visit = (list: readonly Step[], outer: Scope) => {
    const ran = new Set(outer.ran);
    for (const step of list) {
      // A step's notices may read its own output; a Repeat's stop test what its body did.
      const own = new Set([...ran, step.id]);
      if (step.kind === "repeat") for (const s of step.steps) own.add(s.id);
      checkStep(step, { ...outer, ran: own }, out);
      const inside: Scope = { ...outer, ran: new Set(ran) };
      if (step.kind === "fork") {
        for (const p of step.paths) visit(p.steps, inside);
        visit(step.otherwise.steps, inside);
      } else if (step.kind === "for_each") {
        visit(step.steps, { ...inside, item: itemOf(step.over, inside) });
      } else if (step.kind === "repeat") {
        visit(step.steps, inside);
      }
      ran.add(step.id);
    }
  };
  visit(workflow.steps, { ...root, ran: new Set() });
  for (const o of workflow.outputs) checkOutput(o, root, out);
  return out;
}

/** The item a For each goes through: its list's items. */
function itemOf(over: string, scope: Scope): Source | undefined {
  const ref = safeSingleRef(over);
  if (!ref) return undefined;
  const r = read(ref, scope);
  if (!r?.ok) return undefined;
  const items = r.shape.type === "list" ? r.shape.of : ANY;
  return { label: "the item", shape: items, rel: [] };
}

function safeSingleRef(value: string): string[] | null {
  try {
    return singleRef(value.trim());
  } catch {
    return null;
  }
}

/** Every reference in a value, its path only (where it is read as words, or by rules). */
function checkPaths(value: unknown, at: string, scope: Scope, out: Wiring) {
  let refs: TemplateRef[];
  try {
    refs = collectRefs(value).refs;
  } catch {
    return;
  }
  for (const ref of refs) {
    const r = read(ref.path, scope);
    if (r && !r.ok) push(out, at, "reference_unknown", r.message);
  }
}

function push(out: Wiring, at: string, code: StepIssue["code"], message: string) {
  if (out.issues.some((i) => i.at === at && i.message === message)) return;
  out.issues.push({ at, code, message });
}

/**
 * One input value filling a field of the `target` shape: a whole reference is followed and must
 * fit; text with references in it is text; a group or a list written in the step is checked field
 * by field.
 */
function checkValue(
  value: unknown,
  target: Shape,
  field: string,
  at: string,
  scope: Scope,
  out: Wiring,
  depth = 0,
) {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (!value.includes("{{")) return;
    const ref = safeSingleRef(value);
    if (!ref) {
      checkPaths(value, at, scope, out);
      const fit = fitShape(TEXT, target);
      if (!fit.fits) {
        push(out, at, "reference_type", `"${field}" is written as text, which ${fit.why}.`);
      }
      return;
    }
    const r = read(ref, scope, field);
    if (!r) return;
    if (!r.ok) {
      push(out, at, "reference_unknown", r.message);
      return;
    }
    const fit = fitShape(r.shape, target);
    if (!fit.fits) {
      const where = fit.at.length > 0 ? `: ${code([...r.source.rel, ...fit.at])}` : ", which";
      push(
        out,
        at,
        "reference_type",
        `Reads ${code(r.source.rel)} from ${r.source.label} for "${field}"${where} ${fit.why}.`,
      );
    } else if (fit.conversions.length > 0) {
      const seen = out.conversions.find((c) => c.at === at && c.field === field);
      if (seen) seen.conversions = [...new Set([...seen.conversions, ...fit.conversions])];
      else out.conversions.push({ at, field, conversions: fit.conversions });
    }
    return;
  }
  if (Array.isArray(value)) {
    const of = target.type === "list" ? target.of : ANY;
    value.forEach((v, i) => {
      checkValue(v, of, `${field}.${i}`, at, scope, out, depth + 1);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const want =
        target.type === "group" && Object.hasOwn(target.fields, k) ? target.fields[k] : ANY;
      checkValue(v, want ?? ANY, `${field}.${k}`, at, scope, out, depth + 1);
    }
  }
}

/** An input object against what the step takes, field by field (`_` sources by path only). */
function checkInput(
  input: Record<string, unknown>,
  target: Shape,
  at: string,
  scope: Scope,
  out: Wiring,
) {
  for (const [key, value] of Object.entries(input)) {
    if (isSourceKey(key)) {
      checkPaths(value, at, scope, out);
      continue;
    }
    const want =
      target.type === "group" && Object.hasOwn(target.fields, key) ? target.fields[key] : ANY;
    checkValue(value, want ?? ANY, key, at, scope, out);
  }
}

/** A step's settings but its input and the steps it holds (what it reads by path only). */
function otherSettings(step: Step): unknown {
  switch (step.kind) {
    case "do": {
      const { input: _i, translation: _t, output: _o, ...rest } = step;
      return rest;
    }
    case "loop": {
      const { output: _o, ...rest } = step;
      return rest;
    }
    case "fork": {
      const { paths, otherwise: _o, ...rest } = step;
      return { ...rest, paths: paths.map(({ steps: _s, ...p }) => p) };
    }
    case "for_each": {
      const { steps: _s, over: _over, ...rest } = step;
      return rest;
    }
    case "repeat": {
      const { steps: _s, ...rest } = step;
      return rest;
    }
    default:
      return step;
  }
}

function checkStep(step: Step, scope: Scope, out: Wiring) {
  const at = step.id;
  checkPaths(otherSettings(step), at, scope, out);
  if (step.kind === "do") {
    checkDoInput(step, scope, out);
  } else if (step.kind === "for_each") {
    checkOver(step.over, at, scope, out);
  }
}

function checkOver(over: string, at: string, scope: Scope, out: Wiring) {
  const ref = safeSingleRef(over);
  if (!ref) {
    checkPaths(over, at, scope, out);
    return;
  }
  const r = read(ref, scope);
  if (!r) return;
  if (!r.ok) {
    push(out, at, "reference_unknown", r.message);
    return;
  }
  if (r.shape.type !== "list" && r.shape.type !== "any") {
    push(
      out,
      at,
      "reference_type",
      `Goes through ${code(r.source.rel)} from ${r.source.label}, which is ${shapeWords(r.shape)}, not a list.`,
    );
  }
}

function checkDoInput(step: DoStep, scope: Scope, out: Wiring) {
  const at = step.id;
  const uses = step.uses;
  if (uses?.type === "match" && step.input.items !== undefined) {
    checkMatchItems(step, uses.match.to, scope, out);
    return;
  }
  checkInput(step.input, stepInputShape(step, scope.ctx), at, scope, out);
}

/**
 * A Match given a list (`items`) matches each item: each field its profile needs is the item's
 * own (by its key's name or one of the key's other names, `MatchKey.also`) or given beside the
 * list for every item.
 */
function checkMatchItems(step: DoStep, profileId: string, scope: Scope, out: Wiring) {
  const at = step.id;
  const { items, ...beside } = step.input;
  const profile = scope.ctx.profile?.(profileId);
  const target = profile ? fieldsShape(profile.input) : ANY;
  checkInput(beside, target, at, scope, out);
  const ref = typeof items === "string" ? safeSingleRef(items) : null;
  if (!ref) {
    checkPaths(items, at, scope, out);
    return;
  }
  const r = read(ref, scope, "items");
  if (!r) return;
  if (!r.ok) {
    push(out, at, "reference_unknown", r.message);
    return;
  }
  if (r.shape.type === "any") return;
  if (r.shape.type !== "list") {
    push(
      out,
      at,
      "reference_type",
      `Matches each item of ${code(r.source.rel)} from ${r.source.label}, which is ${shapeWords(r.shape)}, not a list.`,
    );
    return;
  }
  const item = r.shape.of;
  if (!profile || item.type !== "group" || item.open) return;
  for (const f of profile.input) {
    if (!f.required || Object.hasOwn(beside, f.name)) continue;
    const names = [
      f.name,
      ...profile.keys.filter((k) => k.field === f.name).flatMap((k) => k.also ?? []),
    ];
    if (names.some((n) => Object.hasOwn(item.fields, n))) continue;
    push(
      out,
      at,
      "match_item_missing",
      `Matches each item of ${code(r.source.rel)} from ${r.source.label} on "${f.name}", which its items don't have: they have ${fieldList(item)}. Give "${f.name}" beside the list, or match on a field they have.`,
    );
  }
}

function checkOutput(o: WorkflowOutput, scope: Scope, out: Wiring) {
  const at = o.id;
  const { action, ...rest } = o;
  checkPaths(rest, at, scope, out);
  if (action) {
    const target = scope.ctx.inputShape?.({ type: "action", action: action.action }) ?? ANY;
    checkInput(action.input, target, at, scope, out);
  }
}
