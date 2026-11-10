// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14): a deterministic skill's rule rows as
// the editor reads and writes them. A row holds when all its conditions hold, then sets its
// outputs: a fixed value, a copied field, days between two dates, a sum, a difference, a percent
// change, or the label of the bucket a value falls in. Pure, so each shape round-trips through the
// editor unchanged; core's evaluator (`evaluateSkillRules`) is what runs them.
import type {
  SkillCompute,
  SkillCondition,
  SkillLiteral,
  SkillOperand,
  SkillRule,
  SkillValue,
} from "@countersign/core";

// ── Values ───────────────────────────────────────────────────────────────────────────────────

export type ValueKind = "input" | "parameter" | "today" | "value" | "days";

export const VALUE_KIND_LABEL: Record<ValueKind, string> = {
  input: "Input field",
  parameter: "Parameter",
  today: "Today",
  value: "A value",
  days: "Days between",
};

export function valueKind(v: SkillValue): ValueKind {
  if ("daysBetween" in v) return "days";
  if ("input" in v) return "input";
  if ("parameter" in v) return "parameter";
  if ("today" in v) return "today";
  return "value";
}

/** What the editor offers a value to read: the input's fields and the skill's parameters. */
export interface RuleScope {
  inputs: readonly string[];
  parameters: readonly { name: string; label: string; type: string }[];
}

/** A fresh value of a kind, reading the first field or parameter there is. */
export function blankValue(kind: ValueKind, scope: RuleScope): SkillValue {
  switch (kind) {
    case "input":
      return { input: scope.inputs[0] ?? "field" };
    case "parameter":
      return { parameter: scope.parameters[0]?.name ?? "parameter" };
    case "today":
      return { today: true };
    case "value":
      return { value: "" };
    case "days":
      return { daysBetween: { from: { input: scope.inputs[0] ?? "field" }, to: { today: true } } };
  }
}

/** A literal as typed: a number when it reads as one, yes/no as true/false, else text. */
export function literalFrom(text: string): SkillLiteral {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  return text;
}

/** A list as typed, separated by commas: "paid, void" → ["paid", "void"]. */
export function listFrom(text: string): SkillLiteral {
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => literalFrom(x) as string | number | boolean);
}

export function literalText(v: SkillLiteral): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ");
  return v === null ? "" : String(v);
}

function operandText(o: SkillOperand, scope?: RuleScope): string {
  if ("input" in o) return o.input;
  if ("parameter" in o) {
    return scope?.parameters.find((p) => p.name === o.parameter)?.label ?? o.parameter;
  }
  if ("today" in o) return "today";
  return Array.isArray(o.value) ? `[${literalText(o.value)}]` : JSON.stringify(o.value);
}

/** A value in words: `dueDate`, "today", "days from dueDate to today", a parameter's label. */
export function valueText(v: SkillValue, scope?: RuleScope): string {
  if ("daysBetween" in v) {
    return `days from ${operandText(v.daysBetween.from, scope)} to ${operandText(v.daysBetween.to, scope)}`;
  }
  return operandText(v, scope);
}

// ── Conditions ───────────────────────────────────────────────────────────────────────────────

