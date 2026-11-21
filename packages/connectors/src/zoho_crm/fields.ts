// docs/plan.md §1.164 step 3, "Zoho's fields": the org's own fields per module, read with
// `GET /crm/v8/settings/fields?module=`, kept per connection, and used two ways. The builder types a
// Zoho write's `fields` input from them (labels as titles, so Reshape data proposes the client's
// custom fields by label), and a connection may add fields to its sync, checked against them. Pure
// here: the parsing, the JSON Schemas, the cache's shape and the checks; the calls are the
// connector's (./index.ts) and the cache's reads and writes apps/api's.

import { isPlainObject, type JsonSchema } from "@countersign/core";
import { z } from "zod";
import { ZOHO_SYNCED_MODULES, type ZohoSyncedModule } from "./sync";

/**
 * The scope the field metadata call needs. A connection signed in before it was added has no such
 * grant: the call is refused (or not made, when the stored scope says so) and everything else works
 * as before, as for notifications.
 */
// UNCHECKED (NOTES.md): the scope's name, and that `ZohoCRM.settings.fields.ALL` and
// `ZohoCRM.settings.ALL` grant it too.
export const ZOHO_FIELDS_SCOPE = "ZohoCRM.settings.fields.READ";
const FIELDS_SCOPE_GRANTS = [
  ZOHO_FIELDS_SCOPE,
  "ZohoCRM.settings.fields.ALL",
  "ZohoCRM.settings.ALL",
].map((s) => s.toLowerCase());

/**
 * Whether a stored grant's scope string lets us read field metadata: true, false, or null when the
 * token answer carried no scope (then only the call itself tells).
 */
export function zohoScopeReadsFields(scope: string | undefined | null): boolean | null {
  if (!scope) return null;
  const granted = scope
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  return granted.some((s) => FIELDS_SCOPE_GRANTS.includes(s));
}

/** One field of a module, as we keep it. */
export const ZohoField = z.object({
  /** What the API reads and writes (`Last_Name`, `Region`). */
  apiName: z.string().min(1).max(100),
  /** What a person sees in Zoho ("Last Name", "Sales region"). */
  label: z.string().max(255),
  /** Zoho's `data_type` (`text`, `picklist`, `date`, `currency`, `lookup`, …). */
  dataType: z.string().max(60),
  /** Made by the client, not one of Zoho's standard fields. */
  custom: z.boolean(),
  /** The API can't write it (read-only, a formula, an auto number, a system time). */
  readOnly: z.boolean(),
  /** Zoho requires it on a new record (`system_mandatory`). */
  mandatory: z.boolean(),
  /** A picklist's values as the API takes them, without Zoho's "-None-"; null for other types. */
  picklist: z.array(z.string().max(255)).nullable(),
  /** The longest text it takes; null where Zoho gives none or it isn't text. */
  maxLength: z.number().int().positive().nullable(),
});
export type ZohoField = z.infer<typeof ZohoField>;

// UNCHECKED (NOTES.md): the v8 answer's shape, from Zoho's v2–v8 field metadata docs: `fields[]`
// with `api_name`, `field_label`, `display_label`, `data_type`, `custom_field`, `read_only`,
// `field_read_only`, `system_mandatory`, `length`, `visible`, `view_type`, `pick_list_values[]`
// (`actual_value`, `display_value`). Anything else is ignored; a field that doesn't read is skipped.
const RawPicklistValue = z.looseObject({
  actual_value: z.string().max(255).nullable().optional(),
  display_value: z.string().max(255).nullable().optional(),
});
const RawField = z.looseObject({
  api_name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
    .max(100),
  field_label: z.string().max(255).nullable().optional(),
  display_label: z.string().max(255).nullable().optional(),
  data_type: z.string().max(60).nullable().optional(),
  custom_field: z.boolean().nullable().optional(),
  read_only: z.boolean().nullable().optional(),
  field_read_only: z.boolean().nullable().optional(),
  system_mandatory: z.boolean().nullable().optional(),
  visible: z.boolean().nullable().optional(),
  length: z.number().nullable().optional(),
  view_type: z.looseObject({ edit: z.boolean().optional() }).nullable().optional(),
  pick_list_values: z.array(RawPicklistValue).max(5000).nullable().optional(),
});
const FieldsAnswer = z.object({ fields: z.array(z.unknown()).max(2000) });

