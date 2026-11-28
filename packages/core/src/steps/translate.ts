// Translation between steps (docs/step-model-plan.md §6): every connection into a step is in one of
// three states, worked out on the receiving step's incoming side when the workflow is built.
//
// - **Fits**: an earlier step (or the trigger) hands on a field of the same name and type. The
//   step's `input` reads it directly (`{{steps.<id>.output.header.vendorName}}`).
// - **Translated**: the field can be filled from what came before: renamed, converted or worked
//   out. The step's `translation` (a Reshape mapping) holds how, and it runs as code at run time.
// - **Doesn't fit**: a field the step requires has no source. `validateWorkflow` says so
//   (`input_missing`) and the workflow can't go live.
//
// The proposal is Reshape's (`../process/reshape-propose`): by name, any case or spelling, common
// synonyms and a type that fits or converts plainly. What it leaves, the Builder AI may fill
// (`packages/agents`, `translateLeftovers`); nothing translated needs confirming or marking (owner,
// 2026-11-25). Pure and deterministic: the same steps always translate the same way, money stays a
// decimal string (invariant 6), and no model runs at run time.

import { isPlainObject } from "../json";
import {
  evaluateReshape,
  type ReshapeExpr,
  type ReshapeField,
  type ReshapeMapping,
  type ReshapeOperand,
  type ReshapeProblem,
  reshapeExprKind,
} from "../process/reshape";
import {
  exprInputKeys,
  proposeReshape,
  type ReshapeContext,
  type ReshapeMatch,
  type ReshapeSource,
  reshapeInputSchema,
} from "../process/reshape-propose";
import type { JsonSchema } from "../schemas/common";
import type { DoStep, Field, Uses } from "./schema";

// ── Fields as JSON Schema (what Reshape's proposer and typer read) ─────────────────────────────

/** A field's JSON Schema: money is a decimal string, a record is its id, dates are ISO text. */
export function fieldSchema(field: Field): JsonSchema {
  const about = field.about ? { description: field.about } : {};
  switch (field.type) {
    case "text":
      return { type: "string", ...about };
    case "number":
      return { type: "number", ...about };
    // DECISION: money travels as a decimal string ("125.00"), as the Data tab's samples and
    // Reshape's formatMoney write it; `format: money` tells a translation to write it as money.
    case "money":
      return { type: "string", format: "money", ...about };
    case "date":
      return { type: "string", format: "date", ...about };
    case "yes_no":
      return { type: "boolean", ...about };
    case "record":
      return { type: "string", ...about };
    case "group":
      return { ...fieldsSchema(field.of ?? []), ...about };
    case "list":
      return {
        type: "array",
        items: (field.of ?? []).length > 0 ? fieldsSchema(field.of ?? []) : {},
        ...about,
      };
  }
}

/** A list of fields as one object's JSON Schema, the required ones required. */
export function fieldsSchema(fields: readonly Field[]): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldSchema(f)])),
    required: fields.filter((f) => f.required).map((f) => f.name),
  };
}

// ── Where the data comes from ──────────────────────────────────────────────────────────────────

/** One thing a step's incoming side can read: the trigger, or an earlier step's output. */
export interface TranslateSource {
  /** What it is in a template: `trigger`, or `steps.<id>.output`. */
  ref: string;
  /** The step's name, or "Trigger". */
  label: string;
  /** The fields it hands on. */
  fields: readonly Field[];
}

/**
 * Input keys that bring a whole source in for the translation start with `_`, which no field name
 * can (`FIELD_NAME`), so they are never mistaken for one of the step's own fields; the run drops
 * them before the step's engine sees its input (`applyTranslation`).
 */
// DECISION (stream G): the translation reads its sources through the step's `input` (as a Reshape
// step does), under keys a field can't have, rather than from the run's whole scope: step ids may
// hold `-`, which an expression's path can't, and the input then says everything the step reads.
export const SOURCE_PREFIX = "_";

export const isSourceKey = (key: string): boolean => key.startsWith(SOURCE_PREFIX);

