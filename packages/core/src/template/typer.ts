// P-4
import { typedResultOutput } from "../converse";
import { isPlainObject } from "../json";
import type { AnyAutomationDefinition, AutomationDefinition } from "../schemas/automation";
import type { JsonSchema } from "../schemas/common";
import { parseSkillRef } from "../schemas/common";
import type { EventTypeSpec } from "../schemas/event";
import type { SkillDefinition } from "../schemas/skill";
import type { ToolSpec } from "../schemas/tool";
import type { Step, TriggerOn, Workflow } from "../schemas/workflow";
import { allTriggers, HANDOFF_PAYLOAD, MESSAGE_PAYLOAD } from "../triggers/kinds";
import { mergeTriggerSchemas } from "../triggers/typing";
import { type StepLocation, walkSteps } from "../workflow/walk";
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
  automations?: Record<string, AnyAutomationDefinition>;
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

// v0.12 W2-E: every trigger of the workflow (`moreTriggers`) types `{{trigger.…}}`; a field some
// triggers lack is optional (docs/plan.md §1.48).
export function triggerSchema(workflow: Workflow, ctx: TypingContext): JsonSchema | undefined {
  return mergeTriggerSchemas(allTriggers(workflow).map((t) => triggerOnSchema(t.on, ctx)));
}

/** What one trigger puts in `{{trigger.…}}`. */
export function triggerOnSchema(on: TriggerOn, ctx: TypingContext): JsonSchema | undefined {
  switch (on.type) {
    // v0.12 W2-E: a webhook trigger is sugar over `webhook.received`; messages and handoffs have
    // their own payloads.
    case "webhook":
      return ctx.events?.["webhook.received"]?.payload;
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
  }
}

