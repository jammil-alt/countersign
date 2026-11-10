// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"): a
// skill is deterministic (typed data in, rules or built-in code, typed data out) or AI (typed data
// in, instructions and a model, JSON out). This file holds the schema parts the skill definition
// gains: named, typed **parameters** the agent sets, and the typed values, conditions and
// calculations a deterministic skill's **rule rows** use. No code and no templates that execute:
// every value is data the builder can show. The evaluator is `skills/rules.ts`.

import { z } from "zod";

// ── Parameters ───────────────────────────────────────────────────────────────────────────────

/** A parameter's name: how rule rows and the agent's settings name it. */
export const SkillParameterName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, "lowercase letters, digits and underscores, from a letter");

export const SKILL_PARAMETER_TYPES = ["number", "text", "date", "money", "buckets"] as const;
export const SkillParameterType = z.enum(SKILL_PARAMETER_TYPES);
export type SkillParameterType = z.infer<typeof SkillParameterType>;

/**
 * One bucket of a `buckets` parameter: a value from `from` to `to` (both included) takes the
 * label; the last bucket may leave `to` out (and above). "0–15 Current, 16–30 Due, 31+ Past due".
 */
export const SkillBucket = z.strictObject({
  from: z.number().finite(),
  to: z.number().finite().optional(),
  label: z.string().min(1).max(100),
});
export type SkillBucket = z.infer<typeof SkillBucket>;

/**
 * A value the agent sets for its use of the skill (aging buckets, a threshold, a cut-off date):
 * declared by the skill version, set per agent (`definition.skills[].parameters`) and per step
 * (the step's customization), checked against its type.
 */
// DECISION: a parameter without a `default` must be set by every agent that uses the skill
// (publish refuses it otherwise); one with a default may be left alone.
export const SkillParameter = z.strictObject({
  name: SkillParameterName,
  label: z.string().min(1).max(200),
  type: SkillParameterType,
  description: z.string().max(1000).optional(),
  default: z.unknown().optional(),
});
export type SkillParameter = z.infer<typeof SkillParameter>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^-?\d{1,10}(\.\d{1,4})?$/;