/** The input key a source comes in under: `_trigger`, `_<step id>` (`-` written `_`). */
export function sourceKey(ref: string): string {
  if (ref === "trigger") return "_trigger";
  const id = /^steps\.([^.]+)\.output$/.exec(ref)?.[1] ?? ref;
  return `${SOURCE_PREFIX}${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Every path a source hands on (groups opened, a list's items' fields too), with its field. */
function paths(fields: readonly Field[], base: string, out: Map<string, Field>, depth = 0) {
  if (depth > 5) return;
  for (const f of fields) {
    const p = base ? `${base}.${f.name}` : f.name;
    out.set(p, f);
    if (f.type === "group" && f.of) paths(f.of, p, out, depth + 1);
  }
}

/**
 * The field a reference reads, a list's item by its position included (`trigger.documents.0`, the
 * first document; `….lines.0.qty`): a list of plain values gives a text item, a list of records
 * the record or one of its fields. Undefined when the source doesn't hand it on.
 */
// Staging, 2026-11-28: "Read the invoice" read `{{trigger.documents.0}}`, the email's first
// attachment; the builder took it for a field the trigger no longer hands on, dropped it and said
// "nothing gives documentId", though the run reads it.
export function fieldAt(known: ReadonlyMap<string, Field>, ref: string): Field | undefined {
  const hit = known.get(ref);
  if (hit) return hit;
  const parts = ref.split(".");
  for (let i = 1; i < parts.length; i++) {
    if (!/^\d+$/.test(parts[i] as string)) continue;
    const list = known.get(parts.slice(0, i).join("."));
    if (list?.type !== "list") return undefined;
    const rest = parts.slice(i + 1);
    const of = list.of ?? [];
    if (rest.length === 0) {
      return of.length > 0
        ? { name: list.name, type: "group", required: list.required, of }
        : { name: list.name, type: "text", required: list.required };
    }
    const inner = new Map<string, Field>();
    paths(of, "", inner);
    return inner.get(rest.join("."));
  }
  return undefined;
}

const WHOLE_REF = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/;

/** The reference a value is when it is nothing but one (`{{steps.x.output.a}}` → `steps.x.output.a`). */
export function wholeRef(value: unknown): string | null {
  return typeof value === "string" ? (WHOLE_REF.exec(value)?.[1] ?? null) : null;
}

// ── The states ─────────────────────────────────────────────────────────────────────────────────

export type ConnectionState = "fits" | "translated" | "doesnt_fit";

/**
 * How one input field is filled: `picked` (a field chosen by hand, or one of the same name and
 * type), `fixed` (a value typed in), Reshape's `name`, `synonym`, `fields`, `kept`, or `ai`; `none`
 * when nothing fills it.
 */
export type FieldHow = "picked" | "fixed" | Exclude<ReshapeMatch, "exact"> | "same" | "ai" | "none";

export interface FieldSource {
  name: string;
  required: boolean;
  /** Fits, Translated, or Doesn't fit; an optional field nothing fills is `empty`. */
  state: ConnectionState | "empty";
  how: FieldHow;
  /** Where it comes from, in words ("Read the invoice › header › supplier, as money"). */
  from?: string | undefined;
}

export interface WorkedOut {
  /** The step's input: what fits read directly, fixed values, and the sources the translation reads. */
  input: Record<string, unknown>;
  /** The translation, when any field needs one. */
  translation?: ReshapeMapping | undefined;
  /** Each field the step takes, in its order, with its source. */
  fields: FieldSource[];
  /** The connection as a whole: Doesn't fit if any required field has no source. */
  state: ConnectionState;
}

/** The connection's state from its fields' states. */
export function connectionState(fields: readonly Pick<FieldSource, "state">[]): ConnectionState {
  if (fields.some((f) => f.state === "doesnt_fit")) return "doesnt_fit";
  return fields.some((f) => f.state === "translated") ? "translated" : "fits";
}

// ── Working it out ─────────────────────────────────────────────────────────────────────────────

/** Reshape's context for a step that takes `needs`, reading `sources`. */
export function translateContext(
  needs: readonly Field[],
  sources: readonly TranslateSource[],
  input: Record<string, unknown> = {},
): ReshapeContext {
  const reshapeSources: ReshapeSource[] = sources.map((s) => ({
    key: sourceKey(s.ref),
    template: `{{${s.ref}}}`,
    schema: fieldsSchema(s.fields),
    label: s.label,
  }));
  const own = Object.fromEntries(Object.entries(input).filter(([k]) => isSourceKey(k)));
  return {
    sources: reshapeSources,
    next: { stepId: "", name: "", schema: fieldsSchema(needs) },
    input: reshapeInputSchema(own, reshapeSources),
  };
}

/** A plain copy of a field of the same name (`{input: "_x.header.vendorName"}` for `vendorName`). */
function plainCopy(name: string, e: ReshapeExpr | undefined): string | null {
  if (!e || !isPlainObject(e) || Object.keys(e).length !== 1) return null;
  const path = (e as { input?: unknown }).input;
  if (typeof path !== "string") return null;
  return path.split(".").at(-1) === name ? path : null;
}

/** A number written as text into a money field is written as money (decimal, invariant 6). */
function asMoney(field: Field | undefined, e: ReshapeExpr): ReshapeExpr {
  if (field?.type !== "money" || !("formatNumber" in e)) return e;
  const f = e.formatNumber;
  if (f.as === "number") return e;
  return {
    formatMoney: { value: f.value, ...(f.places !== undefined ? { places: f.places } : {}) },
  };
}

/**
 * Works out a step's incoming side: for each field it takes, Fits, Translated or Doesn't fit.
 *
 * What the person set is theirs: a field picked by hand or a fixed value stays as it is, and a
 * translated field they haven't touched keeps its mapping while it still type-checks. A reference
 * to a field no source hands on any more is dropped and worked out again. With nothing to take
 * (`needs` empty: the step writes its own, or what it uses isn't known), the step is left as it is.
 */
export function workOutTranslation(options: {
  needs: readonly Field[];
  sources: readonly TranslateSource[];
  input?: Record<string, unknown> | undefined;
  translation?: ReshapeMapping | undefined;
}): WorkedOut {
  const { needs, sources } = options;
  const current = options.input ?? {};
  if (needs.length === 0) {
    return {
      input: current,
      ...(options.translation ? { translation: options.translation } : {}),
      fields: [],
      state: "fits",
    };
  }
  const known = new Map<string, Field>();
  const roots = new Set<string>();
  for (const s of sources) {
    roots.add(s.ref);
    paths(s.fields, s.ref, known);
  }
  const words = sourceWords(sources);

  // 1. What the person set (or an earlier pass wrote directly) stays, unless it reads nothing.
  const input: Record<string, unknown> = {};
  const set = new Map<string, FieldSource>();
  for (const f of needs) {
    const v = current[f.name];
    if (v === undefined || v === "") continue;
    const ref = wholeRef(v);
    if (ref === null) {
      input[f.name] = v;
      set.set(f.name, { ...base(f), state: "fits", how: "fixed", from: "a fixed value" });
      continue;
    }
    const field = fieldAt(known, ref);
    const root = [...roots].find((r) => ref === r || ref.startsWith(`${r}.`));
    // A reference into a source that no longer hands that field on is worked out again; one to
    // something this step can't see from here (a For each's item) is the person's and stays.
    if (root && !field) continue;
    input[f.name] = v;
    set.set(f.name, {
      ...base(f),
      state: "fits",
      how: field && field.name === f.name && field.type === f.type ? "same" : "picked",
      from: field ? (words.get(ref) ?? ref) : ref,
    });
  }

  // 2. The rest: Reshape's proposal, keeping the current translation where it still type-checks.
  // Only required fields are worked out unasked; an optional one stays as the person left it
  // (staging, 2026-11-27: a QuickBooks customer search's optional `name` was filled from the
  // message's sender on every load, so the project list only ever held customers named after the
  // employee, and taking it out never stuck). One the current translation already maps is kept.
  const mappedBefore = new Set((options.translation?.fields ?? []).map((m) => m.name));
  const rest = needs.filter((f) => !set.has(f.name) && (f.required || mappedBefore.has(f.name)));
  const fields: FieldSource[] = [];
  const mapped: ReshapeField[] = [];
  if (rest.length > 0) {
    const context = translateContext(rest, sources, current);
    const proposal = proposeReshape({
      context,
      current: {
        input: Object.fromEntries(Object.entries(current).filter(([k]) => isSourceKey(k))),
        mapping: options.translation,
      },
    });
    const byName = new Map(rest.map((f) => [f.name, f]));
    for (const p of proposal.mapping.fields) {
      const field = byName.get(p.name);
      if (!field || !p.from) continue;
      const copy = plainCopy(p.name, p.from);
      if (copy) {
        // The same name and a type that fits: read directly, nothing to translate.
        const [key, ...rest] = copy.split(".");
        const source = sources.find((s) => sourceKey(s.ref) === key);
        if (source) {
          const ref = [source.ref, ...rest].join(".");
          input[p.name] = `{{${ref}}}`;
          set.set(p.name, {
            ...base(field),
            state: "fits",
            how: "same",
            from: words.get(ref) ?? ref,
          });
          continue;
        }
      }
      const from = asMoney(field, p.from);
      mapped.push({ ...p, from });
      const how = proposal.how[p.name];
      set.set(p.name, {
        ...base(field),
        state: "translated",
        // A mapping kept from before that copies one field under another name was a rename.
        how:
          how === "kept" && isOperand(from)
            ? "synonym"
            : how === undefined || how === "exact"
              ? "same"
              : how,
        from: describeExpr(from, sources),
      });
    }
  }
  for (const f of needs) {
    fields.push(
      set.get(f.name) ?? {
        ...base(f),
        state: f.required ? "doesnt_fit" : "empty",
        how: "none",
      },
    );
  }
  return finish(input, mapped, fields, sources);
}

const base = (f: Field) => ({ name: f.name, required: f.required });

/** The input with the sources the translation reads, and the translation in the needs' order. */
function finish(
  input: Record<string, unknown>,
  mapped: readonly ReshapeField[],
  fields: FieldSource[],
  sources: readonly TranslateSource[],
): WorkedOut {
  const order = new Map(fields.map((f, i) => [f.name, i]));
  const sorted = [...mapped].sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  const out: Record<string, unknown> = { ...input };
  const used = new Set(sorted.flatMap((f) => (f.from ? exprInputKeys(f.from) : [])));
  for (const s of sources) {
    const key = sourceKey(s.ref);
    if (used.has(key)) out[key] = `{{${s.ref}}}`;
  }
  return {
    input: out,
    ...(sorted.length > 0 ? { translation: { fields: sorted } } : {}),
    fields,
    state: connectionState(fields),
  };
}

/**
 * Adds what the Builder AI suggested for fields the rules left (each already checked by
 * `checkSuggestions`), applied without confirming (owner, 2026-11-25). A suggestion for a field
 * already filled is ignored.
 */
export function withSuggestions(
  worked: WorkedOut,
  suggested: Readonly<Record<string, ReshapeExpr>>,
  needs: readonly Field[],
  sources: readonly TranslateSource[],
): WorkedOut {
  const byName = new Map(needs.map((f) => [f.name, f]));
  const mapped: ReshapeField[] = [...(worked.translation?.fields ?? [])];
  const fields = worked.fields.map((f) => {
    const e = suggested[f.name];
    const field = byName.get(f.name);
    if (!e || !field || (f.state !== "doesnt_fit" && f.state !== "empty")) return f;
    const from = asMoney(field, e);
    mapped.push({
      name: f.name,
      schema: fieldSchema(field),
      ...(field.required ? {} : { required: false }),
      from,
    });
    return {
      ...f,
      state: "translated" as const,
      how: "ai" as const,
      from: describeExpr(from, sources),
    };
  });
  const input = Object.fromEntries(Object.entries(worked.input).filter(([k]) => !isSourceKey(k)));
  return finish(input, mapped, fields, sources);
}

/** The fields still without a source, top level only (what the AI is asked about). */
export function unfilled(worked: Pick<WorkedOut, "fields">): string[] {
  return worked.fields
    .filter((f) => f.state === "doesnt_fit" || f.state === "empty")
    .map((f) => f.name);
}

/**
 * A step with its incoming side worked out: its input and translation replaced. Returns the same
 * step when nothing changed, so a host can apply it whenever the workflow around it changes.
 */
export function translateStep(
  step: DoStep,
  needs: readonly Field[],
  sources: readonly TranslateSource[],
): { step: DoStep; worked: WorkedOut } {
  const worked = workOutTranslation({
    needs,
    sources,
    input: step.input,
    translation: step.translation,
  });
  const same =
    stable(worked.input) === stable(step.input) &&
    stable(worked.translation) === stable(step.translation);
  if (same) return { step, worked };
  const next: DoStep = { ...step, input: worked.input };
  if (worked.translation) next.translation = worked.translation;
  else delete next.translation;
  return { step: next, worked };
}

function stable(v: unknown): string {
  return (
    JSON.stringify(v, (_k, x) =>
      isPlainObject(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : x,
    ) ?? ""
  );
}

/**
 * The names of the fields a Do step's Uses requires, for `validateWorkflow`'s `requiredInput`:
 * a required field with neither an input nor a translated field is Doesn't fit (`input_missing`).
 */
export function requiredInputFrom(
  needsOf: (uses: Uses) => readonly Field[] | undefined,
): (uses: Uses) => string[] | undefined {
  return (uses) =>
    needsOf(uses)
      ?.filter((f) => f.required)
      .map((f) => f.name);
}

// ── Words (the Input box and the Data tab) ────────────────────────────────────────────────────

/** Each path's words: "Read the invoice › header › vendorName". */
function sourceWords(sources: readonly TranslateSource[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sources) {
    const all = new Map<string, Field>();
    paths(s.fields, "", all);
    out.set(s.ref, s.label);
    for (const p of all.keys()) out.set(`${s.ref}.${p}`, [s.label, ...p.split(".")].join(" › "));
  }
  return out;
}

function operandWords(o: ReshapeOperand, sources: readonly TranslateSource[]): string {
  if ("input" in o) {
    const [key, ...rest] = o.input.split(".");
    const s = sources.find((x) => sourceKey(x.ref) === key);
    return [s?.label ?? key, ...rest].join(" › ");
  }
  if ("item" in o) return o.item === "" ? "each item" : `each item's ${o.item}`;
  if ("today" in o) return "today";
  return JSON.stringify(o.value);
}

