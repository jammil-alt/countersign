// Custom fields (docs/step-model-plan.md §10f; owner, 2026-11-25: "as unique usecases come in, we
// are mapping and adding custom fields as opposed to redefining the schema"). A field is defined in
// the back office on one record type, for one client or shared, and stored on each record in its
// existing `ext` column. It is then used like a built-in field: steps' Input picker and the
// automatic translation, the Data tab, Find, grants and data sets, reports.
//
// Guardrails (§10f): a field's type never changes once it holds data; removing one hides it and
// keeps its data; about 50 per record type per client; each client's fields are its own; card
// numbers are never stored (invariant 14); values are client data under HIPAA mode (they live in
// the client's own records, never sent anywhere new).
//
// Pure: the API reads the definitions and the records, and calls these checks on every write.

import { z } from "zod";
import { redactCardNumbers } from "../compliance/card-numbers";
import { FIELD_TYPES, type Field, Fields } from "../steps/schema";
import { RESERVED_RECORD_FIELDS, type RecordType, RecordTypeId } from "./record-type";

/** The kinds of value a custom field holds: the step model's field types. */
export const CUSTOM_FIELD_TYPES = FIELD_TYPES;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** About 50 per record type per client (§10f), the client's own and the shared ones together. */
export const MAX_CUSTOM_FIELDS = 50;

/**
 * Where custom values sit in a record's `ext` column. DECISION: under `ext.custom.<name>`, not at
 * `ext`'s top level: areas already keep their own keys in `ext` (a vendor's sender domains, a bank
 * transaction's held pair), and a client's field named like one of them must never overwrite it.
 */
export const CUSTOM_EXT_KEY = "custom";

export const CustomFieldName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, "letters, digits and _, starting with a small letter");

/** A custom field's fields, before its checks (the back office's view extends it). */
export const CustomFieldBase = z.strictObject({
  id: z.string().uuid().optional(),
  recordType: RecordTypeId,
  name: CustomFieldName,
  label: z.string().trim().min(1).max(60),
  type: z.enum(CUSTOM_FIELD_TYPES),
  /** A list's or a group's fields; a record link's record type. */
  spec: z
    .strictObject({
      of: Fields.max(20).optional(),
      record: RecordTypeId.optional(),
    })
    .default({}),
  required: z.boolean().default(false),
  about: z.string().trim().max(200).default(""),
  /** This client only, or shared (offered to every client, as templates are). */
  scope: z.enum(["client", "shared"]),
  /** Removed: hidden from steps and screens, its data kept. */
  hidden: z.boolean().default(false),
});

/** A custom field as the back office defines it. */
export const CustomFieldDef = CustomFieldBase.refine(
  (f) => (f.type === "list" || f.type === "group") === (f.spec.of !== undefined),
  {
    message: "a list or a group names its fields, and only they do",
    path: ["spec", "of"],
  },
).refine((f) => (f.type === "record") === (f.spec.record !== undefined), {
  message: "a link to a record names its record type, and only it does",
  path: ["spec", "record"],
});
export type CustomFieldDef = z.infer<typeof CustomFieldDef>;

/** A custom field as a step's field: the same shape as a built-in one. */
export function customFieldAsField(def: CustomFieldDef): Field {
  const f: Field = { name: def.name, type: def.type, required: def.required };
  const about = def.about || def.label;
  if (about) f.about = about.slice(0, 200);
  if (def.spec.of) f.of = def.spec.of;
  if (def.spec.record) f.record = def.spec.record;
  return f;
}

/**
 * The fields a client's records of a type carry beyond the built-in ones: its own and the shared,
 * never hidden ones. A client's own field wins over a shared one of the same name.
 */
export function visibleCustomFields(
  defs: readonly CustomFieldDef[],
  recordType: string,
): CustomFieldDef[] {
  const own = defs.filter((d) => d.recordType === recordType && !d.hidden && d.scope === "client");
  const names = new Set(own.map((d) => d.name));
  const shared = defs.filter(
    (d) => d.recordType === recordType && !d.hidden && d.scope === "shared" && !names.has(d.name),
  );
  return [...own, ...shared];
}

/**
 * What a new or changed definition breaks, in plain words (empty: none). `existing` is every
 * definition the client has on the record type (hidden ones included: their names are taken);
 * `holdsData` whether any record has a value for the field being changed.
 */
export function customFieldProblems(input: {
  def: CustomFieldDef;
  recordType: Pick<RecordType, "id" | "fields" | "links" | "customFields"> | undefined;
  knownTypes: ReadonlySet<string>;
  existing: readonly CustomFieldDef[];
  before?: CustomFieldDef | undefined;
  holdsData?: boolean;
}): string[] {
  const { def, recordType, before } = input;
  const out: string[] = [];
  if (!recordType) return [`there is no record type ${def.recordType}`];
  if (!recordType.customFields) out.push(`${def.recordType} records don't keep custom fields`);
  if (RESERVED_RECORD_FIELDS.has(def.name)) out.push(`${def.name} is a reserved name`);
  if (
    recordType.fields.some((f) => f.name === def.name) ||
    recordType.links.some((l) => l.name === def.name)
  ) {
    out.push(`${def.recordType} already has a field ${def.name}`);
  }
  if (def.spec.record && !input.knownTypes.has(def.spec.record)) {
    out.push(`there is no record type ${def.spec.record} to link to`);
  }
  if (before) {
    if (before.name !== def.name) out.push("a field's name can't change; add a new field");
    if (before.recordType !== def.recordType) out.push("a field can't move to another record type");
    if (before.scope !== def.scope) out.push("a field can't change between client and shared");
    if (
      input.holdsData &&
      (before.type !== def.type || JSON.stringify(before.spec) !== JSON.stringify(def.spec))
    ) {
      out.push(`${def.label} holds data, so its type can't change; add a new field instead`);
    }
  } else {
    if (input.existing.some((d) => d.name === def.name && d.scope === def.scope)) {
      out.push(`${def.recordType} already has a custom field ${def.name}`);
    }
    const count = input.existing.filter((d) => !d.hidden).length;
    if (!def.hidden && count >= MAX_CUSTOM_FIELDS) {
      out.push(`${def.recordType} has ${count} custom fields, the most it can have`);
    }
  }
  return out;
}