/** Types the API can't write whatever the flags say. */
const COMPUTED_TYPES = new Set(["formula", "autonumber", "rollup_summary", "aggregate"]);
/** Text-like types, whose `length` is a maximum. */
const TEXT_TYPES = new Set(["text", "textarea", "email", "phone", "website", "picklist"]);
/** Zoho's empty picklist choice. */
const NONE_VALUE = "-None-";

/** One raw field as a ZohoField, or null when it doesn't read or is hidden. */
function fieldOf(raw: unknown): ZohoField | null {
  const r = RawField.safeParse(raw);
  if (!r.success || r.data.visible === false) return null;
  const f = r.data;
  const dataType = (f.data_type ?? "").toLowerCase() || "unknown";
  const picklist =
    dataType === "picklist" || dataType === "multiselectpicklist"
      ? [
          ...new Set(
            (f.pick_list_values ?? [])
              .map((v) => v.actual_value ?? v.display_value ?? "")
              .filter((v) => v !== "" && v !== NONE_VALUE),
          ),
        ]
      : null;
  const length = typeof f.length === "number" && f.length > 0 ? Math.floor(f.length) : null;
  return {
    apiName: f.api_name,
    label: (f.field_label ?? f.display_label ?? f.api_name).trim() || f.api_name,
    dataType,
    custom: f.custom_field === true,
    readOnly:
      f.read_only === true ||
      f.field_read_only === true ||
      f.view_type?.edit === false ||
      COMPUTED_TYPES.has(dataType),
    mandatory: f.system_mandatory === true,
    picklist,
    maxLength: TEXT_TYPES.has(dataType) ? length : null,
  };
}

/** Zoho's `settings/fields` answer → the module's fields, in Zoho's order, each API name once. */
export function parseZohoFields(body: unknown): ZohoField[] {
  const answer = FieldsAnswer.safeParse(body ?? { fields: [] });
  if (!answer.success) throw new Error("Zoho's field list has an unexpected shape");
  const out: ZohoField[] = [];
  const seen = new Set<string>();
  for (const raw of answer.data.fields) {
    const f = fieldOf(raw);
    if (!f || seen.has(f.apiName)) continue;
    seen.add(f.apiName);
    out.push(f);
  }
  return out;
}

// ── JSON Schemas for the builder ─────────────────────────────────────────────────────────────

/** Types a write doesn't take as plain values: uploads, subforms. */
const NOT_WRITTEN_TYPES = new Set([
  "fileupload",
  "imageupload",
  "profileimage",
  "subform",
  "multiselectlookup",
  "multiuserlookup",
]);

/** What one field takes, as JSON Schema, titled with its label. */
export function zohoFieldSchema(f: ZohoField): JsonSchema {
  const titled = (s: JsonSchema): JsonSchema => ({ title: f.label, ...s });
  const text = (extra: JsonSchema = {}): JsonSchema =>
    titled({ type: "string", ...(f.maxLength ? { maxLength: f.maxLength } : {}), ...extra });
  switch (f.dataType) {
    case "text":
    case "textarea":
    case "phone":
    case "website":
    case "autonumber":
      return text();
    case "email":
      return text({ format: "email" });
    case "picklist":
      return text(f.picklist && f.picklist.length > 0 ? { enum: f.picklist } : {});
    case "multiselectpicklist":
      return titled({
        type: "array",
        items:
          f.picklist && f.picklist.length > 0
            ? { type: "string", enum: f.picklist }
            : { type: "string" },
      });
    case "date":
      return titled({ type: "string", format: "date" });
    case "datetime":
      return titled({ type: "string", format: "date-time" });
    case "integer":
    case "bigint":
      return titled({ type: "integer" });
    // DECISION: a currency, decimal or percent field is a JSON number, as Zoho takes it; Reshape's
    // `formatNumber … as number` makes one from a sheet's text without float arithmetic of ours.
    case "double":
    case "decimal":
    case "currency":
    case "percent":
      return titled({ type: "number" });
    case "boolean":
      return titled({ type: "boolean" });
    case "lookup":
    case "ownerlookup":
    case "userlookup":
      return titled({
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
        required: ["id"],
      });
    default:
      return titled({});
  }
}

