// P-4

import { typedResultOutput } from "../converse";
import { isPlainObject } from "../json";
import { REPORT_TRIGGER_SCHEMA } from "../process/collect";
import type { AutomationDefinition } from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { EventTypeSpec } from "../schemas/event";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolInputVariants, ToolSpec } from "../schemas/tool";
import type { TriggerOn } from "../schemas/workflow";
import { allTriggers, HANDOFF_PAYLOAD, MESSAGE_PAYLOAD } from "../triggers/kinds";
import { webhookPayloadWithData } from "../triggers/sample";
import { mergeTriggerSchemas } from "../triggers/typing";
import { singleRef } from "./template";

/**
 * Template typing (docs/plan.md §1.2): which references are valid at a step, and their JSON
 * Schemas, from the trigger payload and upstream outputs. The builder's field picker and workflow
 * validation share it. An unknown schema (`undefined` or `{}`) accepts any path.
 */

export interface TypingContext {
  skills?: Record<string, SkillDefinition>;
  tools?: Record<string, ToolSpec>;
  events?: Record<string, EventTypeSpec>;
  // v0.12 W2-B
  /** Automation versions by their pinned reference (`slug@version`). */
  automations?: Record<string, AutomationDefinition>;
  /**
   * The owning agent's skills with its parameter values (`definition.skills`), when known: a Read
   * table step's output is typed by its effective columns, the step's own over the agent's
   * (docs/plan.md §1.164). A process's validation context gives them as its `agent`; absent
   * both, only the step's own and the skill's default count.
   */
  agentSkills?:
    | readonly {
        skill: string;
        parameters?: Readonly<Record<string, unknown>> | undefined;
      }[]
    | undefined;
  // docs/plan.md §1.164 step 3
  /**
   * Tool inputs typed from a client's own connection (a CRM's fields per module), by tool id: the
   * builder's and Reshape's typing of a step's input (`toolInputSchema`). Validation at publish
   * types with the tools' own inputs.
   */
  toolInputs?: Record<string, ToolInputVariants>;
}

/**
 * What a step calling `toolId` with `input` takes: the variant its literal `by` input picks
 * (`ctx.toolInputs`), else the tool's own input.
 */
export function toolInputSchema(
  toolId: string,
  input: Record<string, unknown> | undefined,
  ctx: TypingContext,
): JsonSchema | undefined {
  const variants = ctx.toolInputs?.[toolId];
  const value = variants ? input?.[variants.by] : undefined;
  if (variants && typeof value === "string" && Object.hasOwn(variants.schemas, value)) {
    return variants.schemas[value];
  }
  return ctx.tools?.[toolId]?.input;
}

export type PathType =
  | { ok: true; schema: JsonSchema | undefined }
  | { ok: false; message: string };

const OBJ = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** What a `person` step outputs, so a later fork can branch on it (ARCHITECTURE §10.1). */
export const PERSON_OUTPUT: JsonSchema = OBJ(
  { approved: { type: "boolean" }, answer: {}, by: { type: "string" } },
  ["approved"],
);
/** A fork exposes which path ran. */
export const FORK_OUTPUT: JsonSchema = OBJ(
  { pathId: { type: "string" }, pathName: { type: "string" } },
  ["pathId", "pathName"],
);
export const FOR_EACH_OUTPUT: JsonSchema = OBJ({ count: { type: "integer" } }, ["count"]);
export const NO_OUTPUT: JsonSchema = OBJ({});
// DECISION: schedule triggers carry the tick they are for; command triggers the text after the
// command. Event and manual triggers carry their declared payload.
export const SCHEDULE_PAYLOAD: JsonSchema = OBJ({ scheduledAt: { type: "string" } }, [
  "scheduledAt",
]);
export const COMMAND_PAYLOAD: JsonSchema = OBJ({ args: { type: "string" } }, ["args"]);

export function lookupSkill(ref: string, ctx: TypingContext): SkillDefinition | undefined {
  return ctx.skills?.[ref] ?? ctx.skills?.[parseSkillRef(ref).id];
}

/** What one trigger puts in `{{trigger.…}}`. */
export function triggerOnSchema(on: TriggerOn, ctx: TypingContext): JsonSchema | undefined {
  switch (on.type) {
    // v0.12 W2-E: a webhook trigger is sugar over `webhook.received`; messages and handoffs have
    // their own payloads.
    case "webhook": {
      const payload = ctx.events?.["webhook.received"]?.payload;
      // §1.164: a pasted sample's shape types the delivery's data.
      return on.dataSchema ? webhookPayloadWithData(payload, on.dataSchema) : payload;
    }
    case "message":
      return MESSAGE_PAYLOAD;
    case "handoff":
      return HANDOFF_PAYLOAD;
    case "event":
      return ctx.events?.[on.event]?.payload;
    case "manual":
      return on.input;
    case "schedule":
      return SCHEDULE_PAYLOAD;
    case "command":
      return COMMAND_PAYLOAD;
    // Collect reports (owner, 2026-11-24): the report that started the run.
    case "report":
      return REPORT_TRIGGER_SCHEMA;
  }
}

function isUnknown(schema: JsonSchema | undefined): boolean {
  return schema === undefined || Object.keys(schema).length === 0;
}

function resolveRef(schema: JsonSchema, root: JsonSchema | undefined): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !root || !ref.startsWith("#/")) return schema;
  let cur: unknown = root;
  for (const seg of ref.slice(2).split("/")) {
    cur = isPlainObject(cur) ? cur[seg.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  }
  return isPlainObject(cur) ? (cur as JsonSchema) : {};
}

