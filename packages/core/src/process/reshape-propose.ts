// Reshape data (owner, 2026-11-11): where a Reshape step sits (what runs before it, what the next
// step takes) and the deterministic first proposal of its mapping, by name and type: an exact name,
// the name in any case or spelling, a common synonym, and a type that fits (or converts: a number
// written as money, a list of records mapped field by field). Whatever is still unmapped is the
// Builder AI's to suggest (packages/agents), checked against the expression schema; the operator
// reviews every field before saving. Pure: the builder and the server share it.

import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";
import type { TypingContext } from "../template/typer";
import {
  nextStepOf,
  type ReshapeExpr,
  type ReshapeField,
  type ReshapeMapping,
  type ReshapeOperand,
  reshapeExprSchema,
  schemaFitProblems,
  schemaTypeNames,
  stepInputSchema,
} from "./reshape";
import type { Process } from "./schema";
import { processScopes, processTriggerSchema } from "./validate";
import { findStep } from "./walk";

/** One thing a Reshape step can bring in: an earlier step's output, or the trigger's payload. */
export interface ReshapeSource {
  /** The input key it comes in under (`readDocument`), which expressions read (`input.<key>…`). */
  key: string;
  /** The template that brings it in (`{{steps.<id>.output}}`, `{{trigger}}`). */
  template: string;
  /** What it holds (unknown: any path reads). */
  schema: JsonSchema | undefined;
  /** The step's name, or "Trigger", for the builder. */
  label: string;
}

/** Where a Reshape step sits: what it can read, and what the step after it takes. */
export interface ReshapeContext {
  sources: ReshapeSource[];
  /** The step right after it on its path, when it takes an input the builder knows. */
  next: { stepId: string; name: string; schema: JsonSchema } | null;
  /** The step's own input as typed (what `input.<key>…` reads). */
  input: JsonSchema;
}

// ── Where the step sits ──────────────────────────────────────────────────────────────────────

/** An input key from a step's name: `Read document` → `readDocument`. */
function keyFrom(name: string, taken: ReadonlySet<string>): string {
  const words = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]?.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  if (!/^[A-Za-z_]/.test(key)) key = `step${key}`;
  key = key.slice(0, 40) || "step";
  let out = key;
  for (let n = 2; taken.has(out); n++) out = `${key}${n}`;
  return out;
}

/** The single reference a template is (`{{steps.x.output}}` → `steps.x.output`), else null. */
function wholeRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
  return m ? (m[1] as string) : null;
}

/**
 * What a Reshape step at `stepId` can read (the trigger and every step before it on its path,
 * nearest last; a source its input already brings in keeps its key) and what the next step takes.
 */
export function reshapeContext(
  process: Pick<Process, "triggers" | "steps">,
  stepId: string,
  ctx: TypingContext = {},
): ReshapeContext | null {
  const loc = findStep(process, stepId);
  if (!loc) return null;
  const step = loc.step;
  const existing = step.kind === "skill" ? step.input : {};
  const keyOf = new Map<string, string>();
  for (const [k, v] of Object.entries(existing)) {
    const ref = wholeRef(v);
    if (ref) keyOf.set(ref, k);
  }
  const taken = new Set(Object.keys(existing));
  const sources: ReshapeSource[] = [];
  const trigger = processTriggerSchema(process, ctx);
  const add = (ref: string, schema: JsonSchema | undefined, label: string, name: string) => {
    let key = keyOf.get(ref);
    if (!key) {
      key = keyFrom(name, taken);
      taken.add(key);
    }
    sources.push({ key, template: `{{${ref}}}`, schema, label });
  };
  if (isPlainObject(trigger?.properties) && Object.keys(trigger.properties).length > 0) {
    add("trigger", trigger, "Trigger", "trigger");
  }
  const scope = processScopes(process, ctx).get(stepId);
  for (const id of loc.before) {
    const s = scope?.steps[id];
    if (!s) continue;
    add(`steps.${id}.output`, s.output, s.step.name || id, s.step.name || id);
  }
  const next = nextStepOf(process, stepId);
  const nextSchema = next ? stepInputSchema(next, ctx) : undefined;
  return {
    sources,
    next: next && nextSchema ? { stepId: next.id, name: next.name, schema: nextSchema } : null,
    input: reshapeInputSchema(existing, sources),
  };
}

