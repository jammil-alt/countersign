// What each step of a v5 workflow hands on to the steps after it, as a JSON Schema: the shape a
// reference `{{steps.<id>.output.…}}` reads at run time. Publishing checks every reference against
// it (`process/step-model-refs.ts`), so a field that a step never hands on is found when the
// workflow is published, not as an empty input three steps later in a run (staging, 2026-11-27:
// "Check the items" ran with no vendor; "Read the employee's answers" read `answers` from a Fork,
// which handed on only its path).
//
// The shapes are what the executor records (`packages/workflows/src/executor.ts`), not what a step
// declares: a person step hands on `approved`, `answer` and `by` whatever output it lists. Where
// the shape isn't known (a tool or skill the context doesn't have, a write, a Wait), it is `{}`,
// which accepts any path: a check that can't tell says nothing rather than refuse a good workflow.
// Pure.

import { isPlainObject } from "../json";
import type { JsonSchema } from "../schemas/common";
import { lookupSkill, type TypingContext } from "../template/typer";
import { actionKind } from "./catalog";
import { doEngine } from "./engine";
import { matchResultFields } from "./match-profile";
import type { DoStep, Field, Step } from "./schema";

/** Any shape: every path is accepted. */
const UNKNOWN: JsonSchema = {};

/** An open object: these fields as typed, anything else accepted. */
function open(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, additionalProperties: true };
}

/** A closed object of these fields: a path to any other field is refused. */
function closed(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

// Every Do step may hand on the records its result rests on (invariant 10).
const SOURCES: JsonSchema = { type: "array", items: { type: "string" } };

/**
 * A field as the shape a reference walks: like `translate.fieldSchema`, except that a group or a
 * list whose fields aren't given is any shape, not an empty closed object.
 */
export function fieldShape(field: Field): JsonSchema {
  switch (field.type) {
    case "number":
      return { type: "number" };
    case "yes_no":
      return { type: "boolean" };
    case "group":
      return field.of && field.of.length > 0 ? fieldsShape(field.of) : UNKNOWN;
    case "list":
      return {
        type: "array",
        items: field.of && field.of.length > 0 ? fieldsShape(field.of) : UNKNOWN,
      };
    default:
      // text, money (a decimal string), date (ISO text), record (its id)
      return { type: "string" };
  }
}

/** Fields as one closed object, with `sources` beside them. */
export function fieldsShape(fields: readonly Field[], extra: Record<string, JsonSchema> = {}) {
  return closed({ ...Object.fromEntries(fields.map((f) => [f.name, fieldShape(f)])), ...extra });
}

/** A JSON Schema from a tool or skill, closed only where it declares its properties. */
function declared(schema: JsonSchema | undefined): JsonSchema {
  if (!isPlainObject(schema)) return UNKNOWN;
  const props = (schema as { properties?: unknown }).properties;
  if (!isPlainObject(props) || Object.keys(props).length === 0) return UNKNOWN;
  // `sources` is handed on beside a result that declares it or not.
  return {
    ...schema,
    properties: { sources: SOURCES, ...(props as Record<string, JsonSchema>) },
  } as JsonSchema;
}

// A merged action (Accounting, Email) runs one of several tools, chosen by what is connected, so
// its output is only the tool's own when the context has it under the action's id.
function toolOutput(action: string, ctx: TypingContext): JsonSchema | undefined {
  return ctx.tools?.[action]?.output;
}

function kindOf(ctx: TypingContext) {
  return (action: string) => {
    const spec = ctx.tools?.[action];
    return spec ? actionKind(spec) : undefined;
  };
}

function doShape(step: DoStep, ctx: TypingContext): JsonSchema {
  let engine: ReturnType<typeof doEngine>;
  try {
    engine = doEngine(step, kindOf(ctx));
  } catch {
    return UNKNOWN; // a combination the validator refuses on its own
  }
  switch (engine.engine) {
    case "read":
      return declared(toolOutput(engine.action, ctx));
    case "rules":
    case "ai":
      // A library skill hands on its output; a step written in place, the output it lists.
      if (engine.skill !== undefined) return declared(lookupSkill(engine.skill, ctx)?.output);
      return step.output && step.output.length > 0
        ? fieldsShape(step.output, { sources: SOURCES })
        : UNKNOWN;
    case "match": {
      const fields = matchResultFields({ record: "record", input: [] });
      return fieldsShape(fields, { sources: SOURCES });
    }
    case "person":
      // What the executor records for a person, whatever the step lists (`Executor.person`).
      return closed({
        approved: { type: "boolean" },
        answer: UNKNOWN,
        by: { type: ["string", "null"] },
        proceeded: { type: "boolean" },
      });
    case "contact":
      // The conversation's own fields, and what it found by the names the step lists.
      return closed({
        ...Object.fromEntries((step.output ?? []).map((f) => [f.name, fieldShape(f)])),
        status: { type: "string" },
        found: UNKNOWN,
        summary: { type: "string" },
        conversationId: { type: "string" },
        sources: SOURCES,
      });
    default:
      // A write, a Tell, a collect, an automation, a missing step: not checked here.
      return UNKNOWN;
  }
}

/**
 * What the step a list ends on gave, which a Fork's path or a For each's item hands on; null for
 * an empty list or one that ends the run (an End), which hands nothing on to a step after it.
 */
function lastShape(list: readonly Step[], ctx: TypingContext): JsonSchema | null {
  const last = list.at(-1);
  if (!last || last.kind === "end") return null;
  return handsOn(last, ctx);
}

/** Every property of an object shape, or null when it isn't a closed object. */
function propsOf(shape: JsonSchema): Record<string, JsonSchema> | null {
  const s = shape as { type?: unknown; properties?: unknown; additionalProperties?: unknown };
  if (s.type !== "object" || !isPlainObject(s.properties) || s.additionalProperties === true) {
    return null;
  }
  return s.properties as Record<string, JsonSchema>;
}

/** What a step hands on to the steps after it. */
export function handsOn(step: Step, ctx: TypingContext = {}): JsonSchema {
  switch (step.kind) {
    case "do":
      return doShape(step, ctx);
    case "loop":
      return step.output.length > 0 ? fieldsShape(step.output, { sources: SOURCES }) : UNKNOWN;
    case "fork": {
      // Which path ran, and what that path's last step gave (`Executor.join`). Any path may have
      // run, so a field one of them gives is a field of the fork's; an empty path gives nothing.
      const path = { pathId: { type: "string" }, pathName: { type: "string" } };
      const merged: Record<string, JsonSchema> = {};
      for (const list of [...step.paths.map((p) => p.steps), step.otherwise.steps]) {
        const shape = lastShape(list, ctx);
        if (shape === null) continue;
        const props = propsOf(shape);
        if (props === null) return open(path);
        for (const [k, v] of Object.entries(props)) merged[k] ??= v;
      }
      return closed({ ...merged, ...path });
    }
    case "for_each": {
      // How many, how many failed, and each item's last step's output in order (null if failed).
      const item = lastShape(step.steps, ctx) ?? UNKNOWN;
      return closed({
        count: { type: "integer" },
        failed: { type: "integer" },
        itemsTooLarge: { type: "boolean" },
        items: { type: "array", items: item },
      });
    }
    default:
      // Repeat, Wait, Hand off, End: not read by name today.
      return UNKNOWN;
  }
}
