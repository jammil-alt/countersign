// Validating values against the JSON Schemas skills and tools declare (invariant 5). Zod reads the
// JSON Schema, so there is one validator in the codebase.

import type { JsonSchema } from "@countersign/core";
import { z } from "zod";

const cache = new WeakMap<object, z.ZodType | { unreadable: string }>();

// DECISION (PLATFORM_QA AI-3, replacing the earlier one): a schema Zod can't read (a keyword it
// doesn't support, such as `unevaluatedProperties` or `if`/`then`) fails every check against it
// rather than accepting any value (invariant 5). The platform's schemas all come from Zod, which
// reads them back; an operator skill with one is refused when it is saved (`schemaProblem`).
function compile(schema: JsonSchema): z.ZodType | { unreadable: string } {
  let compiled = cache.get(schema);
  if (!compiled) {
    try {
      compiled = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch (error) {
      compiled = { unreadable: error instanceof Error ? error.message : String(error) };
    }
    cache.set(schema, compiled);
  }
  return compiled;
}

/** Why a schema can't be checked against (Zod can't read it), or null when it can. */
export function schemaProblem(schema: JsonSchema | undefined): string | null {
  if (!schema || Object.keys(schema).length === 0) return null;
  const compiled = compile(schema);
  return "unreadable" in compiled ? compiled.unreadable : null;
}

export type SchemaCheck = { ok: true; value: unknown } | { ok: false; message: string };

export function checkAgainst(schema: JsonSchema | undefined, value: unknown): SchemaCheck {
  if (!schema || Object.keys(schema).length === 0) return { ok: true, value };
  const compiled = compile(schema);
  if ("unreadable" in compiled) {
    return { ok: false, message: `the schema can't be checked: ${compiled.unreadable}` };
  }
  const r = compiled.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, message: z.prettifyError(r.error) };
}

/** An object schema for a model tool's input: the API takes only `type: object` schemas. */
export function objectSchema(schema: JsonSchema | undefined): Record<string, unknown> {
  const s = { ...(schema ?? {}) };
  delete s.$schema;
  if (s.type !== "object") return { type: "object", properties: {}, additionalProperties: true };
  return s;
}
