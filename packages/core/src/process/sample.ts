// A value a schema could take (the builder's sample when no run has the real thing). A module of
// its own, apart from ./reshape: that module is in the web app's first load, and only the test bar
// and the made-up-data route use this (docs/plan.md §1.185, §1.186; scripts/web-size.mjs).
import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";
import { schemaTypeNames } from "./reshape";

const DECIMAL_HINT = /amount|total|price|cost|subtotal|tax|freight|balance|qty|quantity/i;

/** A value a schema could take, for the builder's sample when no run has the real thing. */
export function sampleFromSchema(schema: JsonSchema | undefined, name = "", depth = 0): unknown {
  if (!isPlainObject(schema) || depth > 6) return null;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  for (const k of ["anyOf", "oneOf"] as const) {
    const list = schema[k];
    if (Array.isArray(list)) {
      const alt = list.find(
        (s) => isPlainObject(s) && schemaTypeNames(s as JsonSchema).join() !== "null",
      );
      return sampleFromSchema(alt as JsonSchema | undefined, name, depth + 1);
    }
  }
  const types = schemaTypeNames(schema);
  const t = types.find((x) => x !== "null") ?? types[0];
  switch (t) {
    case "string": {
      const pattern = typeof schema.pattern === "string" ? schema.pattern : "";
      if (schema.format === "date" || pattern.includes("\\d{4}-\\d{2}") || /date$/i.test(name)) {
        return "2026-11-10";
      }
      if (pattern.includes("[A-Z]{3}") || /currency/i.test(name)) return "USD";
      if (pattern.includes("\\d") || DECIMAL_HINT.test(name)) return "125.00";
      if (/email/i.test(name)) return "name@example.com";
      return name ? `Sample ${name}` : "Sample text";
    }
    case "integer":
      return 3;
    case "number":
      return 12.5;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array": {
      const items = isPlainObject(schema.items) ? (schema.items as JsonSchema) : undefined;
      return [sampleFromSchema(items, name, depth + 1), sampleFromSchema(items, name, depth + 1)];
    }
    case "object": {
      const props = isPlainObject(schema.properties)
        ? (schema.properties as Record<string, JsonSchema>)
        : {};
      return Object.fromEntries(
        Object.entries(props).map(([k, s]) => [k, sampleFromSchema(s, k, depth + 1)]),
      );
    }
    default:
      return name ? `Sample ${name}` : null;
  }
}