const isOperand = (e: ReshapeExpr): e is ReshapeOperand =>
  "input" in e || "item" in e || "value" in e || "today" in e;

/** An expression in a few words, for the Input box and the Data tab's "Changed". */
export function describeExpr(e: ReshapeExpr, sources: readonly TranslateSource[]): string {
  if (isOperand(e)) return operandWords(e, sources);
  const w = (o: ReshapeOperand) => operandWords(o, sources);
  if ("formatMoney" in e) return `${w(e.formatMoney.value)}, as money`;
  if ("formatNumber" in e) {
    return `${w(e.formatNumber.value)}, as ${e.formatNumber.as === "number" ? "a number" : "text"}`;
  }
  if ("formatDate" in e) return `${w(e.formatDate.value)}, as a date`;
  if ("join" in e) return `${e.join.values.map(w).join(" and ")}, joined`;
  if ("mapList" in e) return `each of ${w(e.mapList.list)}, field by field`;
  if ("object" in e) {
    const n = Object.keys(e.object.fields).length;
    return `built from ${n} ${n === 1 ? "field" : "fields"}`;
  }
  if ("sum" in e) return `the sum of ${e.sum.map(w).join(", ")}`;
  if ("difference" in e) return `${w(e.difference[0])} less ${w(e.difference[1])}`;
  if ("pluck" in e) return `each ${e.pluck.field} of ${w(e.pluck.list)}`;
  if ("pick" in e) return `one item of ${w(e.pick.list)}`;
  if ("convertUnit" in e) return `${w(e.convertUnit.value)}, in ${e.convertUnit.to}`;
  return `worked out (${reshapeExprKind(e)})`;
}

