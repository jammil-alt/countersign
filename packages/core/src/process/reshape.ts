// Reshape data (owner, 2026-11-11; ARCHITECTURE §10.14 "Reshape data", docs/plan.md §1.86): one
// built-in deterministic skill that takes any input and returns an output whose fields the step
// defines. Each output field is a mapping: a copied input field, a literal, or a small typed
// expression (the rule rows' sum, difference, percent change, days between and buckets, plus what
// reshaping needs: dates, numbers and money formatted, text joined or split, a list picked from,
// plucked or mapped field by field, units converted with core's table). Data only: no code, no
// template that executes, no model and no write when it runs. The sums and the conditions are the
// rule rows' own evaluator (`skills/rules.ts`); money is decimal.js (invariant 6).

import { z } from "zod";
import { isPlainObject } from "../json";
import { Decimal } from "../money";
import { JsonSchema, parseSkillRef } from "../schemas/common";
import {
  parameterValueProblem,
  SkillBucket,
  SkillInputPath,
  SkillLiteral,
  type SkillOperand,
  type SkillValue,
} from "../schemas/skill-model";
import {
  bucketLabel,
  evaluateSkillCompute,
  evaluateSkillCondition,
  evaluateSkillValue,
  type SkillRuleContext,
} from "../skills/rules";
import { resolvePath } from "../template/template";
import { lookupSkill, schemaAtPath, type TypingContext, typesCompatible } from "../template/typer";
import { convertUnits, unitOf } from "../units";
import { actionInputSchema } from "./actions";
import type { Process, Step } from "./schema";

/** The built-in skill's id, and its handler (a pure tool: `sideEffect: none`, no model). */
export const RESHAPE_SKILL = "data.reshape";
export const RESHAPE_TOOL = "data.reshape";

// ── The mapping, as data ─────────────────────────────────────────────────────────────────────

/** A field of the step's input (`read.header.vendorName`). */
const InputPath = SkillInputPath;
/** A field of the list item being mapped; "" is the item itself. */
const ItemPath = z.union([SkillInputPath, z.literal("")]);
/** A field inside a list's items (`sku`, `price.amount`). */
const FieldPath = SkillInputPath;

/** What an expression reads: an input field, the list item's field, a literal, or today. */
export const ReshapeOperand = z.union([
  z.strictObject({ input: InputPath }),
  z.strictObject({ item: ItemPath }),
  z.strictObject({ value: SkillLiteral }),
  z.strictObject({ today: z.literal(true) }),
]);
export type ReshapeOperand = z.infer<typeof ReshapeOperand>;

/** How a date is written: 2026-11-10, 11/10/2026, 10/11/2026, November 10, 2026. */
export const RESHAPE_DATE_STYLES = ["iso", "mdy", "dmy", "long"] as const;
export const ReshapeDateStyle = z.enum(RESHAPE_DATE_STYLES);
export type ReshapeDateStyle = z.infer<typeof ReshapeDateStyle>;

