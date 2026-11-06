// `{{trigger.…}}` for a workflow with more than one trigger (ARCHITECTURE §10.1): the run's trigger
// is whichever fired, so a field is typed from every trigger that has it, and a field some
// triggers lack is optional (it may be empty), never an error.

import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";

function isUnknown(schema: JsonSchema | undefined): boolean {
  return schema === undefined || Object.keys(schema).length === 0;
}

function isObjectSchema(s: JsonSchema): boolean {
  return s.type === "object" || (s.type === undefined && isPlainObject(s.properties));
}

/**
 * One schema for the payloads of several triggers. Unknown if any is unknown (any path reads) or
 * any isn't an object; otherwise an object with every trigger's fields, required only where every
 * trigger requires them, closed only when every one is closed. A field two triggers type
 * differently is either (`anyOf`).
 */
export function mergeTriggerSchemas(
  schemas: readonly (JsonSchema | undefined)[],
): JsonSchema | undefined {
  if (schemas.length === 0) return undefined;
  if (schemas.length === 1) return schemas[0];
  if (schemas.some(isUnknown)) return undefined;
  const all = schemas as JsonSchema[];
  if (!all.every(isObjectSchema)) return undefined;
  const props = new Map<string, JsonSchema[]>();
  for (const s of all) {
    const p = isPlainObject(s.properties) ? (s.properties as Record<string, unknown>) : {};
    for (const [k, v] of Object.entries(p)) {
      if (!isPlainObject(v)) continue;
      props.set(k, [...(props.get(k) ?? []), v as JsonSchema]);
    }
  }
  const properties: Record<string, JsonSchema> = {};
  for (const [k, list] of props) {
    const distinct = list.filter(
      (v, i) => list.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i,
    );
    properties[k] =
      distinct.length === 1
        ? (distinct[0] as JsonSchema)
        : distinct.some(isUnknown)
          ? {}
          : { anyOf: distinct };
  }
  const requiredOf = (s: JsonSchema) =>
    new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const first = requiredOf(all[0] as JsonSchema);
  const required = [...first].filter((k) => all.every((s) => requiredOf(s).has(k)));
  // Template typing reads an object with declared fields as closed unless it says otherwise.
  const closed = all.every(
    (s) =>
      isPlainObject(s.properties) &&
      s.additionalProperties !== true &&
      !isPlainObject(s.additionalProperties),
  );
  return { type: "object", properties, required, additionalProperties: !closed };
}