function types(schema: JsonSchema): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  if (isPlainObject(schema.properties)) return ["object"];
  if (schema.items !== undefined) return ["array"];
  return [];
}

/** The schema at `path` inside `schema`, or why the path doesn't exist. */
export function schemaAtPath(
  schema: JsonSchema | undefined,
  path: readonly string[],
  root: JsonSchema | undefined = schema,
): PathType {
  if (path.length === 0) return { ok: true, schema };
  if (schema === undefined || isUnknown(schema)) return { ok: true, schema: undefined };
  const s = resolveRef(schema, root);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const alts = s[key];
    if (Array.isArray(alts)) {
      for (const alt of alts) {
        if (!isPlainObject(alt)) continue;
        const r = schemaAtPath(alt as JsonSchema, path, root);
        if (r.ok) return r;
      }
      if (types(s).length === 0) return { ok: false, message: `no field "${path[0]}"` };
    }
  }
  const [seg, ...rest] = path as [string, ...string[]];
  const ts = types(s);
  if (ts.length === 0) return { ok: true, schema: undefined };
  if (ts.includes("array")) {
    if (seg === "length") return schemaAtPath({ type: "integer" }, rest, root);
    if (/^\d+$/.test(seg)) {
      const items = isPlainObject(s.items) ? (s.items as JsonSchema) : undefined;
      return schemaAtPath(items, rest, root);
    }
  }
  if (ts.includes("string") && seg === "length")
    return schemaAtPath({ type: "integer" }, rest, root);
  if (ts.includes("object")) {
    const props = isPlainObject(s.properties) ? (s.properties as Record<string, unknown>) : {};
    if (Object.hasOwn(props, seg) && isPlainObject(props[seg])) {
      return schemaAtPath(props[seg] as JsonSchema, rest, root);
    }
    const extra = s.additionalProperties;
    if (isPlainObject(extra)) return schemaAtPath(extra as JsonSchema, rest, root);
    // An object with declared properties is closed unless it says otherwise: the field picker
    // and validation should catch a misspelt field rather than let it resolve to nothing.
    if (extra === true || !isPlainObject(s.properties)) return { ok: true, schema: undefined };
    return { ok: false, message: `no field "${seg}"` };
  }
  return { ok: false, message: `"${seg}" is not a field of a ${ts.join("/")}` };
}

export interface PathOption {
  /** The reference to insert, without braces, e.g. "steps.extract.output.total". */
  path: string;
  schema: JsonSchema | undefined;
  /** The step it comes from, when it is a step output. */
  stepId?: string;
}

function listPaths(
  schema: JsonSchema | undefined,
  prefix: string,
  depth: number,
  out: PathOption[],
  stepId: string | undefined,
  root: JsonSchema | undefined = schema,
) {
  const push = (path: string, s: JsonSchema | undefined) =>
    out.push(stepId ? { path, schema: s, stepId } : { path, schema: s });
  push(prefix, schema);
  if (!schema || depth <= 0) return;
  const s = resolveRef(schema, root);
  const ts = types(s);
  if (ts.includes("object") && isPlainObject(s.properties)) {
    for (const [k, v] of Object.entries(s.properties)) {
      if (isPlainObject(v))
        listPaths(v as JsonSchema, `${prefix}.${k}`, depth - 1, out, stepId, root);
    }
  }
  if (ts.includes("array")) push(`${prefix}.length`, { type: "integer" });
}

/**
 * R8: every reference under one root (`trigger`, `steps.<id>.output`, `item`), depth-limited, as
 * the field picker offers them. The v4 builder lists a process scope's roots with it.
 */
export function pathOptions(
  schema: JsonSchema | undefined,
  prefix: string,
  depth = 4,
  stepId?: string,
): PathOption[] {
  const out: PathOption[] = [];
  listPaths(schema, prefix, depth, out, stepId);
  return out;
}

/** The JSON type of a literal value (`integer` for a whole number). */
export function jsonTypeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

/** Whether a value of the `actual` types fits a field of the `accepted` (unknown fits anything). */
export function typesCompatible(accepted: string[], actual: string[]): boolean {
  if (accepted.length === 0 || actual.length === 0) return true;
  return actual.some(
    (t) => accepted.includes(t) || (t === "integer" && accepted.includes("number")),
  );
}

/** JSON type names a value or schema can take, for compatibility checks. */
export function schemaTypes(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  return types(schema);
}

// ── v0.12 W2-B: automations (ARCHITECTURE §10.7) ────────────────────────────────────────────────

function literalSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "boolean") return { type: "boolean" };
  return {};
}

/**
 * An `output` template object typed field by field (one whole reference keeps its type; text is a
 * string; anything else unknown), with `typePath` typing a reference. Wave 3b: shared by v3 and
 * v4 automations.
 */
export function outputTemplateSchema(
  output: Record<string, unknown>,
  typePath: (path: string[]) => PathType,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(output)) {
    let schema: JsonSchema = {};
    if (typeof value === "string" && value.includes("{{")) {
      let path: string[] | null = null;
      try {
        path = singleRef(value);
      } catch {
        path = null;
      }
      if (!path) schema = { type: "string" };
      else {
        const t = typePath(path);
        schema = t.ok && t.schema ? t.schema : {};
      }
    } else if (!isPlainObject(value)) schema = literalSchema(value);
    properties[key] = schema;
  }
  return OBJ(properties, Object.keys(properties));
}