const Places = z.number().int().min(0).max(4);
const Buckets = z.array(SkillBucket).superRefine((value, ctx) => {
  const problem = parameterValueProblem({ name: "buckets", type: "buckets" }, value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export type ReshapeExpr =
  | ReshapeOperand
  | { daysBetween: { from: ReshapeOperand; to: ReshapeOperand } }
  | { sum: ReshapeOperand[] }
  | { difference: [ReshapeOperand, ReshapeOperand] }
  | { percentChange: { from: ReshapeOperand; to: ReshapeOperand } }
  | { bucket: { value: ReshapeOperand; buckets: SkillBucket[] } }
  | {
      formatDate: {
        value: ReshapeOperand;
        from?: ReshapeDateStyle | undefined;
        to: ReshapeDateStyle;
      };
    }
  | {
      formatNumber: {
        value: ReshapeOperand;
        places?: number | undefined;
        as?: "text" | "number" | undefined;
      };
    }
  | {
      formatMoney: {
        value: ReshapeOperand;
        places?: number | undefined;
        currency?: ReshapeOperand | undefined;
      };
    }
  | { join: { values: ReshapeOperand[]; separator?: string | undefined } }
  | { split: { value: ReshapeOperand; separator: string; index?: number | undefined } }
  | {
      pick: {
        list: ReshapeOperand;
        index?: number | undefined;
        where?: { field: string; equals: ReshapeOperand } | undefined;
        field?: string | undefined;
      };
    }
  | { pluck: { list: ReshapeOperand; field: string } }
  | { mapList: { list: ReshapeOperand; fields: Record<string, ReshapeExpr> } }
  | { convertUnit: { value: ReshapeOperand; from: string; to: string } };

/** An output field's name (top level, or a mapped list item's field). */
export const ReshapeFieldName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "letters, digits and underscores, from a letter");

/**
 * One expression. The set is small and typed on purpose (owner, 2026-11-11): every value is data
 * the builder shows and the validator types; anything more is a skill of its own.
 */
export const ReshapeExpr: z.ZodType<ReshapeExpr> = z.lazy(() =>
  z.union([
    ReshapeOperand,
    z.strictObject({
      daysBetween: z.strictObject({ from: ReshapeOperand, to: ReshapeOperand }),
    }),
    z.strictObject({ sum: z.array(ReshapeOperand).min(1).max(20) }),
    z.strictObject({ difference: z.tuple([ReshapeOperand, ReshapeOperand]) }),
    z.strictObject({
      percentChange: z.strictObject({ from: ReshapeOperand, to: ReshapeOperand }),
    }),
    z.strictObject({ bucket: z.strictObject({ value: ReshapeOperand, buckets: Buckets }) }),
    z.strictObject({
      formatDate: z.strictObject({
        value: ReshapeOperand,
        from: ReshapeDateStyle.optional(),
        to: ReshapeDateStyle,
      }),
    }),
    z.strictObject({
      formatNumber: z.strictObject({
        value: ReshapeOperand,
        places: Places.optional(),
        as: z.enum(["text", "number"]).optional(),
      }),
    }),
    z.strictObject({
      formatMoney: z.strictObject({
        value: ReshapeOperand,
        places: Places.optional(),
        currency: ReshapeOperand.optional(),
      }),
    }),
    z.strictObject({
      join: z.strictObject({
        values: z.array(ReshapeOperand).min(1).max(20),
        separator: z.string().max(20).optional(),
      }),
    }),
    z.strictObject({
      split: z.strictObject({
        value: ReshapeOperand,
        separator: z.string().min(1).max(20),
        index: z.number().int().min(-100).max(100).optional(),
      }),
    }),
    z.strictObject({
      pick: z.strictObject({
        list: ReshapeOperand,
        index: z.number().int().min(-1000).max(1000).optional(),
        where: z.strictObject({ field: FieldPath, equals: ReshapeOperand }).optional(),
        field: FieldPath.optional(),
      }),
    }),
    z.strictObject({ pluck: z.strictObject({ list: ReshapeOperand, field: FieldPath }) }),
    z.strictObject({
      mapList: z.strictObject({
        list: ReshapeOperand,
        fields: z.record(ReshapeFieldName, ReshapeExpr),
      }),
    }),
    z.strictObject({
      convertUnit: z.strictObject({
        value: ReshapeOperand,
        from: z.string().min(1).max(40),
        to: z.string().min(1).max(40),
      }),
    }),
  ]),
) as z.ZodType<ReshapeExpr>;

/** The expression kinds, as the builder names them. */
export const RESHAPE_EXPR_KINDS = [
  "input",
  "item",
  "value",
  "today",
  "daysBetween",
  "sum",
  "difference",
  "percentChange",
  "bucket",
  "formatDate",
  "formatNumber",
  "formatMoney",
  "join",
  "split",
  "pick",
  "pluck",
  "mapList",
  "convertUnit",
] as const;
export type ReshapeExprKind = (typeof RESHAPE_EXPR_KINDS)[number];

/** Which kind an expression is (its one key). */
export function reshapeExprKind(e: ReshapeExpr): ReshapeExprKind {
  return Object.keys(e)[0] as ReshapeExprKind;
}

/**
 * One output field: its name, its type (a JSON Schema, copied from the next step's input by the
 * proposer, or the operator's), whether it is required, and how it is filled. A field without
 * `from` is unmapped: the validator names it until the operator maps it.
 */
export const ReshapeField = z.strictObject({
  name: ReshapeFieldName,
  schema: JsonSchema,
  /** Absent: required. */
  required: z.boolean().optional(),
  from: ReshapeExpr.optional(),
});
export type ReshapeField = z.infer<typeof ReshapeField>;

/** A Reshape data step's mapping: its output fields in order. Versioned with the agent. */
export const ReshapeMapping = z
  .strictObject({ fields: z.array(ReshapeField).max(100) })
  .refine((m) => new Set(m.fields.map((f) => f.name)).size === m.fields.length, {
    message: "each output field is named once",
    path: ["fields"],
  });
export type ReshapeMapping = z.infer<typeof ReshapeMapping>;

const isRequired = (f: Pick<ReshapeField, "required">) => f.required !== false;

/** The output the step promises: its fields, the required ones required. */
export function reshapeOutputSchema(mapping: ReshapeMapping | undefined): JsonSchema {
  const fields = mapping?.fields ?? [];
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, f.schema])),
    required: fields.filter(isRequired).map((f) => f.name),
    additionalProperties: false,
  };
}

