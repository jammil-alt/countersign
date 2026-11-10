// The skill model (owner, 2026-11-10): a deterministic skill's rule rows, evaluated. Rows are tried
// top to bottom and the first whose conditions all hold sets the output: its fixed values (`set`)
// and its calculations (`compute`). Conditions compare input fields, parameters and today's date
// (=, !=, <, <=, >, >=, between, in a list, days between two dates); calculations copy a field,
// add, subtract, take a percent change or name a parameter's bucket. Pure: no I/O, no clock (the
// caller passes today), no code and nothing that executes text. Money and decimals are decimal.js
// (invariant 6), never JS floats.

import { Decimal } from "../money";
import { evaluateRules } from "../rules/compile";
import type { JsonSchema } from "../schemas/common";
import type { SkillDefinition, SkillRule } from "../schemas/skill";
import {
  type SkillBucket,
  type SkillCompute,
  type SkillCondition,
  type SkillOperand,
  type SkillValue,
  valueInputs,
} from "../schemas/skill-model";
import { resolvePath } from "../template/template";
import { schemaAtPath } from "../template/typer";

/** What a rule row reads. */
export interface SkillRuleContext {
  /** The skill's input (already checked against its input schema). */
  input: unknown;
  /** The parameter values this use runs with (`resolveSkillParameters`). */
  parameters: Readonly<Record<string, unknown>>;
  /** Today, `YYYY-MM-DD`, injected by the caller (the run's clock). */
  today: string;
}

/** The row that matched and the output it gives. */
export interface SkillRuleResult {
  ruleId: string;
  output: Record<string, unknown>;
}

// ── Values ───────────────────────────────────────────────────────────────────────────────────

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function operand(o: SkillOperand, ctx: SkillRuleContext): unknown {
  if ("input" in o) return resolvePath(ctx.input, o.input.split("."));
  if ("parameter" in o) return ctx.parameters[o.parameter];
  if ("today" in o) return ctx.today;
  return o.value;
}

/** A value as the rows read it; undefined when a field or parameter isn't there. */
export function evaluateSkillValue(v: SkillValue, ctx: SkillRuleContext): unknown {
  if ("daysBetween" in v) {
    const from = dayNumber(operand(v.daysBetween.from, ctx));
    const to = dayNumber(operand(v.daysBetween.to, ctx));
    return from === null || to === null ? null : to - from;
  }
  return operand(v, ctx);
}

/** A date (`2026-11-10`, or a timestamp's date as written) as whole days since 1970. */
// DECISION: a timestamp counts by the date written in it (`2026-11-10T23:00:00-05:00` is the 10th),
// so a due date and today compare as the client wrote and sees them, never shifted to UTC.
function dayNumber(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  // 2026-02-30 is not a date.
  if (d.getUTCDate() !== Number(m[3])) return null;
  return t / 86_400_000;
}

const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** A number as the rows count it: a JS number, a decimal string, or an amount with a currency. */
interface Num {
  value: Decimal;
  /** `number`: a JS number; `decimal`: a decimal string; else the amount's currency. */
  kind: "number" | "decimal" | { currency: string };
}

function asNum(v: unknown): Num | null {
  if (typeof v === "number")
    return Number.isFinite(v) ? { value: new Decimal(v), kind: "number" } : null;
  if (typeof v === "string") {
    return DECIMAL_TEXT.test(v.trim()) ? { value: new Decimal(v.trim()), kind: "decimal" } : null;
  }
  if (
    isPlain(v) &&
    typeof v.amount === "string" &&
    DECIMAL_TEXT.test(v.amount) &&
    typeof v.currency === "string"
  ) {
    return { value: new Decimal(v.amount), kind: { currency: v.currency } };
  }
  return null;
}