/** The JSON Schema marker of the input property a step writes as one record (core's RECORD_HINT). */
const RECORD_HINT = "x-record";

/**
 * The record a write takes, typed from the module's fields: every field the API can write, titled
 * with its label; on a create, the mandatory ones required. Other fields still pass (Zoho checks
 * them), so a field added in Zoho since we last read the list isn't refused here.
 */
export function zohoRecordSchema(
  fields: readonly ZohoField[],
  opts: { create: boolean },
): JsonSchema {
  const writable = fields.filter((f) => !f.readOnly && !NOT_WRITTEN_TYPES.has(f.dataType));
  const required = opts.create ? writable.filter((f) => f.mandatory).map((f) => f.apiName) : [];
  return {
    type: "object",
    properties: Object.fromEntries(writable.map((f) => [f.apiName, zohoFieldSchema(f)])),
    ...(required.length > 0 ? { required } : {}),
    [RECORD_HINT]: true,
  };
}

/** A tool's input with its `fields` property replaced by the module's typed record. */
function withRecord(input: JsonSchema, module: string, record: JsonSchema): JsonSchema {
  const props = isPlainObject(input.properties) ? input.properties : {};
  return {
    ...input,
    properties: {
      ...props,
      module: { type: "string", const: module },
      fields: record,
    },
  };
}

/**
 * Core's `ToolInputVariants` for the record write tools: per module, the tool's input with `fields`
 * typed from that module's fields. Modules without a field list are left out (the tool's own input
 * types them, as before).
 */
export function zohoToolInputs(
  cache: ZohoFieldCache | null,
  tools: { create: { id: string; input: JsonSchema }; update: { id: string; input: JsonSchema } },
): Record<string, { by: string; schemas: Record<string, JsonSchema> }> {
  if (cache?.status !== "ok") return {};
  const out: Record<string, { by: string; schemas: Record<string, JsonSchema> }> = {};
  for (const [kind, tool] of [
    ["create", tools.create],
    ["update", tools.update],
  ] as const) {
    const schemas: Record<string, JsonSchema> = {};
    for (const m of ZOHO_SYNCED_MODULES) {
      const fields = cache.modules[m];
      if (!fields || fields.length === 0) continue;
      schemas[m] = withRecord(
        tool.input,
        m,
        zohoRecordSchema(fields, { create: kind === "create" }),
      );
    }
    if (Object.keys(schemas).length > 0) out[tool.id] = { by: "module", schemas };
  }
  return out;
}

// ── The cache ───────────────────────────────────────────────────────────────────────────────

/**
 * What a connection keeps of its org's fields, under `sync_cursor.zohoFields`: when it was read,
 * whether it could be (`needs_sign_in`: the grant has no field scope), and the fields per module.
 */
export const ZohoFieldCache = z.object({
  v: z.literal(1),
  at: z.iso.datetime({ offset: true }),
  status: z.enum(["ok", "needs_sign_in"]),
  modules: z.partialRecord(z.enum(ZOHO_SYNCED_MODULES), z.array(ZohoField).max(2000)),
});
export type ZohoFieldCache = z.infer<typeof ZohoFieldCache>;

/** The key in `sync_cursor` the cache sits under, beside the poll's cursor and the watch. */
export const ZOHO_FIELD_CACHE_KEY = "zohoFields";