const DECIMAL = /^-?\d{1,10}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 2000;
const MAX_ITEMS = 200;

/** A value's problem against its field, in plain words; null when it fits. */
export function fieldValueProblem(field: Field, value: unknown, label = field.name): string | null {
  if (value === null || value === undefined) {
    return field.required ? `${label} is required` : null;
  }
  switch (field.type) {
    case "text":
      if (typeof value !== "string") return `${label} is text`;
      if (value.length > MAX_TEXT) return `${label} is longer than ${MAX_TEXT} characters`;
      return null;
    case "number":
      if (typeof value === "number") {
        return Number.isFinite(value) ? null : `${label} is a number`;
      }
      return typeof value === "string" && DECIMAL.test(value) ? null : `${label} is a number`;
    case "money":
      // Invariant 6: money is a decimal string, never a JS number.
      return typeof value === "string" && DECIMAL.test(value)
        ? null
        : `${label} is money, written as a decimal ("1250.00")`;
    case "date":
      return typeof value === "string" &&
        DATE.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        ? null
        : `${label} is a date (YYYY-MM-DD)`;
    case "yes_no":
      return typeof value === "boolean" ? null : `${label} is yes or no`;
    case "record":
      return typeof value === "string" && UUID.test(value) ? null : `${label} is a record's id`;
    case "group": {
      if (typeof value !== "object" || Array.isArray(value)) return `${label} is a group of fields`;
      return groupProblem(field.of ?? [], value as Record<string, unknown>, label);
    }
    case "list": {
      if (!Array.isArray(value)) return `${label} is a list`;
      if (value.length > MAX_ITEMS) return `${label} has more than ${MAX_ITEMS} items`;
      for (const [i, item] of value.entries()) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          return `${label} item ${i + 1} is a group of fields`;
        }
        const p = groupProblem(
          field.of ?? [],
          item as Record<string, unknown>,
          `${label} ${i + 1}`,
        );
        if (p) return p;
      }
      return null;
    }
  }
}

function groupProblem(
  fields: readonly Field[],
  value: Record<string, unknown>,
  label: string,
): string | null {
  for (const key of Object.keys(value)) {
    if (!fields.some((f) => f.name === key)) return `${label} has no field ${key}`;
  }
  for (const f of fields) {
    const p = fieldValueProblem(f, value[f.name], `${label} ${f.name}`);
    if (p) return p;
  }
  return null;
}

/** Whether any text in a value looks like a card number (invariant 14). */
export function holdsCardNumber(value: unknown): boolean {
  if (typeof value === "string") return redactCardNumbers(value) !== value;
  if (Array.isArray(value)) return value.some(holdsCardNumber);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(holdsCardNumber);
  }
  return false;
}

/**
 * The custom values of a write, checked against the client's visible fields (the record type's
 * rules, on every write wherever it comes from). `current` is the record's custom values before
 * the write (an update); a create starts from none. Returns the values to store, or the problems.
 */
// DECISION: a value that looks like a card number is refused, not redacted: a silent change of
// what someone meant to save is worse than a plain "no" they can act on (invariant 14 either way).
export function checkCustomValues(input: {
  defs: readonly CustomFieldDef[];
  values: Readonly<Record<string, unknown>>;
  current?: Readonly<Record<string, unknown>> | undefined;
  creating: boolean;
}): { ok: true; custom: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const byName = new Map(input.defs.map((d) => [d.name, d]));
  const custom: Record<string, unknown> = { ...(input.current ?? {}) };
  for (const [name, value] of Object.entries(input.values)) {
    const def = byName.get(name);
    if (!def) {
      problems.push(`there is no field ${name}`);
      continue;
    }
    const p = fieldValueProblem(customFieldAsField(def), value, def.label);
    if (p) {
      problems.push(p);
      continue;
    }
    if (holdsCardNumber(value)) {
      problems.push(`${def.label} looks like a card number; card numbers are never stored`);
      continue;
    }
    if (value === null || value === undefined) delete custom[name];
    else custom[name] = value;
  }
  for (const def of input.defs) {
    if (!def.required) continue;
    const has = custom[def.name] !== undefined && custom[def.name] !== null;
    // A required field added after records existed is asked for on their next write only where
    // the write touches it, so an update of another field isn't refused for a field it never saw.
    if (!has && (input.creating || Object.hasOwn(input.values, def.name))) {
      problems.push(`${def.label} is required`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, custom };
}

/** A record's custom values as stored in its `ext` column. */
export function customValuesOf(ext: unknown): Record<string, unknown> {
  if (typeof ext !== "object" || ext === null) return {};
  const c = (ext as Record<string, unknown>)[CUSTOM_EXT_KEY];
  return typeof c === "object" && c !== null && !Array.isArray(c)
    ? { ...(c as Record<string, unknown>) }
    : {};
}