/** 2026-02-30 is not a date. */
function realDate(value: string): boolean {
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why `value` isn't a value of the parameter's type, in plain words; null when it is. */
export function parameterValueProblem(
  param: Pick<SkillParameter, "name" | "type">,
  value: unknown,
): string | null {
  const name = param.name;
  switch (param.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${name} is a number`;
    case "text":
      return typeof value === "string" && value.length <= 2000
        ? null
        : `${name} is text (at most 2,000 characters)`;
    case "date":
      return typeof value === "string" && ISO_DATE.test(value) && realDate(value)
        ? null
        : `${name} is a date such as 2026-12-24`;
    case "money":
      return isPlain(value) &&
        typeof value.amount === "string" &&
        DECIMAL.test(value.amount) &&
        typeof value.currency === "string" &&
        /^[A-Z]{3}$/.test(value.currency) &&
        Object.keys(value).length === 2
        ? null
        : `${name} is an amount and a currency, such as { "amount": "500.00", "currency": "USD" }`;
    case "buckets":
      return bucketsProblem(name, value);
  }
}

/**
 * Buckets are 1 to 20, in order, without overlaps: each starts after the one before ends, each
 * ends at or after it starts, and only the last may be open-ended.
 */
function bucketsProblem(name: string, value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return `${name} is a list of 1 to 20 buckets`;
  }
  let prevTo: number | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const parsed = SkillBucket.safeParse(value[i]);
    if (!parsed.success) return `${name}: bucket ${i + 1} needs a from, a label and maybe a to`;
    const b = parsed.data;
    if (b.to !== undefined && b.to < b.from) {
      return `${name}: bucket ${i + 1} ("${b.label}") ends before it starts`;
    }
    if (i > 0 && (prevTo === undefined || b.from <= prevTo)) {
      return `${name}: bucket ${i + 1} ("${b.label}") overlaps the one before; start it after ${prevTo ?? "the end"}`;
    }
    if (b.to === undefined && i < value.length - 1) {
      return `${name}: only the last bucket can be open-ended ("${b.label}" has no end)`;
    }
    prevTo = b.to;
  }
  return null;
}

// ── Rule rows: values, conditions, calculations ──────────────────────────────────────────────

/** A field of the skill's input, dotted (`invoice.dueDate`, `lines.0.amount`). */
export const SkillInputPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, "an input field, such as invoice.dueDate");

/** A literal: text, a number, true or false, null, or a list of those. */
const Scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const SkillLiteral = z.union([Scalar, z.array(Scalar).max(200)]);
export type SkillLiteral = z.infer<typeof SkillLiteral>;

/** A value a condition or a calculation reads: an input field, a parameter, today, or a literal. */
export const SkillOperand = z.union([
  z.strictObject({ input: SkillInputPath }),
  z.strictObject({ parameter: SkillParameterName }),
  z.strictObject({ today: z.literal(true) }),
  z.strictObject({ value: SkillLiteral }),
]);
export type SkillOperand = z.infer<typeof SkillOperand>;

/** An operand, or the whole days from one date to another (`to` minus `from`). */
export const SkillValue = z.union([
  SkillOperand,
  z.strictObject({ daysBetween: z.strictObject({ from: SkillOperand, to: SkillOperand }) }),
]);
export type SkillValue = z.infer<typeof SkillValue>;

export const SKILL_COMPARE_OPS = ["=", "!=", "<", "<=", ">", ">="] as const;

/**
 * One condition of a rule row: compare, between (both ends included), or in a list. Numbers,
 * amounts and decimal strings compare as decimals; dates as dates; anything else must be equal.
 */
export const SkillCondition = z.union([
  z.strictObject({ left: SkillValue, op: z.enum(SKILL_COMPARE_OPS), right: SkillValue }),
  z.strictObject({ left: SkillValue, op: z.literal("between"), from: SkillValue, to: SkillValue }),
  z.strictObject({ left: SkillValue, op: z.literal("in"), list: SkillValue }),
]);
export type SkillCondition = z.infer<typeof SkillCondition>;

/**
 * What a rule row sets an output field to beyond a fixed value: a value (a copied input field, a
 * parameter, today, days between two dates), a sum, a difference (`[a, b]`: a minus b), a percent
 * change (from → to), or the label of the parameter's bucket a value falls in.
 */
export const SkillCompute = z.union([
  SkillValue,
  z.strictObject({ sum: z.array(SkillValue).min(1).max(20) }),
  z.strictObject({ difference: z.tuple([SkillValue, SkillValue]) }),
  z.strictObject({ percentChange: z.strictObject({ from: SkillValue, to: SkillValue }) }),
  z.strictObject({ bucket: z.strictObject({ value: SkillValue, by: SkillParameterName }) }),
]);
export type SkillCompute = z.infer<typeof SkillCompute>;

/** Every parameter a value, condition or calculation names, with whether it buckets by it. */
export function computeParameters(c: SkillCompute): { name: string; bucket: boolean }[] {
  if ("bucket" in c) {
    return [{ name: c.bucket.by, bucket: true }, ...valueParameters(c.bucket.value)];
  }
  if ("sum" in c) return c.sum.flatMap(valueParameters);
  if ("difference" in c) return c.difference.flatMap(valueParameters);
  if ("percentChange" in c) {
    return [...valueParameters(c.percentChange.from), ...valueParameters(c.percentChange.to)];
  }
  return valueParameters(c);
}

export function valueParameters(v: SkillValue): { name: string; bucket: boolean }[] {
  if ("daysBetween" in v) {
    return [...valueParameters(v.daysBetween.from), ...valueParameters(v.daysBetween.to)];
  }
  return "parameter" in v ? [{ name: v.parameter, bucket: false }] : [];
}

export function conditionParameters(c: SkillCondition): { name: string; bucket: boolean }[] {
  const out = [...valueParameters(c.left)];
  if ("right" in c) out.push(...valueParameters(c.right));
  if ("from" in c) out.push(...valueParameters(c.from), ...valueParameters(c.to));
  if ("list" in c) out.push(...valueParameters(c.list));
  return out;
}

/** Every input field a value names. */
export function valueInputs(v: SkillValue): string[] {
  if ("daysBetween" in v) {
    return [...valueInputs(v.daysBetween.from), ...valueInputs(v.daysBetween.to)];
  }
  return "input" in v ? [v.input] : [];
}