/** A field's state in words, as the Input box and the Data tab say it. */
export function stateWords(f: Pick<FieldSource, "state" | "how" | "from" | "name">): string {
  switch (f.state) {
    case "fits":
      return f.how === "fixed" ? "Fits: a fixed value" : `Fits: ${f.from ?? ""}`;
    case "translated": {
      const how =
        f.how === "name" || f.how === "synonym"
          ? " (renamed)"
          : f.how === "ai"
            ? " (worked out by AI)"
            : "";
      return `Translated: from ${f.from ?? ""}${how}`;
    }
    case "doesnt_fit":
      return `Doesn't fit: nothing gives "${f.name}"`;
    case "empty":
      return "Nothing gives it (optional)";
  }
}

// ── At run time ────────────────────────────────────────────────────────────────────────────────

export interface Translated {
  /** What the step's engine gets: its own fields, the sources dropped. */
  input: Record<string, unknown>;
  /** Fields the translation couldn't fill; the run fails the step on any. */
  problems: ReshapeProblem[];
}

/**
 * The executor's hook: a Do step's input, its templates already resolved, translated before its
 * engine runs. Code only, no model: the same input and day give the same result, and money is
 * decimal (`evaluateReshape`). Without a translation the input passes as it is, sources dropped.
 */
export function applyTranslation(
  step: Pick<DoStep, "translation">,
  resolved: Record<string, unknown>,
  options: { today: string },
): Translated {
  const own = Object.fromEntries(Object.entries(resolved).filter(([k]) => !isSourceKey(k)));
  if (!step.translation || step.translation.fields.length === 0) {
    return { input: own, problems: [] };
  }
  const r = evaluateReshape(step.translation, resolved, options);
  return { input: { ...own, ...r.output }, problems: r.problems };
}
