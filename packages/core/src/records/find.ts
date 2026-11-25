// Find (docs/step-model-plan.md §10f, part 2): typed filters, grouping and totals over one client's
// records of a type, following declared links across record types and areas. Read only. It works
// like "Filter, group and total a list" (packages/agents `data.list.group`), whose rules, grouping
// and decimal totals it reuses: a person's words become this typed query (the Builder and Suggest
// write it as they write any step's input), never SQL.
//
// Pure: the query's shape and its checks against the record types. The Find tool runs it.

import { z } from "zod";
import type { Field } from "../steps/schema";
import { type CustomFieldDef, customFieldAsField } from "./custom-fields";
import { type RecordType, recordFields } from "./record-type";

/** A field of a record, by dots: `total`, or a followed link's field `vendor.name`. */
export const FindField = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/, "a field, by dots");

const Scalar = z.union([z.string().max(200), z.number(), z.boolean()]);
const NumberLike = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/, "a number")]);

/** One rule a record must meet to be found; every rule must hold. As `data.list.group`'s. */
export const FindRule = z.discriminatedUnion("op", [
  z.strictObject({ field: FindField, op: z.enum(["equals", "notEquals"]), value: Scalar }),
  z.strictObject({
    field: FindField,
    op: z.enum(["atLeast", "moreThan", "atMost", "lessThan"]),
    value: NumberLike,
  }),
  z.strictObject({ field: FindField, op: z.enum(["isSet", "isNotSet"]) }),
  z.strictObject({
    field: FindField,
    op: z.literal("daysAgoAtLeast"),
    value: z.number().int().min(0).max(36500),
  }),
]);
export type FindRule = z.infer<typeof FindRule>;

/** The most records one Find reads. */
export const FIND_MAX = 5000;

export const FindQuery = z.strictObject({
  where: z.array(FindRule).max(10).default([]),
  /** Links to follow (one step): each found record carries the linked record under its name. */
  follow: z
    .array(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/))
    .max(5)
    .default([]),
  groupBy: FindField.optional(),
  totals: z
    .array(
      z.strictObject({
        field: FindField,
        as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/),
      }),
    )
    .max(10)
    .default([]),
  minTotal: z.strictObject({ total: z.string(), atLeast: NumberLike }).optional(),
  /** The most records handed on (after the rules); the newest first. */
  limit: z.number().int().min(1).max(FIND_MAX).default(200),
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type FindQuery = z.infer<typeof FindQuery>;

/**
 * The fields of a type's records, as a client has them: built-in, then the client's visible
 * custom fields.
 */
export function clientRecordFields(
  type: Pick<RecordType, "fields" | "name">,
  custom: readonly CustomFieldDef[] = [],
): Field[] {
  return [...recordFields(type), ...custom.map(customFieldAsField)];
}

/**
 * The record types a Find reads: its own and each one it follows. The gate checks the agent's
 * read grant on every one of them.
 */
export function findReads(
  type: Pick<RecordType, "id" | "links">,
  query: Pick<FindQuery, "follow">,
): string[] {
  const out = new Set([type.id]);
  for (const name of query.follow) {
    const link = type.links.find((l) => l.name === name);
    if (link) out.add(link.to);
  }
  return [...out];
}

/**
 * What a Find asks that its records don't have, in plain words (empty: none). `fieldsOf` gives a
 * record type's fields as this client has them (custom fields included).
 */
export function findQueryProblems(
  type: Pick<RecordType, "id" | "links" | "fields" | "name">,
  query: FindQuery,
  fieldsOf: (recordType: string) => readonly Field[] | undefined,
): string[] {
  const out: string[] = [];
  const own = fieldsOf(type.id) ?? [];
  const followed = new Map<string, readonly Field[]>();
  for (const name of query.follow) {
    const link = type.links.find((l) => l.name === name);
    if (!link) {
      out.push(`${type.name} has no link ${name}`);
      continue;
    }
    const fields = fieldsOf(link.to);
    if (!fields) out.push(`there is no record type ${link.to}`);
    else followed.set(name, fields);
  }
  const known = (path: string): boolean => {
    const [head, ...rest] = path.split(".");
    if (head === undefined) return false;
    const linked = followed.get(head);
    if (linked) return rest.length === 0 || fieldAt(linked, rest);
    return fieldAt(own, [head, ...rest]);
  };
  for (const r of query.where) if (!known(r.field)) out.push(`there is no field ${r.field}`);
  if (query.groupBy && !known(query.groupBy)) out.push(`there is no field ${query.groupBy}`);
  for (const t of query.totals) if (!known(t.field)) out.push(`there is no field ${t.field}`);
  if (query.minTotal && !query.totals.some((t) => t.as === query.minTotal?.total)) {
    out.push(`the minimum names ${query.minTotal.total}, which isn't one of the totals`);
  }
  return out;
}

function fieldAt(fields: readonly Field[], path: readonly string[]): boolean {
  const [head, ...rest] = path;
  const f = fields.find((x) => x.name === head);
  if (!f) return false;
  if (rest.length === 0) return true;
  // A group's fields by dots.
  if (f.type === "group" && f.of) return fieldAt(f.of, rest);
  return false;
}
