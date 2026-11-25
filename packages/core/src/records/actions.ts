// The standard actions on every record type (docs/step-model-plan.md §10f, part 2): Find, Get by
// id, Create and Update, offered under the record type's area beside the area's own actions. Each
// is a tool spec made from the record type's declaration and the client's custom fields, so the
// action catalog (`steps.buildActionCatalog`, unchanged) offers it like any other action, the
// Input picker and the automatic translation read its fields, and the gate reads its `record`.
//
// Pure. Bespoke actions (Register lines writes several record types together) stay as they are.

import type { JsonSchema } from "../schemas/common";
import type { ToolSpec } from "../schemas/tool";
import type { Field } from "../steps/schema";
import { type CustomFieldDef, customFieldAsField } from "./custom-fields";
import { FIND_MAX } from "./find";
import { type RecordType, recordFields, recordTypeAllows } from "./record-type";

export const RECORD_ACTIONS = ["find", "get", "create", "update"] as const;
export type RecordAction = (typeof RECORD_ACTIONS)[number];

/** The prefix of every record action's id (`records.vendor.find`). */
export const RECORD_ACTION_PREFIX = "records.";

/** A record action's id. */
export function recordActionId(recordType: string, action: RecordAction): string {
  return `${RECORD_ACTION_PREFIX}${recordType}.${action}`;
}

/** The record type and action an id names, if it is a record action's. */
export function parseRecordActionId(
  id: string,
): { recordType: string; action: RecordAction } | null {
  const m = /^records\.([a-z][a-z0-9_]{0,39})\.(find|get|create|update)$/.exec(id);
  return m ? { recordType: m[1] as string, action: m[2] as RecordAction } : null;
}

/** A field's JSON schema, as a tool's input and output are written. */
export function fieldJsonSchema(field: Field): JsonSchema {
  const about = field.about ? { description: field.about } : {};
  switch (field.type) {
    case "text":
      return { type: "string", ...about };
    case "number":
      return { type: ["number", "string"], ...about };
    case "money":
      // Invariant 6: a decimal string.
      return {
        type: "string",
        pattern: "^-?\\d+(\\.\\d{1,4})?$",
        description: field.about ?? "Money, as a decimal string",
      };
    case "date":
      return { type: "string", format: "date", ...about };
    case "yes_no":
      return { type: "boolean", ...about };
    case "record":
      return {
        type: "string",
        format: "uuid",
        description: field.about ?? `A ${field.record ?? "record"}'s id`,
      };
    case "group":
      return { ...objectSchema(field.of ?? [], false), ...about };
    case "list":
      return { type: "array", items: objectSchema(field.of ?? [], false), ...about };
  }
}

function objectSchema(fields: readonly Field[], requireAll: boolean): JsonSchema {
  const required = fields.filter((f) => requireAll || f.required).map((f) => f.name);
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((f) => [f.name, fieldJsonSchema(f)])),
    ...(required.length > 0 ? { required } : {}),
  };
}

const RULE_OPS = [
  "equals",
  "notEquals",
  "atLeast",
  "moreThan",
  "atMost",
  "lessThan",
  "isSet",
  "isNotSet",
  "daysAgoAtLeast",
];

function findInput(type: RecordType): JsonSchema {
  const links = type.links.map((l) => l.name);
  return {
    type: "object",
    properties: {
      where: {
        type: "array",
        description:
          "Rules every record must meet: a field (by dots, a followed link's as vendor.name), an op, and a value",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            op: { type: "string", enum: RULE_OPS },
            value: { type: ["string", "number", "boolean"] },
          },
          required: ["field", "op"],
        },
      },
      follow: {
        type: "array",
        description: "Links to follow; each record then carries the linked record under its name",
        items: links.length > 0 ? { type: "string", enum: links } : { type: "string" },
      },
      groupBy: { type: "string", description: "The field to group by; leave out for no groups" },
      totals: {
        type: "array",
        description: "Fields summed per group, in decimals, each under a name",
        items: {
          type: "object",
          properties: { field: { type: "string" }, as: { type: "string" } },
          required: ["field", "as"],
        },
      },
      minTotal: {
        type: "object",
        description: "Keep only groups whose total reaches this",
        properties: { total: { type: "string" }, atLeast: { type: ["number", "string"] } },
        required: ["total", "atLeast"],
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: FIND_MAX,
        description: "The most records handed on, newest first (200 when left out)",
      },
      asOf: { type: "string", format: "date", description: "The day 'days ago' counts from" },
    },
  };
}