// ── Where a step sits ──────────────────────────────────────────────────────────────────────────

/** The step right after `id` in its own list (not into or out of an if or a loop). */
export function nextStepOf(process: Pick<Process, "steps">, id: string): Step | null {
  const visit = (list: readonly Step[]): Step | null | undefined => {
    for (let i = 0; i < list.length; i++) {
      const s = list[i] as Step;
      if (s.id === id) return list[i + 1] ?? null;
      const inner =
        s.kind === "if"
          ? [...s.paths.map((p) => p.steps), s.otherwise.steps]
          : s.kind === "for_each"
            ? [s.steps]
            : [];
      for (const l of inner) {
        const found = visit(l);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return visit(process.steps) ?? null;
}

/** What a step takes as input, when known: its tool's, its action's or its skill's input. */
export function stepInputSchema(step: Step, ctx: TypingContext): JsonSchema | undefined {
  switch (step.kind) {
    case "read":
      return ctx.tools?.[step.tool]?.input;
    case "write":
      if (step.action !== undefined) return actionInputSchema(step.action);
      return step.tool === undefined ? undefined : ctx.tools?.[step.tool]?.input;
    case "skill":
      return lookupSkill(step.skill, ctx)?.input;
    default:
      return undefined;
  }
}

/** Whether a step is a Reshape data step. */
export function isReshapeStep(step: Step): boolean {
  return step.kind === "skill" && parseSkillRef(step.skill).id === RESHAPE_SKILL;
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────────────

/** One problem the mapping met, by output field (`lines.2.amount` inside a mapped list). */
export interface ReshapeProblem {
  field: string;
  message: string;
}

export interface ReshapeResult {
  /** The output: every field that has a value (an optional one with none is left out). */
  output: Record<string, unknown>;
  /** Fields that couldn't be filled; the runtime fails the step on any. */
  problems: ReshapeProblem[];
}

interface Env {
  input: unknown;
  item?: { value: unknown } | undefined;
  today: string;
}

type Got = { ok: true; value: unknown } | { ok: false; message: string };
const ok = (value: unknown): Got => ({ ok: true, value });
const no = (message: string): Got => ({ ok: false, message });

function operandValue(o: ReshapeOperand, env: Env): Got {
  if ("input" in o) return ok(resolvePath(env.input, o.input.split(".")));
  if ("item" in o) {
    if (!env.item) return no("reads a list item outside a list map");
    return ok(o.item === "" ? env.item.value : resolvePath(env.item.value, o.item.split(".")));
  }
  if ("today" in o) return ok(env.today);
  return ok(o.value);
}

function operandWords(o: ReshapeOperand): string {
  if ("input" in o) return `input.${o.input}`;
  if ("item" in o) return o.item === "" ? "the item" : `item.${o.item}`;
  if ("today" in o) return "today";
  return JSON.stringify(o.value);
}

/**
 * The rule rows' context for an operand list: the step's input under `in`, the item under `it`,
 * so the rule rows' own evaluator (decimals, amounts, dates) works the sums out.
 */
function ruleContext(env: Env): SkillRuleContext {
  return {
    input: { in: env.input, ...(env.item ? { it: env.item.value } : {}) },
    parameters: {},
    today: env.today,
  };
}

function asSkillValue(o: ReshapeOperand): SkillOperand {
  if ("input" in o) return { input: `in.${o.input}` };
  if ("item" in o) return { input: o.item === "" ? "it" : `it.${o.item}` };
  return o;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** y, m, d from a date as written; null when it isn't one. */
function readDate(v: unknown, from: ReshapeDateStyle | undefined): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (iso && (from === undefined || from === "iso")) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!parts || (from !== "mdy" && from !== "dmy")) return null;
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    y = Number(parts[3]);
    [m, d] = from === "mdy" ? [a, b] : [b, a];
  }
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return [y, m, d];
}

const pad = (n: number) => String(n).padStart(2, "0");

function writeDate([y, m, d]: [number, number, number], to: ReshapeDateStyle): string {
  switch (to) {
    case "iso":
      return `${y}-${pad(m)}-${pad(d)}`;
    case "mdy":
      return `${pad(m)}/${pad(d)}/${y}`;
    case "dmy":
      return `${pad(d)}/${pad(m)}/${y}`;
    case "long":
      return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
}

/**
 * A number as written: a JS number, a decimal string, an amount, or text such as "$1,250.00" or
 * "(12.50)". Null when it isn't one.
 */
// DECISION: a JS number is read through its shortest decimal text (`String(n)`), never through a
// float's binary value, so 0.1 reads as 0.1; money is never added up as floats (invariant 6).
function readNumber(v: unknown): { value: Decimal; currency?: string } | null {
  if (typeof v === "number") return Number.isFinite(v) ? { value: new Decimal(String(v)) } : null;
  if (isPlainObject(v) && typeof v.amount === "string" && typeof v.currency === "string") {
    const n = readNumber(v.amount);
    return n ? { value: n.value, currency: v.currency } : null;
  }
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/[\s,]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^[A-Z]{3}/, "").replace(/^[$€£¥]/, "");
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  s = s.replace(/^[$€£¥]/, "");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  const d = new Decimal(s);
  return { value: negative ? d.negated() : d };
}

function textOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return null;
}

/** A list index from the end when negative (-1 is the last). */
function at<T>(list: readonly T[], index: number): T | undefined {
  return list[index < 0 ? list.length + index : index];
}

function evalExpr(
  e: ReshapeExpr,
  env: Env,
  item: JsonSchema | undefined,
  where: string,
  problems: ReshapeProblem[],
): Got {
  if ("input" in e || "item" in e || "value" in e || "today" in e) {
    return operandValue(e as ReshapeOperand, env);
  }
  const ctx = ruleContext(env);
  if ("daysBetween" in e) {
    const v = evaluateSkillValue(
      {
        daysBetween: { from: asSkillValue(e.daysBetween.from), to: asSkillValue(e.daysBetween.to) },
      },
      ctx,
    );
    return v === null || v === undefined
      ? no(
          `days between ${operandWords(e.daysBetween.from)} and ${operandWords(e.daysBetween.to)} needs two dates`,
        )
      : ok(v);
  }
  if ("sum" in e || "difference" in e || "percentChange" in e) {
    const c =
      "sum" in e
        ? { sum: e.sum.map(asSkillValue) as SkillValue[] }
        : "difference" in e
          ? {
              difference: [asSkillValue(e.difference[0]), asSkillValue(e.difference[1])] as [
                SkillValue,
                SkillValue,
              ],
            }
          : {
              percentChange: {
                from: asSkillValue(e.percentChange.from),
                to: asSkillValue(e.percentChange.to),
              },
            };
    const v = evaluateSkillCompute(c, ctx);
    if (v !== null && v !== undefined) return ok(v);
    const what = "sum" in e ? "a sum" : "difference" in e ? "a difference" : "a percent change";
    return no(
      `${what} needs numbers or amounts in one currency (a percent change from 0 has none)`,
    );
  }
  if ("bucket" in e) {
    const got = operandValue(e.bucket.value, env);
    if (!got.ok) return got;
    const label = bucketLabel(got.value, e.bucket.buckets);
    return label === null
      ? no(`${operandWords(e.bucket.value)} falls in no bucket (or isn't a number)`)
      : ok(label);
  }
  if ("formatDate" in e) {
    const got = operandValue(e.formatDate.value, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    const d = readDate(got.value, e.formatDate.from);
    return d
      ? ok(writeDate(d, e.formatDate.to))
      : no(
          `${operandWords(e.formatDate.value)} isn't a date${e.formatDate.from ? ` written ${e.formatDate.from}` : ""}`,
        );
  }
  if ("formatNumber" in e) {
    const got = operandValue(e.formatNumber.value, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    const n = readNumber(got.value);
    if (!n) return no(`${operandWords(e.formatNumber.value)} isn't a number`);
    const places = e.formatNumber.places;
    const rounded = places === undefined ? n.value : n.value.toDecimalPlaces(places);
    if (e.formatNumber.as === "number") return ok(rounded.toNumber());
    return ok(places === undefined ? rounded.toFixed() : rounded.toFixed(places));
  }
  if ("formatMoney" in e) {
    const got = operandValue(e.formatMoney.value, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    const n = readNumber(got.value);
    if (!n) return no(`${operandWords(e.formatMoney.value)} isn't an amount`);
    const places = e.formatMoney.places ?? 2;
    const amount = n.value.toDecimalPlaces(places).toFixed(places);
    if (!e.formatMoney.currency) return ok(amount);
    const c = operandValue(e.formatMoney.currency, env);
    if (!c.ok) return c;
    if (typeof c.value !== "string" || !/^[A-Z]{3}$/.test(c.value.trim())) {
      return no(`${operandWords(e.formatMoney.currency)} isn't a currency code such as USD`);
    }
    const currency = c.value.trim();
    if (n.currency && n.currency !== currency) {
      return no(`the amount is in ${n.currency}, not ${currency}: amounts never change currency`);
    }
    return ok({ amount, currency });
  }
  if ("join" in e) {
    const parts: string[] = [];
    for (const o of e.join.values) {
      const got = operandValue(o, env);
      if (!got.ok) return got;
      const list = Array.isArray(got.value) ? got.value : [got.value];
      for (const v of list) {
        if (v === undefined || v === null || v === "") continue;
        const t = textOf(v);
        if (t === null) return no(`${operandWords(o)} isn't text, a number or a list of them`);
        parts.push(t);
      }
    }
    return ok(parts.join(e.join.separator ?? " "));
  }
  if ("split" in e) {
    const got = operandValue(e.split.value, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    if (typeof got.value !== "string") return no(`${operandWords(e.split.value)} isn't text`);
    const parts = got.value
      .split(e.split.separator)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    return ok(e.split.index === undefined ? parts : (at(parts, e.split.index) ?? null));
  }
  if ("pick" in e || "pluck" in e || "mapList" in e) {
    const listOperand = "pick" in e ? e.pick.list : "pluck" in e ? e.pluck.list : e.mapList.list;
    const got = operandValue(listOperand, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    if (!Array.isArray(got.value)) return no(`${operandWords(listOperand)} isn't a list`);
    const list = got.value;
    if ("pick" in e) {
      let picked: unknown;
      const w = e.pick.where;
      if (w) {
        const eq = operandValue(w.equals, env);
        if (!eq.ok) return eq;
        picked = list.find((x) =>
          evaluateSkillCondition(
            { left: { input: `it.${w.field}` }, op: "=", right: { input: "eq" } },
            { input: { it: x, eq: eq.value }, parameters: {}, today: env.today },
          ),
        );
      } else {
        picked = at(list, e.pick.index ?? 0);
      }
      if (picked === undefined) return ok(undefined);
      return ok(e.pick.field ? resolvePath(picked, e.pick.field.split(".")) : picked);
    }
    if ("pluck" in e) {
      const field = e.pluck.field.split(".");
      return ok(list.map((x) => resolvePath(x, field)).filter((v) => v !== undefined));
    }
    const itemSchema = isPlainObject(item?.items) ? (item.items as JsonSchema) : undefined;
    const out: Record<string, unknown>[] = [];
    let failed = false;
    list.forEach((x, i) => {
      const r = evaluateFields(
        Object.entries(e.mapList.fields).map(([name, from]) => ({
          name,
          from,
          schema: propertySchema(itemSchema, name),
          required: requiredIn(itemSchema, name),
        })),
        { input: env.input, item: { value: x }, today: env.today },
        `${where}.${i}`,
        problems,
      );
      if (r.failed) failed = true;
      out.push(r.out);
    });
    return failed ? no("") : ok(out);
  }
  if ("convertUnit" in e) {
    const got = operandValue(e.convertUnit.value, env);
    if (!got.ok) return got;
    if (got.value === undefined || got.value === null) return got;
    const n = readNumber(got.value);
    if (!n) return no(`${operandWords(e.convertUnit.value)} isn't a number`);
    const v = convertUnits(n.value, e.convertUnit.from, e.convertUnit.to);
    if (!v) return no(`no conversion from ${e.convertUnit.from} to ${e.convertUnit.to}`);
    const rounded = v.toDecimalPlaces(4);
    return ok(typeof got.value === "number" ? rounded.toNumber() : rounded.toFixed());
  }
  return no("an expression this version doesn't know");
}

function propertySchema(schema: JsonSchema | undefined, name: string): JsonSchema | undefined {
  const props = isPlainObject(schema?.properties)
    ? (schema.properties as Record<string, unknown>)
    : undefined;
  const p = props?.[name];
  return isPlainObject(p) ? (p as JsonSchema) : undefined;
}

function requiredIn(schema: JsonSchema | undefined, name: string): boolean {
  return Array.isArray(schema?.required) && (schema.required as unknown[]).includes(name);
}

function allowsNull(schema: JsonSchema | undefined): boolean {
  return schemaTypeNames(schema).includes("null");
}

/** Fills fields from their expressions; `failed` when any required one couldn't be filled. */
function evaluateFields(
  fields: readonly {
    name: string;
    from?: ReshapeExpr | undefined;
    schema: JsonSchema | undefined;
    required: boolean;
  }[],
  env: Env,
  prefix: string,
  problems: ReshapeProblem[],
): { out: Record<string, unknown>; failed: boolean } {
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const f of fields) {
    const field = prefix ? `${prefix}.${f.name}` : f.name;
    if (!f.from) {
      if (f.required) {
        problems.push({ field, message: `${field} isn't mapped` });
        failed = true;
      }
      continue;
    }
    const got = evalExpr(f.from, env, f.schema, field, problems);
    if (!got.ok) {
      if (got.message) problems.push({ field, message: `${field}: ${got.message}` });
      failed = true;
      continue;
    }
    const v = got.value;
    // DECISION: an empty value (missing or null) leaves an optional field out, so an invoice
    // without a due date makes a bill without one; a required field needs a value, unless its
    // type says it may be null.
    if (v === undefined || v === null) {
      if (v === null && allowsNull(f.schema)) out[f.name] = null;
      else if (f.required) {
        problems.push({ field, message: `${field} is empty: ${exprWords(f.from)} has no value` });
        failed = true;
      }
      continue;
    }
    out[f.name] = v;
  }
  return { out, failed };
}

function exprWords(e: ReshapeExpr): string {
  if ("input" in e || "item" in e || "value" in e || "today" in e) {
    return operandWords(e as ReshapeOperand);
  }
  return `its ${reshapeExprKind(e)}`;
}

/**
 * The mapping run on an input: the same input and day give the same output, every time. `today`
 * is `YYYY-MM-DD` from the run's clock (no clock here).
 */
export function evaluateReshape(
  mapping: ReshapeMapping,
  input: unknown,
  options: { today: string },
): ReshapeResult {
  const problems: ReshapeProblem[] = [];
  // A partial output is kept for the builder's sample; the runtime fails on any problem.
  const { out } = evaluateFields(
    mapping.fields.map((f) => ({
      name: f.name,
      from: f.from,
      schema: f.schema,
      required: isRequired(f),
    })),
    { input, today: options.today },
    "",
    problems,
  );
  return { output: out, problems };
}

// ── Typing (the validator's and the builder's) ───────────────────────────────────────────────

/** JSON type names a schema takes (`anyOf` and `oneOf` read as the union of their types). */
export function schemaTypeNames(schema: JsonSchema | undefined): string[] {
  if (!isPlainObject(schema)) return [];
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list))
      return [...new Set(list.flatMap((s) => schemaTypeNames(s as JsonSchema)))];
  }
  if (isPlainObject(schema.properties)) return ["object"];
  if (schema.items !== undefined) return ["array"];
  return [];
}

/** The alternative of a union schema that isn't null (`anyOf: [{type: string}, {type: null}]`). */
function nonNull(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!isPlainObject(schema)) return schema;
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list)) {
      const alts = list.filter(
        (s) => isPlainObject(s) && !(schemaTypeNames(s as JsonSchema).join() === "null"),
      ) as JsonSchema[];
      if (alts.length === 1) return alts[0];
    }
  }
  return schema;
}

