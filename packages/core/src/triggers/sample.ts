// §1.164 "Webhook JSON" (owner, 2026-11-20): a webhook trigger may carry the shape of the data its
// hook receives, inferred from a sample payload the operator pastes in the builder, so
// `{{trigger.data.…}}` is typed and Reshape data proposes from it. Without one it stays "any path
// reads". Pure: the builder infers in the browser, the validator checks what is stored.

import { z } from "zod";
import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";

// DECISION (§1.164): the trigger keeps the inferred shape (keys and types), never the sample's
// values. A pasted delivery may hold a real customer's name or email; a definition is versioned for
// good (invariant 3) and can be promoted to a template, so values never enter it, and nothing in a
// sample can reach a model as text: only field names, as every other field name does, as data.

/** The longest sample the builder reads: a delivery's own limit (the webhook connector's 64 KB). */
export const SAMPLE_PAYLOAD_MAX_CHARS = 64 * 1024;
/** The largest inferred shape a trigger stores, as JSON. */
export const SAMPLE_SCHEMA_MAX_CHARS = 32 * 1024;
/** How deep the shape goes; anything deeper reads as unknown (any path reads). */
export const SAMPLE_MAX_DEPTH = 8;
/** Fields kept per record; a record with more is left open (the rest read untyped). */
export const SAMPLE_MAX_FIELDS = 200;
/** Items of one list looked at. */
export const SAMPLE_MAX_ITEMS = 1000;

/**
 * A field name a template or a mapping can address (`{{trigger.data.first_name}}`). Others (with
 * spaces or dots, or over 64 characters) can't be read by path, so they are left out and the
 * record is left open.
 */
const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const SAMPLE_TYPES = ["string", "number", "integer", "boolean", "null", "object", "array"] as const;
type SampleType = (typeof SAMPLE_TYPES)[number];

/** The subset of JSON Schema an inferred shape uses: types, fields, items and alternatives. */
export interface SampleSchema {
  type?: SampleType | SampleType[] | undefined;
  properties?: Record<string, SampleSchema> | undefined;
  required?: string[] | undefined;
  additionalProperties?: boolean | undefined;
  items?: SampleSchema | undefined;
  anyOf?: SampleSchema[] | undefined;
}

/** Levels of records and lists (alternatives are one level). */
function depthOf(s: SampleSchema): number {
  const alts = (s.anyOf ?? []).reduce((m, x) => Math.max(m, depthOf(x)), 0);
  const inner = [...Object.values(s.properties ?? {}), ...(s.items ? [s.items] : [])];
  return Math.max(alts, 1 + inner.reduce((m, x) => Math.max(m, depthOf(x)), 0));
}

const SampleNode: z.ZodType<SampleSchema> = z.lazy(() =>
  z
    .strictObject({
      type: z.union([z.enum(SAMPLE_TYPES), z.array(z.enum(SAMPLE_TYPES)).min(1).max(7)]).optional(),
      properties: z
        .record(z.string().regex(FIELD_NAME), SampleNode)
        .refine((p) => Object.keys(p).length <= SAMPLE_MAX_FIELDS, "too many fields")
        .optional(),
      required: z.array(z.string().regex(FIELD_NAME)).max(SAMPLE_MAX_FIELDS).optional(),
      additionalProperties: z.boolean().optional(),
      items: SampleNode.optional(),
      anyOf: z.array(SampleNode).min(2).max(8).optional(),
    })
    .refine((s) => (s.required ?? []).every((r) => Object.hasOwn(s.properties ?? {}, r)), {
      message: "a required field is one of the record's fields",
    }),
);

/**
 * What a webhook trigger stores: the shape of `{{trigger.data}}`. Checked as data on every save,
 * so a hand-written or merged one can't carry anything but field names and types.
 */
export const WebhookDataSchema = SampleNode.superRefine((s, ctx) => {
  if (JSON.stringify(s).length > SAMPLE_SCHEMA_MAX_CHARS) {
    ctx.addIssue({
      code: "custom",
      message: "the sample's shape is too large: paste a smaller one",
    });
  }
  if (depthOf(s) > SAMPLE_MAX_DEPTH + 2) {
    ctx.addIssue({
      code: "custom",
      message: `the sample nests more than ${SAMPLE_MAX_DEPTH} deep`,
    });
  }
  if (s.type !== "object") {
    ctx.addIssue({ code: "custom", message: "a delivery's data is a record" });
  }
});

// ── Inference ────────────────────────────────────────────────────────────────────────────────

interface Shape {
  /** Scalar types seen (`integer` and `number` are told apart, `number` wins). */
  scalars: Set<"string" | "number" | "integer" | "boolean">;
  nullable: boolean;
  /** Seen deeper than the limit: unknown. */
  deep: boolean;
  object?: {
    fields: Map<string, Shape>;
    /** How many of the records seen had each field. */
    counts: Map<string, number>;
    seen: number;
    /** Seen as a list's item (or inside one): only then are fields required. */
    listed: boolean;
    /** A field was left out: the rest read untyped. */
    open: boolean;
  };
  /** A list; `item` null when every list seen was empty. */
  array?: { item: Shape | null };
}

const empty = (): Shape => ({ scalars: new Set(), nullable: false, deep: false });

