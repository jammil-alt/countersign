// Podio app fields: what an app's definition says about each field, how a tool's generic input
// (`{ <field external_id>: value }`) is checked against it at call time, and how Podio's item field
// values read back as plain values. Podio apps are built by each client, so nothing here knows a
// field in advance: the app's own definition decides.

import { DecimalString } from "@countersign/core";
import { z } from "zod";

/** A field as `GET /app/{app_id}` gives it (the parts we use). */
export const PodioAppFieldRaw = z.looseObject({
  field_id: z.number().int(),
  external_id: z.string(),
  type: z.string(),
  label: z.string(),
  status: z.string().optional(),
  config: z
    .looseObject({
      required: z.boolean().optional(),
      settings: z
        .looseObject({
          multiple: z.boolean().optional(),
          options: z
            .array(
              z.looseObject({
                id: z.number().int(),
                text: z.string(),
                status: z.string().optional(),
              }),
            )
            .optional(),
          allowed_currencies: z.array(z.string()).optional(),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

/** A field as tools return it. */
export const PodioField = z.object({
  fieldId: z.number().int(),
  externalId: z.string(),
  type: z.string(),
  label: z.string(),
  required: z.boolean(),
  /** For category fields: the choices, by id and text. */
  options: z.array(z.object({ id: z.number().int(), text: z.string() })).optional(),
  /** Whether agents can set it (calculations, files and images can't be set here). */
  writable: z.boolean(),
});
export type PodioField = z.infer<typeof PodioField>;

// DECISION: the field types tools can write. Calculations are computed by Podio; files, images and
// embeds need uploads first (a follow-up); anything newer than this list is read-only until added.
const WRITABLE = new Set([
  "text",
  "number",
  "money",
  "category",
  "date",
  "email",
  "phone",
  "app",
  "contact",
  "progress",
  "location",
  "tag",
  "duration",
]);

export function mapPodioField(raw: unknown): PodioField | null {
  const f = PodioAppFieldRaw.parse(raw);
  if (f.status && f.status !== "active") return null;
  const options = f.config?.settings?.options
    ?.filter((o) => o.status === undefined || o.status === "active")
    .map((o) => ({ id: o.id, text: o.text }));
  return PodioField.parse({
    fieldId: f.field_id,
    externalId: f.external_id,
    type: f.type,
    label: f.label,
    required: f.config?.required === true,
    ...(options ? { options } : {}),
    writable: WRITABLE.has(f.type),
  });
}

const Ids = z.union([
  z.number().int().positive(),
  z.array(z.number().int().positive()).min(1).max(50),
]);
const ymd = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
const DateValue = z.union([
  z.string().regex(ymd, "yyyy-mm-dd or yyyy-mm-dd hh:mm:ss"),
  z.strictObject({
    start: z.string().regex(ymd, "yyyy-mm-dd or yyyy-mm-dd hh:mm:ss"),
    end: z.string().regex(ymd).optional(),
  }),
]);
const Typed = z.union([
  z.string().min(1).max(300),
  z.array(
    z.union([
      z.string().min(1).max(300),
      z.strictObject({
        type: z.string().min(1).max(20).default("work"),
        value: z.string().min(1).max(300),
      }),
    ]),
  ),
]);

/** The Zod schema a value for this field must pass. */
function valueSchema(field: PodioField): z.ZodType {
  switch (field.type) {
    case "text":
    case "location":
      return z.string().max(100_000);
    case "number":
      return z.union([z.number().finite(), DecimalString]);
    case "money":
      return z.strictObject({ value: DecimalString, currency: z.string().length(3) });
    case "category":
      return z.union([
        z.number().int(),
        z.string().min(1),
        z.array(z.union([z.number().int(), z.string().min(1)])).min(1),
      ]);
    case "date":
      return DateValue;
    case "email":
    case "phone":
      return Typed;
    case "app":
    case "contact":
      return Ids;
    case "progress":
      return z.number().int().min(0).max(100);
    case "tag":
      return z.array(z.string().min(1).max(100)).max(50);
    case "duration":
      return z.number().int().min(0);
    default:
      return z.never();
  }
}

export class PodioFieldError extends Error {
  constructor(readonly problems: string[]) {
    super(`these fields don't fit the app: ${problems.join("; ")}`);
    this.name = "PodioFieldError";
  }
}

/** A value as Podio's item API takes it, after the field's schema accepted it. */
function toPodio(field: PodioField, value: unknown, problems: string[]): unknown {
  switch (field.type) {
    case "number":
      return typeof value === "number" ? value : Number(value);
    case "category": {
      const list = Array.isArray(value) ? value : [value];
      const ids: number[] = [];
      for (const v of list) {
        const hit = field.options?.find((o) =>
          typeof v === "number" ? o.id === v : o.text.toLowerCase() === String(v).toLowerCase(),
        );
        if (!hit) problems.push(`${field.externalId}: "${v}" is not one of its choices`);
        else ids.push(hit.id);
      }
      return ids;
    }
    case "date":
      return typeof value === "string"
        ? dateValue(value)
        : dateRange(value as { start: string; end?: string });
    case "email":
    case "phone": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((v) => (typeof v === "string" ? { type: "work", value: v } : v));
    }
    default:
      return value;
  }
}

function dateValue(s: string): Record<string, string> {
  return s.length > 10 ? { start_utc: s.length === 16 ? `${s}:00` : s } : { start_date: s };
}

function dateRange(v: { start: string; end?: string }): Record<string, string> {
  const out = dateValue(v.start);
  if (v.end) {
    if (v.end.length > 10) out.end_utc = v.end.length === 16 ? `${v.end}:00` : v.end;
    else out.end_date = v.end;
  }
  return out;
}

/**
 * Checks a tool's `fields` against the app's definition and returns Podio's `fields` body. Every
 * key must be an active, writable field of the app; each value must fit its type (and a category
 * value one of its choices); on create, every required field must be given.
 */
export function podioFieldValues(
  fields: PodioField[],
  input: Record<string, unknown>,
  opts: { create: boolean },
): Record<string, unknown> {
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = fields.find((f) => f.externalId === key);
    if (!field) {
      problems.push(`${key}: the app has no such field`);
      continue;
    }
    if (!field.writable) {
      problems.push(`${key}: a ${field.type} field can't be set here`);
      continue;
    }
    const r = valueSchema(field).safeParse(value);
    if (!r.success) {
      problems.push(`${key} (${field.type}): ${r.error.issues[0]?.message ?? "invalid value"}`);
      continue;
    }
    out[key] = toPodio(field, r.data, problems);
  }
  if (opts.create) {
    for (const f of fields) {
      if (f.required && !(f.externalId in input)) problems.push(`${f.externalId}: required`);
    }
  }
  if (problems.length > 0) throw new PodioFieldError(problems);
  return out;
}

/** An item field from Podio, read back as a plain value (`null` when empty). */
export function plainFieldValue(raw: { type?: unknown; values?: unknown }): unknown {
  const values = Array.isArray(raw.values) ? (raw.values as Record<string, unknown>[]) : [];
  if (values.length === 0) return null;
  const one = (v: Record<string, unknown>): unknown => {
    const value = v.value as Record<string, unknown> | string | number | undefined;
    switch (raw.type) {
      case "money":
        return { value: v.value, currency: v.currency };
      case "category":
        return (value as { text?: unknown })?.text ?? null;
      case "date":
        return { start: v.start ?? null, end: v.end ?? null };
      case "email":
      case "phone":
        return v.value;
      case "app":
        return {
          itemId: (value as { item_id?: unknown })?.item_id ?? null,
          title: (value as { title?: unknown })?.title ?? null,
        };
      case "contact":
        return {
          profileId: (value as { profile_id?: unknown })?.profile_id ?? null,
          name: (value as { name?: unknown })?.name ?? null,
        };
      default:
        return value ?? null;
    }
  };
  const many = ["category", "app", "contact", "email", "phone", "tag"].includes(String(raw.type));
  return many ? values.map(one) : one(values[0] as Record<string, unknown>);
}