const TYPE_WORDS: Record<string, string> = {
  string: "text",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  array: "a list",
  object: "a record",
  null: "nothing",
};

export function typeWords(types: readonly string[]): string {
  return types.map((t) => TYPE_WORDS[t] ?? t).join(" or ");
}

const UNKNOWN: JsonSchema | undefined = undefined;
const TEXT: JsonSchema = { type: "string" };
const NUMBER: JsonSchema = { type: "number" };
const AMOUNT: JsonSchema = {
  type: "object",
  properties: { amount: { type: "string" }, currency: { type: "string" } },
  required: ["amount", "currency"],
  additionalProperties: false,
};

function literalType(v: unknown): JsonSchema {
  if (v === null) return { type: "null" };
  if (Array.isArray(v)) return { type: "array", items: v.length > 0 ? literalType(v[0]) : {} };
  if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
  if (typeof v === "boolean") return { type: "boolean" };
  return TEXT;
}

interface TypeEnv {
  input: JsonSchema | undefined;
  item?: { schema: JsonSchema | undefined } | undefined;
}

interface Typed {
  schema: JsonSchema | undefined;
  problems: string[];
}

function typeOperand(o: ReshapeOperand, env: TypeEnv): Typed {
  if ("input" in o) {
    const t = schemaAtPath(env.input, o.input.split("."));
    return t.ok
      ? { schema: nonNull(t.schema), problems: [] }
      : { schema: UNKNOWN, problems: [`reads input.${o.input}: ${t.message}`] };
  }
  if ("item" in o) {
    if (!env.item) return { schema: UNKNOWN, problems: ["reads a list item outside a list map"] };
    if (o.item === "") return { schema: env.item.schema, problems: [] };
    const t = schemaAtPath(env.item.schema, o.item.split("."));
    return t.ok
      ? { schema: nonNull(t.schema), problems: [] }
      : { schema: UNKNOWN, problems: [`reads item.${o.item}: ${t.message}`] };
  }
  if ("today" in o) return { schema: { type: "string", format: "date" }, problems: [] };
  return { schema: literalType(o.value), problems: [] };
}