export function outputSchemaOf(step: Step, ctx: TypingContext): JsonSchema | undefined {
  switch (step.kind) {
    case "skill": {
      const def = lookupSkill(step.skill, ctx);
      // P-4: a conversation's `result` is typed by the step's own result schema (§1.66).
      if (def?.resultFromInput)
        return typedResultOutput(def.output, def.resultFromInput, step.input);
      return def?.output;
    }
    case "action":
      return ctx.tools?.[step.tool]?.output;
    case "person":
      return PERSON_OUTPUT;
    case "fork":
      return FORK_OUTPUT;
    case "for_each":
      return FOR_EACH_OUTPUT;
    // v0.12 W2-B
    case "use_automation": {
      const def = ctx.automations?.[step.automation];
      // Wave 3b: a v3 use step pins v3 automations only (validation refuses a v4 one).
      return def && def.schemaVersion === 1 ? automationOutputSchema(def, ctx) : undefined;
    }
    default:
      return NO_OUTPUT;
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

/** What references are in scope at a step. */
export interface Scope {
  trigger: JsonSchema | undefined;
  // v0.12 W2-B
  /** Inside an automation: its input schema. There is no trigger there; `{{input...}}` instead. */
  input?: { schema: JsonSchema | undefined };
  /** Upstream steps visible here, by id, with their output schemas. */
  steps: Record<string, { step: Step; output: JsonSchema | undefined }>;
  /** Inside a for_each: the item schema (undefined when unknown). */
  loop?: { item: JsonSchema | undefined; step: Step };
}

function itemSchemaOf(over: string, scope: Omit<Scope, "loop"> & { loop?: Scope["loop"] }) {
  let path: string[] | null;
  try {
    path = singleRef(over);
  } catch {
    return undefined;
  }
  if (!path) return undefined;
  const t = typeTemplatePath(scope as Scope, path);
  if (!t.ok || !t.schema) return undefined;
  const items = t.schema.items;
  return isPlainObject(items) ? (items as JsonSchema) : undefined;
}

function scopeFor(
  workflow: Workflow,
  loc: StepLocation,
  ctx: TypingContext,
  byId: Map<string, Step>,
): Scope {
  return scopeFrom({ trigger: triggerSchema(workflow, ctx), steps: {} }, loc, ctx, byId);
}

function scopeFrom(
  scope: Scope,
  loc: Pick<StepLocation, "before" | "loops">,
  ctx: TypingContext,
  byId: Map<string, Step>,
): Scope {
  for (const id of loc.before) {
    const s = byId.get(id);
    if (s) scope.steps[id] = { step: s, output: outputSchemaOf(s, ctx) };
  }
  const loop = loc.loops.at(-1);
  if (loop) scope.loop = { step: loop, item: itemSchemaOf(loop.over, scope) };
  return scope;
}

/** The scope at a step, or undefined when the step isn't in the workflow. */
export function scopeAt(workflow: Workflow, stepId: string, ctx: TypingContext = {}) {
  const byId = new Map<string, Step>();
  let found: StepLocation | undefined;
  walkSteps(workflow, (loc) => {
    byId.set(loc.step.id, loc.step);
    if (loc.step.id === stepId) found = loc;
  });
  return found ? scopeFor(workflow, found, ctx, byId) : undefined;
}

/** Scopes for every step at once (validation uses this). */
export function scopes(workflow: Workflow, ctx: TypingContext = {}): Map<string, Scope> {
  const byId = new Map<string, Step>();
  const locs: StepLocation[] = [];
  walkSteps(workflow, (loc) => {
    byId.set(loc.step.id, loc.step);
    locs.push(loc);
  });
  return new Map(locs.map((l) => [l.step.id, scopeFor(workflow, l, ctx, byId)]));
}

/** The type of a workflow reference (`trigger...`, `steps.<id>.output...`, `item...`, `index`). */
export function typeTemplatePath(scope: Scope, path: readonly string[]): PathType {
  const [root, ...rest] = path;
  switch (root) {
    case "trigger":
      // v0.12 W2-B
      if (scope.input) {
        return { ok: false, message: "an automation has no trigger: use {{input.<field>}}" };
      }
      return schemaAtPath(scope.trigger, rest);
    // v0.12 W2-B
    case "input":
      if (!scope.input) {
        return { ok: false, message: "{{input}} is only available inside an automation" };
      }
      return schemaAtPath(scope.input.schema, rest);
    case "steps": {
      const [id, output, ...tail] = rest;
      if (id === undefined) return { ok: false, message: "steps.<id>.output... needs a step id" };
      const s = scope.steps[id];
      if (!s) {
        return {
          ok: false,
          message: `step "${id}" does not run before this one on its path`,
        };
      }
      if (output !== "output") {
        return { ok: false, message: `use steps.${id}.output.<field>` };
      }
      return schemaAtPath(s.output, tail);
    }
    case "item":
      if (!scope.loop)
        return { ok: false, message: "{{item}} is only available inside a for_each" };
      return schemaAtPath(scope.loop.item, rest);
    case "index":
      if (!scope.loop)
        return { ok: false, message: "{{index}} is only available inside a for_each" };
      if (rest.length > 0) return { ok: false, message: "{{index}} is a number" };
      return { ok: true, schema: { type: "integer" } };
    default:
      return {
        ok: false,
        message: `unknown reference "${root}": use trigger, steps, item or index`,
      };
  }
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

/** Every reference the field picker offers at a step, depth-limited. */
export function pathsAt(
  workflow: Workflow,
  stepId: string,
  ctx: TypingContext = {},
  depth = 4,
): PathOption[] {
  const scope = scopeAt(workflow, stepId, ctx);
  if (!scope) return [];
  const out: PathOption[] = [];
  listPaths(scope.trigger, "trigger", depth, out, undefined);
  for (const [id, { output }] of Object.entries(scope.steps)) {
    listPaths(output, `steps.${id}.output`, depth, out, id);
  }
  if (scope.loop) {
    listPaths(scope.loop.item, "item", depth, out, undefined);
    out.push({ path: "index", schema: { type: "integer" } });
  }
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

/** Scopes for every step of an automation: `{{input...}}` in place of the trigger. */
export function automationScopes(
  automation: Pick<AutomationDefinition, "steps" | "input">,
  ctx: TypingContext = {},
): Map<string, Scope> {
  const byId = new Map<string, Step>();
  const locs: StepLocation[] = [];
  walkSteps(automation, (loc) => {
    byId.set(loc.step.id, loc.step);
    locs.push(loc);
  });
  const base = (): Scope => ({
    trigger: undefined,
    input: { schema: automation.input },
    steps: {},
  });
  return new Map(locs.map((l) => [l.step.id, scopeFrom(base(), l, ctx, byId)]));
}

/** What the automation's `output` template reads: its input and every top-level step. */
export function automationEndScope(
  automation: Pick<AutomationDefinition, "steps" | "input">,
  ctx: TypingContext = {},
): Scope {
  const scope: Scope = { trigger: undefined, input: { schema: automation.input }, steps: {} };
  for (const s of automation.steps) scope.steps[s.id] = { step: s, output: outputSchemaOf(s, ctx) };
  return scope;
}

function literalSchema(value: unknown): JsonSchema {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "boolean") return { type: "boolean" };
  return {};
}

/**
 * The schema of a use step's output: the automation's `output`, each field typed from what it
 * references (one whole reference keeps its type; text is a string; anything else unknown).
 */
export function automationOutputSchema(
  automation: Pick<AutomationDefinition, "steps" | "input" | "output">,
  ctx: TypingContext = {},
): JsonSchema {
  // No nesting (validation refuses it): an inner use step is typed as unknown, never recursed into.
  const flat: TypingContext = { ...ctx, automations: {} };
  const scope = automationEndScope(automation, flat);
  return outputTemplateSchema(automation.output, (path) => typeTemplatePath(scope, path));
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