/** The step's input as its expressions read it: each key typed by the source it brings in. */
export function reshapeInputSchema(
  input: Record<string, unknown>,
  sources: readonly ReshapeSource[],
): JsonSchema {
  const byTemplate = new Map(sources.map((s) => [s.template, s.schema]));
  const properties: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(input)) {
    properties[k] = (typeof v === "string" ? byTemplate.get(v) : undefined) ?? {};
  }
  for (const s of sources)
    if (!Object.hasOwn(properties, s.key)) properties[s.key] = s.schema ?? {};
  return { type: "object", properties, additionalProperties: false };
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// DECISION: a short list of synonyms for the back-office fields our actions and skills name
// (vendors, invoices, bills, lines, messages), normalized; a name in two groups matches both.
const SYNONYMS: readonly (readonly string[])[] = [
  ["vendorname", "vendor", "supplier", "suppliername", "payee", "payeename", "vendordisplayname"],
  ["vendorid", "supplierid", "payeeid"],
  [
    "invoicenumber",
    "invoiceno",
    "invoicenum",
    "invoiceid",
    "docnumber",
    "documentnumber",
    "billnumber",
    "refnumber",
  ],
  ["date", "invoicedate", "issuedate", "txndate", "billdate", "documentdate"],
  ["duedate", "due", "paymentdue", "dueon"],
  ["total", "totalamount", "amountdue", "grandtotal", "invoicetotal", "balancedue"],
  ["amount", "extprice", "lineamount", "linetotal", "extendedprice", "extendedamount"],
  ["currency", "currencycode"],
  ["description", "desc", "itemdescription", "details"],
  ["memo", "note", "notes", "comment", "comments"],
  ["quantity", "qty"],
  ["unitprice", "price", "rate", "unitcost"],
  ["lines", "items", "lineitems", "rows"],
  ["email", "emailaddress"],
  ["phone", "phonenumber", "telephone", "mobile"],
  ["subject", "title"],
  ["body", "text", "message", "content"],
  ["sku", "vendorsku", "itemcode", "partnumber"],
  ["account", "accountid", "glaccount"],
  ["name", "fullname", "displayname"],
];

/** How a source field's name matches a target's: 0 exact, 1 any case or spelling, 2 a synonym. */
function nameTier(target: string, path: readonly string[]): number | null {
  const last = path.at(-1);
  if (last === undefined) return null;
  if (last === target) return 0;
  const t = norm(target);
  if (norm(last) === t) return 1;
  // `vendor.name` reads as `vendorName`.
  if (path.length >= 2 && norm(`${path.at(-2)}${last}`) === t) return 1;
  const l = norm(last);
  if (SYNONYMS.some((g) => g.includes(t) && g.includes(l))) return 2;
  return null;
}

/** How a match was found, for the builder ("same name", "a synonym", …). */
export type ReshapeMatch = "exact" | "name" | "synonym" | "kept";
const TIER_MATCH: readonly ReshapeMatch[] = ["exact", "name", "synonym"];

// ── Candidates ───────────────────────────────────────────────────────────────────────────────

interface Candidate {
  operand: (path: readonly string[]) => ReshapeOperand;
  path: string[];
  schema: JsonSchema | undefined;
  /** Later sources win a tie: the nearest step's output. */
  rank: number;
}

function fieldsOf(
  schema: JsonSchema | undefined,
  base: string[],
  depth: number,
  out: { path: string[]; schema: JsonSchema | undefined }[],
) {
  if (!isPlainObject(schema) || depth > 4) return;
  for (const k of ["anyOf", "oneOf"] as const) {
    const alts = schema[k];
    if (Array.isArray(alts)) {
      for (const a of alts) fieldsOf(a as JsonSchema, base, depth, out);
      return;
    }
  }
  const props = isPlainObject(schema.properties)
    ? (schema.properties as Record<string, JsonSchema>)
    : {};
  for (const [k, s] of Object.entries(props)) {
    const path = [...base, k];
    out.push({ path, schema: s });
    if (schemaTypeNames(s).includes("object")) fieldsOf(s, path, depth + 1, out);
  }
}

function sourceCandidates(sources: readonly ReshapeSource[]): Candidate[] {
  const out: Candidate[] = [];
  sources.forEach((s, rank) => {
    const fields: { path: string[]; schema: JsonSchema | undefined }[] = [];
    fieldsOf(s.schema, [], 0, fields);
    for (const f of fields) {
      out.push({
        operand: (p) => ({ input: [s.key, ...p].join(".") }),
        path: f.path,
        schema: f.schema,
        rank,
      });
    }
  });
  return out;
}