function numeric(schema: JsonSchema | undefined): boolean {
  const t = schemaTypeNames(schema);
  return t.length > 0 && t.every((x) => x === "number" || x === "integer");
}

/** The schema an expression gives, and what it reads that isn't there. */
export function reshapeExprSchema(e: ReshapeExpr, env: TypeEnv): Typed {
  if ("input" in e || "item" in e || "value" in e || "today" in e) {
    return typeOperand(e as ReshapeOperand, env);
  }
  const problems: string[] = [];
  const read = (o: ReshapeOperand) => {
    const t = typeOperand(o, env);
    problems.push(...t.problems);
    return t.schema;
  };
  const done = (schema: JsonSchema | undefined): Typed => ({ schema, problems });
  if ("daysBetween" in e) {
    read(e.daysBetween.from);
    read(e.daysBetween.to);
    return done({ type: "integer" });
  }
  if ("sum" in e || "difference" in e || "percentChange" in e) {
    const ops =
      "sum" in e
        ? e.sum
        : "difference" in e
          ? e.difference
          : [e.percentChange.from, e.percentChange.to];
    const schemas = ops.map(read);
    if (schemas.some((s) => schemaTypeNames(s).length === 0)) return done(UNKNOWN);
    if (schemas.every(numeric)) return done(NUMBER);
    if ("percentChange" in e) return done(TEXT);
    if (schemas.some((s) => schemaTypeNames(s).includes("object"))) return done(AMOUNT);
    return done(TEXT);
  }
  if ("bucket" in e) {
    read(e.bucket.value);
    return done(TEXT);
  }
  if ("formatDate" in e) {
    read(e.formatDate.value);
    return done(e.formatDate.to === "iso" ? { type: "string", format: "date" } : TEXT);
  }
  if ("formatNumber" in e) {
    read(e.formatNumber.value);
    return done(e.formatNumber.as === "number" ? NUMBER : TEXT);
  }
  if ("formatMoney" in e) {
    read(e.formatMoney.value);
    if (e.formatMoney.currency) read(e.formatMoney.currency);
    return done(e.formatMoney.currency ? AMOUNT : TEXT);
  }
  if ("join" in e) {
    for (const o of e.join.values) read(o);
    return done(TEXT);
  }
  if ("split" in e) {
    read(e.split.value);
    return done(e.split.index === undefined ? { type: "array", items: TEXT } : TEXT);
  }
  if ("convertUnit" in e) {
    const s = read(e.convertUnit.value);
    const from = unitOf(e.convertUnit.from);
    const to = unitOf(e.convertUnit.to);
    if (!from) problems.push(`no unit "${e.convertUnit.from}" in the unit table`);
    if (!to) problems.push(`no unit "${e.convertUnit.to}" in the unit table`);
    if (from && to && from.kind !== to.kind) {
      problems.push(`${e.convertUnit.from} and ${e.convertUnit.to} measure different things`);
    }
    return done(numeric(s) ? NUMBER : TEXT);
  }
  // Lists.
  const listOperand = "pick" in e ? e.pick.list : "pluck" in e ? e.pluck.list : e.mapList.list;
  const list = read(listOperand);
  const types = schemaTypeNames(list);
  if (types.length > 0 && !types.includes("array")) {
    problems.push(`${operandWords(listOperand)} isn't a list`);
    return done(UNKNOWN);
  }
  const items = isPlainObject(list?.items) ? (list.items as JsonSchema) : undefined;
  const at = (path: string): JsonSchema | undefined => {
    const t = schemaAtPath(items, path.split("."));
    if (!t.ok) {
      problems.push(`reads ${path} of each item in ${operandWords(listOperand)}: ${t.message}`);
      return UNKNOWN;
    }
    return nonNull(t.schema);
  };
  if ("pick" in e) {
    if (e.pick.where) {
      at(e.pick.where.field);
      read(e.pick.where.equals);
    }
    return done(e.pick.field ? at(e.pick.field) : items);
  }
  if ("pluck" in e) {
    const s = at(e.pluck.field);
    return done({ type: "array", ...(s ? { items: s } : {}) });
  }
  const properties: Record<string, JsonSchema> = {};
  for (const [name, from] of Object.entries(e.mapList.fields)) {
    const t = reshapeExprSchema(from, { input: env.input, item: { schema: items } });
    problems.push(...t.problems.map((p) => `${name} ${p}`));
    properties[name] = t.schema ?? {};
  }
  return done({
    type: "array",
    items: { type: "object", properties, required: Object.keys(properties) },
  });
}

