// Filter, group and total a list (owner, 2026-11-17; QA on staging, third run): the built-in
// deterministic skill a finance agent needs between reading a list and acting on it. Keep the items
// a few rules allow (an amount over, a date at least so many days ago, a field set), group them by
// one field (customer, vendor, account), total chosen fields per group in decimals (invariant 6),
// and keep only groups whose total reaches a minimum. Pure code over its input: no model, no
// write, the same answer every time, so it runs on the test bench.
//
// Its own skill, not more Reshape data: Reshape's set of expressions stays small on purpose
// (owner, 2026-11-11: "anything more is a skill of its own"). Reshape maps one value at a time;
// this works on a whole list.

import { Decimal, lazy, lazyObject, type SkillDefinition } from "@countersign/core";
import { z } from "zod";
import { defineInternalTool, type InternalTool } from "./types";

export const GROUP_LIST_SKILL = "data.group-list";
export const GROUP_LIST_TOOL = "data.list.group";

/** A field of an item, by dots (`customer.id`, `balance`). */
const FieldPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,5}$/, "a field, by dots")
  .describe("A field of each item, by dots: customer.id, balance");

const Scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

/** One rule an item must meet to be kept. Every rule must hold. */
export const KeepRule = z.discriminatedUnion("op", [
  z.object({
    field: FieldPath,
    op: z.enum(["equals", "notEquals"]),
    value: Scalar,
  }),
  z.object({
    field: FieldPath,
    op: z.enum(["atLeast", "moreThan", "atMost", "lessThan"]),
    value: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, "a number")]),
  }),
  z.object({ field: FieldPath, op: z.enum(["isSet", "isNotSet"]) }),
  z.object({
    field: FieldPath,
    op: z.literal("daysAgoAtLeast"),
    value: z.number().int().min(0).max(36500).describe("Whole days before asOf"),
  }),
]);
export type KeepRule = z.infer<typeof KeepRule>;

export const GroupListInput = z.object({
  items: z
    .array(z.record(z.string(), z.unknown()))
    .max(5000)
    .describe("The list: each item an object (an invoice, a bill, a transaction)"),
  keep: z
    .array(KeepRule)
    .max(10)
    .default([])
    .describe("Rules an item must meet to be kept, all of them; none keeps every item"),
  groupBy: FieldPath.optional().describe(
    "The field to group by (customer.id); leave out for one group of everything kept",
  ),
  totals: z
    .array(
      z.object({
        field: FieldPath,
        as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/, "a name"),
      }),
    )
    .max(10)
    .default([])
    .describe("Fields summed per group, in decimals, each under a name (balance as owed)"),
  minTotal: z
    .object({
      total: z.string().describe("One of the totals' names"),
      atLeast: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, "a number")]),
    })
    .optional()
    .describe("Keep only groups whose total reaches this"),
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "a date, YYYY-MM-DD")
    .optional()
    .describe("The day 'days ago' counts from; today (UTC) when left out"),
});
export type GroupListInput = z.input<typeof GroupListInput>;

const Group = z.object({
  key: z.string().describe("The group field's value, as text"),
  count: z.number().int(),
  totals: z.record(z.string(), z.string()).describe("Each total, as a decimal string"),
  items: z.array(z.record(z.string(), z.unknown())),
});

export const GroupListOutput = z.object({
  groups: z.array(Group),
  groupCount: z.number().int(),
  keptCount: z.number().int().describe("Items kept by the rules"),
  droppedCount: z.number().int().describe("Items the rules left out"),
  noKey: z
    .array(z.record(z.string(), z.unknown()))
    .describe("Kept items with no value in the group field (a customer with no email)"),
  belowMinimum: z.number().int().describe("Groups left out for a total under the minimum"),
});
export type GroupListOutput = z.infer<typeof GroupListOutput>;

function at(item: unknown, path: string): unknown {
  let v: unknown = item;
  for (const key of path.split(".")) {
    if (typeof v !== "object" || v === null || !Object.hasOwn(v, key)) return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}

const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

function decimal(v: unknown): Decimal | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Decimal(String(v));
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return new Decimal(v.trim());
  if (typeof v === "object" && v !== null && "amount" in v)
    return decimal((v as { amount: unknown }).amount);
  return null;
}

const DAY = 86_400_000;

function dayOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function keeps(item: unknown, rule: KeepRule, asOf: number): boolean {
  const v = at(item, rule.field);
  switch (rule.op) {
    case "equals":
      return String(v) === String(rule.value);
    case "notEquals":
      return String(v) !== String(rule.value);
    case "isSet":
      return isSet(v);
    case "isNotSet":
      return !isSet(v);
    case "daysAgoAtLeast": {
      const day = dayOf(v);
      return day !== null && (asOf - day) / DAY >= rule.value;
    }
    default: {
      const a = decimal(v);
      if (!a) return false;
      const b = new Decimal(String(rule.value));
      if (rule.op === "atLeast") return a.gte(b);
      if (rule.op === "moreThan") return a.gt(b);
      if (rule.op === "atMost") return a.lte(b);
      return a.lt(b);
    }
  }
}

/** The work, as a function: what the tool runs and what tests call. */
export function groupList(raw: GroupListInput, today = new Date()): GroupListOutput {
  const input = GroupListInput.parse(raw);
  const asOf =
    dayOf(input.asOf) ?? Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const kept = input.items.filter((item) => input.keep.every((r) => keeps(item, r, asOf)));
  const noKey: Record<string, unknown>[] = [];
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const item of kept) {
    const key = input.groupBy ? at(item, input.groupBy) : "all";
    if (!isSet(key)) {
      noKey.push(item);
      continue;
    }
    const k = typeof key === "object" ? JSON.stringify(key) : String(key);
    byKey.set(k, [...(byKey.get(k) ?? []), item]);
  }
  const groups = [...byKey.entries()].map(([key, items]) => ({
    key,
    count: items.length,
    totals: Object.fromEntries(
      input.totals.map((t) => [
        t.as,
        items
          .reduce((sum, i) => sum.plus(decimal(at(i, t.field)) ?? new Decimal(0)), new Decimal(0))
          .toFixed(),
      ]),
    ),
    items,
  }));
  const min = input.minTotal;
  const shown = min
    ? groups.filter((g) => {
        const total = g.totals[min.total];
        return total !== undefined && new Decimal(total).gte(new Decimal(String(min.atLeast)));
      })
    : groups;
  return {
    groups: shown,
    groupCount: shown.length,
    keptCount: kept.length,
    droppedCount: input.items.length - kept.length,
    noKey,
    belowMinimum: groups.length - shown.length,
  };
}

export const groupListTool: InternalTool = defineInternalTool({
  id: GROUP_LIST_TOOL,
  description:
    "Filters a list, groups it by one field and totals fields per group: keeps the items every rule allows (equals, at least or less than a number, set or not set, a date at least N days ago), groups the kept items by a field (customer, vendor, account), sums chosen fields per group in decimals, and keeps only groups whose total reaches a minimum. Returns the groups with their items, the kept items with no group value, and counts. Reads only its input; no model.",
  sideEffect: "none",
  pure: true,
  summary: "{{keptCount}} kept in {{groupCount}} groups",
  input: GroupListInput,
  output: GroupListOutput,
  async run(input) {
    return groupList(input);
  },
});

// Worker startup (2026-11-11): the JSON Schemas are made on first read, as the docs skills' are.
const json = (tool: InternalTool, key: "input" | "output") =>
  lazy(() => tool.spec[key] as Record<string, unknown>);

export const GROUP_LIST_SKILL_DEF: SkillDefinition = lazyObject({
  schemaVersion: 1,
  id: GROUP_LIST_SKILL,
  name: "Filter, group and total a list",
  description:
    "Takes a list (invoices, bills, transactions) and keeps the items that meet every rule (an amount at least or under a number, a field equal or set, a date at least N days ago), groups them by one field (customer, vendor, account), totals chosen fields per group in decimals, and drops groups under a minimum total. Gives the groups with their items and totals, the items with no group value, and counts. The same every time; no model.",
  category: "data",
  mode: "tool",
  handler: GROUP_LIST_TOOL,
  tools: [GROUP_LIST_TOOL],
  input: json(groupListTool, "input"),
  output: json(groupListTool, "output"),
  settings: [],
  summary: "{{keptCount}} kept in {{groupCount}} groups",
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
});

export const GROUP_LIST_SKILLS: readonly SkillDefinition[] = [GROUP_LIST_SKILL_DEF];