function findOutput(record: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      items: { type: "array", items: record, description: "The records found, newest first" },
      count: { type: "integer", description: "Records found" },
      groups: {
        type: "array",
        description: "Each group's key, count, totals (decimal strings) and records",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            count: { type: "integer" },
            totals: { type: "object" },
            items: { type: "array", items: record },
          },
        },
      },
      totals: { type: "object", description: "The totals over every record found" },
      truncated: {
        type: "boolean",
        description: `More than ${FIND_MAX} records: only the newest were read`,
      },
    },
    required: ["items", "count", "groups", "truncated"],
  };
}

const SOURCES: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "The ids of the records this write rests on (its evidence)",
};

/**
 * A record type's standard actions as tool specs, for one client's custom fields (none: the
 * deployment's specs, as the tool registry holds them). Create and Update only where the record
 * type allows them.
 */
export function recordActionSpecs(
  type: RecordType,
  custom: readonly CustomFieldDef[] = [],
): ToolSpec[] {
  const fields = [...recordFields(type), ...custom.map(customFieldAsField)];
  const record = objectSchema(fields, false);
  const lower = type.name.toLowerCase();
  const plural = type.plural.toLowerCase();
  const links = Object.fromEntries(type.links.map((l) => [l.name, l.to]));
  const base = {
    source: "platform",
    area: type.area,
    entity: type.id,
  } as const;
  const writable = [
    ...type.fields.filter((f) => type.writable.includes(f.name)),
    ...custom.map(customFieldAsField),
  ];
  const specs: ToolSpec[] = [
    {
      ...base,
      id: recordActionId(type.id, "find"),
      description: `Finds this client's ${plural} by typed rules, optionally following their links (${
        type.links.map((l) => l.name).join(", ") || "none"
      }), grouped by a field with totals in decimals. Reads only; no model.`,
      input: findInput(type),
      output: findOutput(record),
      sideEffect: "none",
      verb: "read",
      summary: `{{count}} ${plural} found`,
      record: { type: type.id, action: "find", links },
    },
    {
      ...base,
      id: recordActionId(type.id, "get"),
      description: `Gets one of this client's ${plural} by its id.`,
      input: {
        type: "object",
        properties: { id: { type: "string", format: "uuid", description: `The ${lower}'s id` } },
        required: ["id"],
      },
      output: record,
      sideEffect: "none",
      verb: "read",
      record: { type: type.id, action: "get" },
    },
  ];
  if (recordTypeAllows(type, "create")) {
    const input = objectSchema(writable, false);
    specs.push({
      ...base,
      id: recordActionId(type.id, "create"),
      description: `Creates a ${lower} in this client's records, checked by the ${lower}'s rules and logged with its evidence. Saved once, however often the step is tried.`,
      input: {
        ...input,
        properties: { ...(input.properties as object), sources: SOURCES },
      },
      output: record,
      sideEffect: "internal",
      verb: "create",
      summary: `Created a ${lower}`,
      record: { type: type.id, action: "create" },
    });
  }
  if (recordTypeAllows(type, "update")) {
    const input = objectSchema(
      writable.map((f) => ({ ...f, required: false })),
      false,
    );
    specs.push({
      ...base,
      id: recordActionId(type.id, "update"),
      description: `Changes fields of one of this client's ${plural}, checked by the ${lower}'s rules and logged with its before state and evidence. Fields left out stay as they are; an empty value clears a custom field.`,
      input: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", description: `The ${lower}'s id` },
          ...(input.properties as object),
          sources: SOURCES,
        },
        required: ["id"],
      },
      output: record,
      sideEffect: "internal",
      verb: "update",
      summary: `Changed a ${lower}`,
      record: { type: type.id, action: "update" },
    });
  }
  return specs;
}

/** The built-in fields and custom fields a Create or Update may set, by name. */
export function writableFieldNames(
  type: Pick<RecordType, "writable">,
  custom: readonly CustomFieldDef[],
): Set<string> {
  return new Set([...type.writable, ...custom.map((c) => c.name)]);
}