/**
 * Why a value of `actual`'s type doesn't fit a field of `declared`'s: plain words, one per
 * place (a list's items and a record's fields are looked into). Unknown on either side fits.
 */
export function schemaFitProblems(
  declared: JsonSchema | undefined,
  actual: JsonSchema | undefined,
  where: string,
): string[] {
  const want = schemaTypeNames(declared);
  const have = schemaTypeNames(actual).filter((t) => t !== "null");
  if (want.length === 0 || have.length === 0) return [];
  if (!typesCompatible(want, have)) {
    return [`${where} gets ${typeWords(have)}; it takes ${typeWords(want)}`];
  }
  const d = nonNull(declared) as JsonSchema;
  const a = nonNull(actual) as JsonSchema;
  if (want.includes("array") && have.includes("array")) {
    const di = isPlainObject(d.items) ? (d.items as JsonSchema) : undefined;
    const ai = isPlainObject(a.items) ? (a.items as JsonSchema) : undefined;
    return schemaFitProblems(di, ai, `each of ${where}`);
  }
  if (want.includes("object") && have.includes("object")) {
    const dp = isPlainObject(d.properties) ? (d.properties as Record<string, JsonSchema>) : {};
    const ap = isPlainObject(a.properties) ? (a.properties as Record<string, JsonSchema>) : null;
    if (!ap) return [];
    const out: string[] = [];
    const required = Array.isArray(d.required) ? (d.required as string[]) : [];
    for (const r of required) {
      if (!Object.hasOwn(ap, r)) out.push(`${where} has no ${r}, which is required`);
    }
    for (const [k, s] of Object.entries(dp)) {
      if (Object.hasOwn(ap, k)) out.push(...schemaFitProblems(s, ap[k], `${where}.${k}`));
    }
    if (d.additionalProperties === false) {
      for (const k of Object.keys(ap)) {
        if (!Object.hasOwn(dp, k)) out.push(`${where} has ${k}, which it doesn't take`);
      }
    }
    return out;
  }
  return [];
}