/** -1, 0, 1, or null when the two can't be compared (text with a number, two currencies). */
function compare(a: unknown, b: unknown): number | null {
  const na = asNum(a);
  const nb = asNum(b);
  if (na && nb) {
    // DECISION: two amounts compare only in one currency; an amount and a plain number compare by
    // the amount (a threshold parameter typed as a number).
    if (typeof na.kind === "object" && typeof nb.kind === "object") {
      if (na.kind.currency !== nb.kind.currency) return null;
    }
    return na.value.comparedTo(nb.value);
  }
  const da = dayNumber(a);
  const db = dayNumber(b);
  if (da !== null && db !== null) return Math.sign(da - db);
  if (typeof a === "string" && typeof b === "string") return a === b ? 0 : null;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : null;
  if (a === null && b === null) return 0;
  return null;
}

function equal(a: unknown, b: unknown): boolean {
  const c = compare(a, b);
  if (c !== null) return c === 0;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a condition holds. A condition that reads a missing field or parameter (undefined)
 * never holds, `!=` included: a row can't match on what the input doesn't say.
 */
export function evaluateSkillCondition(c: SkillCondition, ctx: SkillRuleContext): boolean {
  const left = evaluateSkillValue(c.left, ctx);
  if (left === undefined) return false;
  if (c.op === "between") {
    const from = evaluateSkillValue(c.from, ctx);
    const to = evaluateSkillValue(c.to, ctx);
    const lo = compare(left, from);
    const hi = compare(left, to);
    return lo !== null && hi !== null && lo >= 0 && hi <= 0;
  }
  if (c.op === "in") {
    const list = evaluateSkillValue(c.list, ctx);
    return Array.isArray(list) && list.some((x) => equal(left, x));
  }
  const right = evaluateSkillValue(c.right, ctx);
  if (right === undefined) return false;
  if (c.op === "=") return equal(left, right);
  if (c.op === "!=") return !equal(left, right);
  const cmp = compare(left, right);
  if (cmp === null) return false;
  switch (c.op) {
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
  }
}

// ── Calculations ─────────────────────────────────────────────────────────────────────────────

/**
 * A result in the operands' own form: all JS numbers give a number; amounts in one currency an
 * amount in it; anything else a decimal string. Never a float from decimal arithmetic.
 */
function shaped(value: Decimal, kinds: readonly Num["kind"][]): unknown {
  if (kinds.every((k) => k === "number")) return value.toNumber();
  const currencies = new Set(kinds.map((k) => (typeof k === "object" ? k.currency : null)));
  const [only] = currencies;
  if (currencies.size === 1 && typeof only === "string") {
    return { amount: value.toDecimalPlaces(4).toFixed(4), currency: only };
  }
  return value.toDecimalPlaces(4).toFixed();
}

function nums(values: readonly SkillValue[], ctx: SkillRuleContext): Num[] | null {
  const out: Num[] = [];
  for (const v of values) {
    const n = asNum(evaluateSkillValue(v, ctx));
    if (!n) return null;
    out.push(n);
  }
  // Amounts in two currencies don't add up.
  const currencies = new Set(
    out.flatMap((n) => (typeof n.kind === "object" ? [n.kind.currency] : [])),
  );
  return currencies.size > 1 ? null : out;
}

/** The bucket's label a number falls in: the first bucket from `from` to `to`, both included. */
export function bucketLabel(value: unknown, buckets: unknown): string | null {
  const n = asNum(value);
  if (!n || !Array.isArray(buckets)) return null;
  for (const b of buckets as SkillBucket[]) {
    if (n.value.lt(b.from)) continue;
    if (b.to !== undefined && n.value.gt(b.to)) continue;
    return b.label;
  }
  return null;
}

/** A calculation's value; null when its operands aren't numbers (or dates, for days between). */
export function evaluateSkillCompute(c: SkillCompute, ctx: SkillRuleContext): unknown {
  if ("sum" in c) {
    const ns = nums(c.sum, ctx);
    if (!ns) return null;
    return shaped(
      ns.reduce((acc, n) => acc.plus(n.value), new Decimal(0)),
      ns.map((n) => n.kind),
    );
  }
  if ("difference" in c) {
    const ns = nums(c.difference, ctx);
    if (ns?.length !== 2) return null;
    const [a, b] = ns as [Num, Num];
    return shaped(
      a.value.minus(b.value),
      ns.map((n) => n.kind),
    );
  }
  if ("percentChange" in c) {
    const ns = nums([c.percentChange.from, c.percentChange.to], ctx);
    if (!ns) return null;
    const [from, to] = ns as [Num, Num];
    if (from.value.isZero()) return null;
    // DECISION: a percent change is rounded to 2 places and is a plain number or decimal string,
    // never an amount: (to − from) ÷ |from| × 100.
    const pct = to.value.minus(from.value).div(from.value.abs()).times(100).toDecimalPlaces(2);
    const plain = ns.every((n) => n.kind === "number");
    return plain ? pct.toNumber() : pct.toFixed();
  }
  if ("bucket" in c) {
    return bucketLabel(evaluateSkillValue(c.bucket.value, ctx), ctx.parameters[c.bucket.by]);
  }
  const v = evaluateSkillValue(c, ctx);
  return v === undefined ? null : v;
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────

/** Whether a row's `when` and every one of its conditions hold. */
export function skillRuleMatches(row: SkillRule, ctx: SkillRuleContext): boolean {
  if (row.when && row.when.rules.length > 0) {
    const data = { input: ctx.input, parameters: ctx.parameters, today: ctx.today };
    if (!evaluateRules(row.when, data)) return false;
  }
  return (row.conditions ?? []).every((c) => evaluateSkillCondition(c, ctx));
}

/**
 * The first row that matches, and the output it sets (its fixed values, then its calculations);
 * null when no row matches.
 */
export function evaluateSkillRules(
  rows: readonly SkillRule[],
  ctx: SkillRuleContext,
): SkillRuleResult | null {
  for (const row of rows) {
    if (!skillRuleMatches(row, ctx)) continue;
    const output: Record<string, unknown> = { ...(row.set ?? {}) };
    for (const [field, c] of Object.entries(row.compute ?? {})) {
      output[field] = evaluateSkillCompute(c, ctx);
    }
    return { ruleId: row.id, output };
  }
  return null;
}

/** Today in a time zone, `YYYY-MM-DD` (UTC when the zone is absent or unknown). */
export function isoToday(now: Date, tz?: string): string {
  try {
    if (tz) {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    }
  } catch {
    // An unknown zone reads as UTC.
  }
  return now.toISOString().slice(0, 10);
}

// ── Static checks (a new skill version) ──────────────────────────────────────────────────────

function properties(schema: JsonSchema): Record<string, unknown> | null {
  const p = schema.properties;
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
}

function rowValues(row: SkillRule): SkillValue[] {
  const out: SkillValue[] = [];
  for (const c of row.conditions ?? []) {
    out.push(c.left);
    if ("right" in c) out.push(c.right);
    if ("from" in c) out.push(c.from, c.to);
    if ("list" in c) out.push(c.list);
  }
  for (const c of Object.values(row.compute ?? {})) {
    if ("sum" in c) out.push(...c.sum);
    else if ("difference" in c) out.push(...c.difference);
    else if ("percentChange" in c) out.push(c.percentChange.from, c.percentChange.to);
    else if ("bucket" in c) out.push(c.bucket.value);
    else out.push(c);
  }
  return out;
}

/**
 * What a skill's rule rows name that its schemas don't have: an input field its input schema
 * lacks, or an output field its output schema lacks (when they declare their fields). Parameters
 * are the definition's own check (`ruleParameterProblem`).
 */
export function skillRuleProblems(
  def: Pick<SkillDefinition, "rules" | "input" | "output">,
): string[] {
  const problems: string[] = [];
  const outProps = properties(def.output);
  for (const row of def.rules ?? []) {
    for (const v of rowValues(row)) {
      for (const path of valueInputs(v)) {
        const at = schemaAtPath(def.input, path.split("."));
        if (!at.ok) problems.push(`rule ${row.id} reads input.${path}: ${at.message}`);
      }
    }
    if (outProps) {
      for (const k of [...Object.keys(row.set ?? {}), ...Object.keys(row.compute ?? {})]) {
        if (!Object.hasOwn(outProps, k))
          problems.push(`rule ${row.id} sets ${k}, not an output field`);
      }
    }
  }
  return problems;
}