function itemCandidates(items: JsonSchema | undefined): Candidate[] {
  const fields: { path: string[]; schema: JsonSchema | undefined }[] = [];
  fieldsOf(items, [], 0, fields);
  return fields.map((f) => ({
    operand: (p) => ({ item: p.join(".") }),
    path: f.path,
    schema: f.schema,
    rank: 0,
  }));
}

const MONEY_NAME = /amount|total|price|cost|subtotal|tax|freight|balance/i;

const props = (s: JsonSchema | undefined): Record<string, JsonSchema> =>
  isPlainObject(s?.properties) ? (s.properties as Record<string, JsonSchema>) : {};
const requiredOf = (s: JsonSchema | undefined): string[] =>
  Array.isArray(s?.required) ? (s.required as string[]) : [];
const itemsOf = (s: JsonSchema | undefined): JsonSchema | undefined =>
  isPlainObject(s?.items) ? (s.items as JsonSchema) : undefined;

/** An expression that fills `name` (of `target`'s type) from the candidate, or null. */
function fill(
  name: string,
  target: JsonSchema | undefined,
  c: Candidate,
  unmapped: string[],
): { expr: ReshapeExpr; converted: boolean } | null {
  const operand = c.operand(c.path);
  const want = schemaTypeNames(target);
  const have = schemaTypeNames(c.schema).filter((t) => t !== "null");
  // A list of records into a list of records: mapped field by field.
  const targetItems = itemsOf(target);
  const sourceItems = itemsOf(c.schema);
  if (
    want.includes("array") &&
    have.includes("array") &&
    schemaTypeNames(targetItems).includes("object") &&
    schemaTypeNames(sourceItems).includes("object")
  ) {
    const inner = proposeFields(props(targetItems), itemCandidates(sourceItems));
    if (Object.keys(inner.fields).length === 0) return null;
    for (const u of inner.unmapped) unmapped.push(`${name}.${u}`);
    return { expr: { mapList: { list: operand, fields: inner.fields } }, converted: false };
  }
  const fits = schemaFitProblems(target, c.schema, name).length === 0;
  if (fits && have.length > 0) return { expr: operand, converted: false };
  if (
    want.includes("string") &&
    have.length > 0 &&
    have.every((t) => t === "number" || t === "integer")
  ) {
    return {
      expr: MONEY_NAME.test(name)
        ? { formatMoney: { value: operand } }
        : { formatNumber: { value: operand } },
      converted: true,
    };
  }
  if ((want.includes("number") || want.includes("integer")) && have.includes("string")) {
    return { expr: { formatNumber: { value: operand, as: "number" } }, converted: true };
  }
  if (
    want.includes("string") &&
    have.includes("array") &&
    schemaTypeNames(sourceItems).includes("string")
  ) {
    return { expr: { join: { values: [operand], separator: ", " } }, converted: true };
  }
  // An unknown source type is the operator's to check: offered only on an exact name.
  if (have.length === 0) return { expr: operand, converted: true };
  return null;
}

function proposeFields(
  targets: Record<string, JsonSchema>,
  candidates: readonly Candidate[],
): { fields: Record<string, ReshapeExpr>; unmapped: string[]; how: Record<string, ReshapeMatch> } {
  const fields: Record<string, ReshapeExpr> = {};
  const how: Record<string, ReshapeMatch> = {};
  const unmapped: string[] = [];
  for (const [name, schema] of Object.entries(targets)) {
    let best: { expr: ReshapeExpr; key: number[]; tier: number; nested: string[] } | null = null;
    for (const c of candidates) {
      const tier = nameTier(name, c.path);
      if (tier === null) continue;
      const tried: string[] = [];
      const f = fill(name, schema, c, tried);
      if (!f) continue;
      // An unknown type matches on the exact name only.
      if (f.converted && schemaTypeNames(c.schema).length === 0 && tier !== 0) continue;
      const key = [tier, f.converted ? 1 : 0, tried.length, c.path.length, -c.rank];
      if (!best || compareKeys(key, best.key) < 0)
        best = { expr: f.expr, key, tier, nested: tried };
    }
    if (best) {
      fields[name] = best.expr;
      how[name] = TIER_MATCH[best.tier] as ReshapeMatch;
      unmapped.push(...best.nested);
    } else {
      unmapped.push(name);
    }
  }
  return { fields, unmapped, how };
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

// ── The proposal ─────────────────────────────────────────────────────────────────────────────

export interface ReshapeProposal {
  /** The step's input: the sources its mapping reads, by key. */
  input: Record<string, string>;
  mapping: ReshapeMapping;
  /** Fields left unmapped (`lines.account` for a mapped list's item field). */
  unmapped: string[];
  /** How each mapped top-level field was found. */
  how: Record<string, ReshapeMatch>;
}

/** Every input key an expression reads (`input.read.header.x` → `read`). */
export function exprInputKeys(e: ReshapeExpr): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (isPlainObject(v)) {
      if (typeof v.input === "string" && Object.keys(v).length === 1) {
        out.push(v.input.split(".")[0] as string);
        return;
      }
      for (const x of Object.values(v)) visit(x);
    }
  };
  visit(e);
  return out;
}