/**
 * What doesn't type-check in a mapping against the step's input (the schema of what its input
 * brings in): each required field unmapped, each field read that isn't there, and each value that
 * doesn't fit its field's type. The validator reports them on the step, by field.
 */
export function reshapeProblems(
  mapping: ReshapeMapping,
  input: JsonSchema | undefined,
): ReshapeProblem[] {
  const out: ReshapeProblem[] = [];
  for (const f of mapping.fields) {
    if (!f.from) {
      if (isRequired(f)) out.push({ field: f.name, message: `${f.name} isn't mapped` });
      continue;
    }
    const t = reshapeExprSchema(f.from, { input });
    for (const p of t.problems) out.push({ field: f.name, message: `${f.name} ${p}` });
    if (t.problems.length > 0) continue;
    for (const p of schemaFitProblems(f.schema, t.schema, f.name)) {
      out.push({ field: f.name, message: p });
    }
  }
  return out;
}

// ── Samples (the builder's review) ───────────────────────────────────────────────────────────

const DECIMAL_HINT = /amount|total|price|cost|subtotal|tax|freight|balance|qty|quantity/i;

/** A value a schema could take, for the builder's sample when no run has the real thing. */
export function sampleFromSchema(schema: JsonSchema | undefined, name = "", depth = 0): unknown {
  if (!isPlainObject(schema) || depth > 6) return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list)) {
      const alt = list.find(
        (s) => isPlainObject(s) && schemaTypeNames(s as JsonSchema).join() !== "null",
      );
      return sampleFromSchema(alt as JsonSchema | undefined, name, depth + 1);
    }
  }
  const types = schemaTypeNames(schema);
  const t = types.find((x) => x !== "null") ?? types[0];
  switch (t) {
    case "string": {
      const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
      if (schema.format === "date" || pattern.includes("\\d{4}-\\d{2}") || /date$/i.test(name)) {
        return "2026-11-10";
      }
      if (pattern.includes("[A-Z]{3}") || /currency/i.test(name)) return "USD";
      if (pattern.includes("\\d") || DECIMAL_HINT.test(name)) return "125.00";
      if (/email/i.test(name)) return "name@example.com";
      return name ? `Sample ${name}` : "Sample text";
    }
    case "integer":
      return 3;
    case "number":
      return 12.5;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const items = isPlainObject(schema.items) ? (schema.items as JsonSchema) : undefined;
      return [sampleFromSchema(items, name, depth + 1), sampleFromSchema(items, name, depth + 1)];
    }
    case "object": {
      const props = isPlainObject(schema.properties)
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
      return Object.fromEntries(
        Object.entries(props).map(([k, s]) => [k, sampleFromSchema(s, k, depth + 1)]),
      );
    }
    default:
      return name ? `Sample ${name}` : null;
  }
}
