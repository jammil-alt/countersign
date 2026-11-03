// Validating values against the JSON Schemas skills and tools declare (invariant 5). Zod reads the
// JSON Schema, so there is one validator in the codebase.

import type { JsonSchema } from "@countersign/core";
import { z } from "zod";

const cache = new WeakMap<object, z.ZodType>();

function compile(schema: JsonSchema): z.ZodType {
  let compiled = cache.get(schema);
  if (!compiled) {
    // DECISION: a schema Zod can't read (a keyword it doesn't support) accepts any value rather
    // than failing every call; the schemas here come from Zod or the operator's field editor,
    // both of which Zod reads.
    try {
      compiled = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      compiled = z.unknown();
    }
    cache.set(schema, compiled);
  }
  return compiled;
}

export type SchemaCheck = { ok: true; value: unknown } | { ok: false; message: string };

export function checkAgainst(schema: JsonSchema | undefined, value: unknown): SchemaCheck {
  if (!schema || Object.keys(schema).length === 0) return { ok: true, value };
  const r = compile(schema).safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: z.prettifyError(r.error) };
}

/** An object schema for a model tool's input: the API takes only `type: object` schemas. */
export function objectSchema(schema: JsonSchema | undefined): Record<string, unknown> {
  const s = { ...(schema ?? {}) };
  delete s.$schema;
  if (s.type !== "object") return { type: "object", properties: {}, additionalProperties: true };
  return s;
}