export const CONDITION_OPS = ["=", "!=", "<", "<=", ">", ">=", "between", "in"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const OP_LABEL: Record<ConditionOp, string> = {
  "=": "is",
  "!=": "is not",
  "<": "is less than",
  "<=": "is at most",
  ">": "is more than",
  ">=": "is at least",
  between: "is between",
  in: "is one of",
};

/** The condition with another operator, keeping what it can of the operands. */
export function withOp(c: SkillCondition, op: ConditionOp): SkillCondition {
  const first: SkillValue =
    "right" in c ? c.right : "from" in c ? c.from : "list" in c ? c.list : { value: "" };
  if (op === "between") {
    return { left: c.left, op, from: first, to: "to" in c ? c.to : { value: "" } };
  }
  if (op === "in") return { left: c.left, op, list: "list" in c ? c.list : { value: [] } };
  return { left: c.left, op, right: first };
}

export function newCondition(scope: RuleScope): SkillCondition {
  return { left: blankValue("input", scope), op: "=", right: { value: "" } };
}

export function conditionText(c: SkillCondition, scope?: RuleScope): string {
  const left = valueText(c.left, scope);
  if ("from" in c) {
    return `${left} is between ${valueText(c.from, scope)} and ${valueText(c.to, scope)}`;
  }
  if ("list" in c) return `${left} is one of ${valueText(c.list, scope)}`;
  return `${left} ${OP_LABEL[c.op]} ${valueText(c.right, scope)}`;
}

// ── Outputs ──────────────────────────────────────────────────────────────────────────────────

export type OutputHow = "fixed" | "copy" | "sum" | "difference" | "percentChange" | "bucket";

export const OUTPUT_HOW_LABEL: Record<OutputHow, string> = {
  fixed: "A fixed value",
  copy: "Copy a value",
  sum: "Sum",
  difference: "Difference",
  percentChange: "Percent change",
  bucket: "Bucket by a parameter",
};

/** One output a row sets: a fixed value (`set`) or a calculation (`compute`). */
export type RuleOutput =
  | { field: string; how: "fixed"; value: unknown }
  | { field: string; how: Exclude<OutputHow, "fixed">; compute: SkillCompute };

export function computeHow(c: SkillCompute): Exclude<OutputHow, "fixed"> {
  if ("sum" in c) return "sum";
  if ("difference" in c) return "difference";
  if ("percentChange" in c) return "percentChange";
  if ("bucket" in c) return "bucket";
  return "copy";
}

/**
 * A row's outputs: its fixed values and its calculations, in the order of the skill's output
 * fields when given (so an output keeps its place as another changes kind), else as stored.
 */
export function ruleOutputs(
  row: Pick<SkillRule, "set" | "compute">,
  order: readonly string[] = [],
): RuleOutput[] {
  const all = [
    ...Object.entries(row.set ?? {}).map(
      ([field, value]): RuleOutput => ({ field, how: "fixed", value }),
    ),
    ...Object.entries(row.compute ?? {}).map(
      ([field, compute]): RuleOutput => ({ field, how: computeHow(compute), compute }),
    ),
  ];
  const at = (f: string) => {
    const i = order.indexOf(f);
    return i === -1 ? order.length : i;
  };
  return all
    .map((o, i) => ({ o, i }))
    .sort((a, b) => at(a.o.field) - at(b.o.field) || a.i - b.i)
    .map(({ o }) => o);
}

/** The row with these outputs: fixed values in `set`, calculations in `compute`. */
export function withOutputs<R extends Pick<SkillRule, "set" | "compute">>(
  row: R,
  outputs: readonly RuleOutput[],
): R {
  const set: Record<string, unknown> = {};
  const compute: Record<string, SkillCompute> = {};
  for (const o of outputs) {
    if (o.how === "fixed") set[o.field] = o.value;
    else compute[o.field] = o.compute;
  }
  const { set: _s, compute: _c, ...rest } = row;
  return {
    ...rest,
    ...(Object.keys(set).length ? { set } : {}),
    ...(Object.keys(compute).length ? { compute } : {}),
  } as R;
}

/** A fresh output of a kind for a field, reading the first field or bucket parameter there is. */
export function blankOutput(field: string, how: OutputHow, scope: RuleScope): RuleOutput {
  const v = blankValue("input", scope);
  switch (how) {
    case "fixed":
      return { field, how, value: "" };
    case "copy":
      return { field, how, compute: v };
    case "sum":
      return { field, how, compute: { sum: [v, blankValue("input", scope)] } };
    case "difference":
      return { field, how, compute: { difference: [v, blankValue("input", scope)] } };
    case "percentChange":
      return {
        field,
        how,
        compute: { percentChange: { from: v, to: blankValue("input", scope) } },
      };
    case "bucket": {
      const by = scope.parameters.find((p) => p.type === "buckets")?.name ?? "buckets";
      return { field, how, compute: { bucket: { value: blankValue("days", scope), by } } };
    }
  }
}

export function outputText(o: RuleOutput, scope?: RuleScope): string {
  if (o.how === "fixed") return `${o.field} = ${JSON.stringify(o.value)}`;
  const c = o.compute;
  if ("sum" in c) return `${o.field} = sum of ${c.sum.map((v) => valueText(v, scope)).join(", ")}`;
  if ("difference" in c) {
    return `${o.field} = ${valueText(c.difference[0], scope)} minus ${valueText(c.difference[1], scope)}`;
  }
  if ("percentChange" in c) {
    return `${o.field} = percent change from ${valueText(c.percentChange.from, scope)} to ${valueText(c.percentChange.to, scope)}`;
  }
  if ("bucket" in c) {
    const by = scope?.parameters.find((p) => p.name === c.bucket.by)?.label ?? c.bucket.by;
    return `${o.field} = the ${by} bucket of ${valueText(c.bucket.value, scope)}`;
  }
  return `${o.field} = ${valueText(c, scope)}`;
}

/** A row in a line: "when dueDate … then bucket = the Aging bucket of days from dueDate to today". */
export function ruleRowText(row: SkillRule, scope?: RuleScope): string {
  const when = (row.conditions ?? []).map((c) => conditionText(c, scope));
  const then = ruleOutputs(row).map((o) => outputText(o, scope));
  return `${when.length ? `when ${when.join(" and ")}` : "always"}, then ${then.join("; ")}`;
}

/** A new row's id: `row-<n>`, the first not taken (a rule id starts with a letter). */
export function newRowId(rows: readonly Pick<SkillRule, "id">[]): string {
  const taken = new Set(rows.map((r) => r.id));
  let n = rows.length + 1;
  while (taken.has(`row-${n}`)) n += 1;
  return `row-${n}`;
}