function observe(shape: Shape, value: unknown, depth: number, listed: boolean): void {
  if (depth > SAMPLE_MAX_DEPTH) {
    shape.deep = true;
    return;
  }
  if (value === null || value === undefined) {
    shape.nullable = true;
    return;
  }
  if (typeof value === "string") shape.scalars.add("string");
  else if (typeof value === "boolean") shape.scalars.add("boolean");
  else if (typeof value === "number") {
    shape.scalars.add(Number.isInteger(value) ? "integer" : "number");
  } else if (Array.isArray(value)) {
    shape.array ??= { item: null };
    for (const x of value.slice(0, SAMPLE_MAX_ITEMS)) {
      shape.array.item ??= empty();
      observe(shape.array.item, x, depth + 1, true);
    }
  } else if (isPlainObject(value)) {
    shape.object ??= { fields: new Map(), counts: new Map(), seen: 0, listed, open: false };
    const o = shape.object;
    o.seen += 1;
    o.listed ||= listed;
    for (const [k, v] of Object.entries(value)) {
      if (!FIELD_NAME.test(k) || (!o.fields.has(k) && o.fields.size >= SAMPLE_MAX_FIELDS)) {
        o.open = true;
        continue;
      }
      let f = o.fields.get(k);
      if (!f) {
        f = empty();
        o.fields.set(k, f);
      }
      o.counts.set(k, (o.counts.get(k) ?? 0) + 1);
      observe(f, v, depth + 1, listed);
    }
  }
}

function toSchema(shape: Shape): SampleSchema {
  if (shape.deep) return {};
  const alts: SampleSchema[] = [];
  const scalars = [...shape.scalars].filter(
    (t) => !(t === "integer" && shape.scalars.has("number")),
  );
  for (const t of scalars) alts.push({ type: t });
  if (shape.object) {
    const o = shape.object;
    const properties: Record<string, SampleSchema> = {};
    for (const [k, f] of o.fields) properties[k] = toSchema(f);
    // Nothing is required except fields present in every item of a list: one record proves
    // nothing about the next delivery.
    const required = o.listed ? [...o.fields.keys()].filter((k) => o.counts.get(k) === o.seen) : [];
    alts.push({
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: o.open,
    });
  }
  if (shape.array) {
    alts.push({ type: "array", items: shape.array.item ? toSchema(shape.array.item) : {} });
  }
  // DECISION (§1.164): a field only ever null (or a list only ever empty) says nothing of its
  // type: unknown, so any path under it reads. A null beside a type makes that type nullable.
  if (alts.length === 0) return {};
  const nullable = shape.nullable;
  if (alts.every((a) => typeof a.type === "string" && a.type !== "object" && a.type !== "array")) {
    const types = alts.map((a) => a.type as SampleType);
    if (nullable) types.push("null");
    return { type: types.length === 1 ? (types[0] as SampleType) : types };
  }
  if (nullable) alts.push({ type: "null" });
  return alts.length === 1 ? (alts[0] as SampleSchema) : { anyOf: alts };
}

/**
 * The shape of a webhook delivery's data from a sample of it: types, nested records, lists of
 * records merged by field (a field in every item is required, nothing else is), mixed types as
 * alternatives, null as nullable. A sample that isn't a record is wrapped as the delivery is
 * (`{ value: … }`).
 */
export function inferSampleSchema(sample: unknown): SampleSchema {
  const value = isPlainObject(sample) ? sample : { value: sample };
  const shape = empty();
  observe(shape, value, 0, false);
  return toSchema(shape);
}

/** A pasted sample read as JSON and its shape, or why it can't be used (plain words). */
export function parseSamplePayload(
  text: string,
): { ok: true; schema: SampleSchema; fields: number } | { ok: false; message: string } {
  if (text.length > SAMPLE_PAYLOAD_MAX_CHARS) {
    return { ok: false, message: "The sample is over 64 KB, more than a delivery may be." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "The sample isn't JSON." };
  }
  const schema = inferSampleSchema(parsed);
  const checked = WebhookDataSchema.safeParse(schema);
  if (!checked.success) {
    return { ok: false, message: `The sample can't be used: ${checked.error.issues[0]?.message}.` };
  }
  return { ok: true, schema, fields: samplePaths(schema).length };
}

/** Each path a shape has with its types (`customer.email`: string), for the builder's list. */
export function samplePaths(
  schema: SampleSchema | JsonSchema | undefined,
  base = "",
  depth = 0,
  out: { path: string; types: string[] }[] = [],
): { path: string; types: string[] }[] {
  if (!isPlainObject(schema) || depth > SAMPLE_MAX_DEPTH + 2 || out.length >= 500) return out;
  const s = schema as SampleSchema;
  const alts = Array.isArray(s.anyOf) ? s.anyOf : [s];
  for (const alt of alts) {
    // A list's items: `lines.0.sku` reads the first; the builder lists them as `lines.*.sku`.
    if (isPlainObject(alt.items)) samplePaths(alt.items, `${base}.*`, depth + 1, out);
    if (!isPlainObject(alt.properties)) continue;
    for (const [k, v] of Object.entries(alt.properties)) {
      const path = base ? `${base}.${k}` : k;
      out.push({ path, types: typeNames(v) });
      samplePaths(v, path, depth + 1, out);
    }
  }
  return out;
}

function typeNames(s: SampleSchema): string[] {
  if (Array.isArray(s.anyOf)) return [...new Set(s.anyOf.flatMap(typeNames))];
  if (typeof s.type === "string") return [s.type];
  if (Array.isArray(s.type)) return s.type;
  return [];
}

/**
 * A webhook trigger's payload with its data typed by the stored shape: the `webhook.received`
 * payload's `data` replaced (the rest as the event types it).
 */
export function webhookPayloadWithData(
  payload: JsonSchema | undefined,
  data: SampleSchema,
): JsonSchema {
  if (isPlainObject(payload) && isPlainObject(payload.properties)) {
    return {
      ...payload,
      properties: { ...(payload.properties as Record<string, unknown>), data },
    };
  }
  return {
    type: "object",
    properties: { data },
    required: ["data"],
    additionalProperties: true,
  };
}