/**
 * The deterministic proposal for a Reshape step: one output field per field the next step takes
 * (its type copied), each filled by name and type where a source has it; with `current`, each
 * field whose mapping still type-checks is kept as it is ("Propose an updated mapping"). Without
 * a next step, the current fields are the targets.
 */
// DECISION: names lead and types decide: a source field is offered for a target only when its
// name matches (exactly, in any case or spelling, or as a common synonym) and its type fits or
// converts plainly (a number written as text or money, text read as a number, a list of records
// mapped field by field, a list of text joined). A type alone never maps a field: two amounts of
// one type are where a wrong guess costs most, so those are the Builder AI's to suggest and the
// operator's to check.
export function proposeReshape(options: {
  context: ReshapeContext;
  current?: { input: Record<string, unknown>; mapping: ReshapeMapping | undefined };
}): ReshapeProposal {
  const { context, current } = options;
  const targetSchema: JsonSchema | undefined = context.next?.schema;
  const currentFields = current?.mapping?.fields ?? [];
  const targets: Record<string, JsonSchema> = targetSchema
    ? props(targetSchema)
    : Object.fromEntries(currentFields.map((f) => [f.name, f.schema]));
  const required = targetSchema
    ? requiredOf(targetSchema)
    : currentFields.filter((f) => f.required !== false).map((f) => f.name);

  // Fields whose mapping still type-checks are kept.
  const kept = new Map<string, ReshapeExpr>();
  for (const f of currentFields) {
    if (!f.from || !Object.hasOwn(targets, f.name)) continue;
    const t = reshapeExprSchema(f.from, { input: context.input });
    if (t.problems.length > 0) continue;
    if (schemaFitProblems(targets[f.name], t.schema, f.name).length > 0) continue;
    kept.set(f.name, f.from);
  }
  const toPropose = Object.fromEntries(Object.entries(targets).filter(([n]) => !kept.has(n)));
  const proposed = proposeFields(toPropose, sourceCandidates(context.sources));

  const fields: ReshapeField[] = Object.entries(targets).map(([name, schema]) => {
    const from = kept.get(name) ?? proposed.fields[name];
    return {
      name,
      schema,
      ...(required.includes(name) ? {} : { required: false }),
      ...(from ? { from } : {}),
    };
  });
  const how: Record<string, ReshapeMatch> = { ...proposed.how };
  for (const n of kept.keys()) how[n] = "kept";

  // The input: what the kept fields already read, then the sources the new ones read.
  const used = new Set(fields.flatMap((f) => (f.from ? exprInputKeys(f.from) : [])));
  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries(current?.input ?? {})) {
    if (used.has(k) && typeof v === "string") input[k] = v;
  }
  for (const s of context.sources) {
    if (used.has(s.key) && !Object.hasOwn(input, s.key)) input[s.key] = s.template;
  }
  return {
    input,
    mapping: { fields },
    unmapped: proposed.unmapped.filter((u) => !kept.has(u)),
    how,
  };
}

/**
 * The next step's input wired to the Reshape step's output: each field it takes that the mapping
 * gives reads `{{steps.<reshape>.output.<field>}}`; anything else it had stays.
 */
export function wireToReshape(
  next: Record<string, unknown>,
  reshapeId: string,
  mapping: ReshapeMapping,
  takes: JsonSchema | undefined,
): Record<string, unknown> {
  const accepted = takes ? props(takes) : null;
  const out: Record<string, unknown> = { ...next };
  for (const f of mapping.fields) {
    if (accepted && !Object.hasOwn(accepted, f.name)) continue;
    out[f.name] = `{{steps.${reshapeId}.output.${f.name}}}`;
  }
  return out;
}