/** The stored cache, or null (none, or one that doesn't read). */
export function readZohoFieldCache(syncCursor: unknown): ZohoFieldCache | null {
  const raw = (syncCursor as Record<string, unknown> | null | undefined)?.[ZOHO_FIELD_CACHE_KEY];
  const parsed = ZohoFieldCache.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The cache is read again after this long (the cron's daily pass, or a builder's read). */
// DECISION: a day: a client adds a custom field rarely, and the back office's "Read the fields
// again" reads at once when one was just added.
export const ZOHO_FIELD_CACHE_MS = 24 * 60 * 60 * 1000;

/** Whether the cache is missing or older than `maxAgeMs`. */
export function zohoFieldCacheStale(
  cache: ZohoFieldCache | null,
  now: Date,
  maxAgeMs = ZOHO_FIELD_CACHE_MS,
): boolean {
  return !cache || now.getTime() - Date.parse(cache.at) >= maxAgeMs;
}

// ── Sync fields ─────────────────────────────────────────────────────────────────────────────

/** v8's most fields in one list call. */
// UNCHECKED (NOTES.md): the limit of 50.
export const ZOHO_MAX_FIELDS_PER_CALL = 50;

/**
 * A connection's own fields to sync per module, beside the standard ones (`config.syncFields`):
 * e.g. `{ "Leads": ["Region", "Last_Import_Date"] }`.
 */
export const ZohoSyncFieldsConfig = z.partialRecord(
  z.enum(ZOHO_SYNCED_MODULES),
  z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "a Zoho field API name, e.g. Region")
        .max(100),
    )
    .max(ZOHO_MAX_FIELDS_PER_CALL),
);
export type ZohoSyncFieldsConfig = z.infer<typeof ZohoSyncFieldsConfig>;

/** The config key a connection's extra sync fields sit under. */
export const ZOHO_SYNC_FIELDS_KEY = "syncFields";

/** The connection's extra sync fields, or none when it has none or they don't read. */
export function readZohoSyncFieldsConfig(config: unknown): ZohoSyncFieldsConfig {
  if (!isPlainObject(config)) return {};
  const parsed = ZohoSyncFieldsConfig.safeParse(config[ZOHO_SYNC_FIELDS_KEY]);
  return parsed.success ? parsed.data : {};
}

/** One thing wrong with a connection's extra sync fields, by module. */
export interface ZohoSyncFieldsProblem {
  module: ZohoSyncedModule | null;
  field: string | null;
  message: string;
}

/**
 * What's wrong with proposed extra sync fields: they must read as the config's shape, each field
 * added (not in `before`) must be one of the module's fields in the cache, and a module's list that
 * grew must still fit one call with the standard fields and the times the cursor reads. Without a
 * field list there is nothing to check an added field against, so it is refused, saying why;
 * taking fields away is always fine.
 */
export function zohoSyncFieldsProblems(
  proposed: unknown,
  cache: ZohoFieldCache | null,
  standardCount: (module: ZohoSyncedModule) => number,
  before: unknown = undefined,
): ZohoSyncFieldsProblem[] {
  if (proposed === undefined) return [];
  const had = ZohoSyncFieldsConfig.safeParse(before);
  const parsed = ZohoSyncFieldsConfig.safeParse(proposed);
  if (!parsed.success) {
    return [
      {
        module: null,
        field: null,
        message: `syncFields must name fields by module (Leads, Contacts, Accounts, Deals): ${parsed.error.issues[0]?.message ?? "it doesn't read"}`,
      },
    ];
  }
  const problems: ZohoSyncFieldsProblem[] = [];
  for (const m of ZOHO_SYNCED_MODULES) {
    const kept = new Set(had.success ? (had.data[m] ?? []) : []);
    const extra = (parsed.data[m] ?? []).filter((f) => !kept.has(f));
    if (extra.length === 0) continue;
    if (!cache) {
      problems.push({
        module: m,
        field: null,
        message: "we haven't read this Zoho's fields yet: read them first, then choose",
      });
      continue;
    }
    if (cache.status === "needs_sign_in") {
      problems.push({
        module: m,
        field: null,
        message:
          "this Zoho connection can't read its fields: the client needs to sign in to Zoho again",
      });
      continue;
    }
    const known = new Set((cache.modules[m] ?? []).map((f) => f.apiName));
    for (const name of extra) {
      if (!known.has(name)) {
        problems.push({ module: m, field: name, message: `${m} has no field ${name} in Zoho` });
      }
    }
    const total = standardCount(m) + new Set(parsed.data[m]).size;
    if (total > ZOHO_MAX_FIELDS_PER_CALL) {
      problems.push({
        module: m,
        field: null,
        message: `${m} would read ${total} fields; Zoho reads at most ${ZOHO_MAX_FIELDS_PER_CALL} at a time`,
      });
    }
  }
  return problems;
}
