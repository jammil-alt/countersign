// An automation's two ends in the one-screen builder (docs/builder-plan.md §12.1, F7): what it
// takes in (`definition.input`, a JSON Schema object) and what it gives back (`definition.output`,
// a template over its input and its top-level steps), as rows a person edits, and back. Also the
// automation as the builder's own editing model reads it: one process with no trigger, kept in a
// bundle so `../../builder/model`'s edits and History apply unchanged. Pure; no React.
import {
  type AutomationDefinition,
  isPlainObject,
  type JsonSchema,
  type PathOption,
  pathOptions,
  processes,
  type TypingContext,
} from "@countersign/core";
import type { Process, ProcessAgentBundle } from "../../builder/model";
import { type Namer, referenceLabel } from "../../builder/problems";
import type { FlowEnds } from "../types";

// ── Takes in ─────────────────────────────────────────────────────────────────────────────────────

/** What a field holds, in the words the panel offers. */
export type InputType = "string" | "number" | "boolean" | "array" | "object" | "any";

export const INPUT_TYPES: { value: InputType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Yes or no" },
  { value: "array", label: "List" },
  { value: "object", label: "Record" },
  { value: "any", label: "Anything" },
];

/** One field the automation takes in. */
export interface InputField {
  /** Stable while the panel is open (a name being typed may be empty or a duplicate). */
  key: string;
  name: string;
  type: InputType;
  required: boolean;
  description: string;
  /**
   * The rest of the field's schema as stored (its exact `type`, an enum, a list's items), kept as
   * it was while the field's type stays the same.
   */
  rest: JsonSchema;
}

/** A field's name is what steps read it by (`{{input.<name>}}`): letters, digits and `_`. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function typeOf(schema: JsonSchema): InputType {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== "null") : schema.type;
  if (t === "integer" || t === "number") return "number";
  if (t === "string" || t === "boolean" || t === "array" || t === "object") return t;
  return isPlainObject(schema.properties) ? "object" : "any";
}

/** The fields of an input schema, in its order. */
export function inputFields(schema: JsonSchema | undefined): InputField[] {
  const props = isPlainObject(schema?.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as unknown[]) : []);
  return Object.entries(props).map(([name, raw]) => {
    const s: JsonSchema = isPlainObject(raw) ? raw : {};
    const { description, ...rest } = s;
    return {
      key: name,
      name,
      type: typeOf(s),
      required: required.has(name),
      description: typeof description === "string" ? description : "",
      rest,
    };
  });
}

/** A new, empty row. */
export function newInputField(key: string): InputField {
  return { key, name: "", type: "string", required: true, description: "", rest: {} };
}

/** A row with another type: what the stored schema said about the old type goes. */
export function withInputType(field: InputField, type: InputType): InputField {
  return field.type === type ? field : { ...field, type, rest: {} };
}

/**
 * The input schema the fields say. Nameless rows are left out and a repeated name keeps its first
 * row (the panel says so: `inputProblems`); anything else on the schema is kept as it was.
 */
export function inputSchema(fields: readonly InputField[], before?: JsonSchema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const f of fields) {
    const name = f.name.trim();
    if (!name || Object.hasOwn(properties, name)) continue;
    const description = f.description.trim();
    properties[name] = {
      // The stored `type` (an `integer`, say) stays; a new or retyped field gets the plain one.
      ...(f.rest.type === undefined && f.type !== "any" ? { type: f.type } : {}),
      ...f.rest,
      ...(description ? { description } : {}),
    };
    if (f.required) required.push(name);
  }
  const { required: _required, properties: _properties, ...rest } = before ?? {};
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/** What is wrong with the rows as typed, by row key, in plain words. */
export function inputProblems(fields: readonly InputField[]): Map<string, string> {
  return nameProblems(fields, "field");
}

function nameProblems(
  rows: readonly { key: string; name: string }[],
  noun: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) out.set(r.key, `Give this ${noun} a name.`);
    else if (!FIELD_NAME.test(name)) {
      out.set(r.key, "Use letters, digits and _ only, starting with a letter.");
    } else if (seen.has(name)) out.set(r.key, `Another ${noun} is already called ${name}.`);
    seen.add(name);
  }
  return out;
}

const TYPE_WORD: Record<InputType, string> = {
  string: "text",
  number: "number",
  boolean: "yes or no",
  array: "list",
  object: "record",
  any: "anything",
};

/** "customer · text", "note · text, optional": a field on the chart's Takes in box. */
export function inputLine(f: Pick<InputField, "name" | "type" | "required">): string {
  return `${f.name || "Unnamed"} · ${TYPE_WORD[f.type]}${f.required ? "" : ", optional"}`;
}

// ── Gives back ───────────────────────────────────────────────────────────────────────────────────

/** One field the automation gives back: a name and where its value comes from. */
export interface OutputField {
  key: string;
  name: string;
  /** Text that may hold `{{…}}` references, or any other JSON value kept as stored. */
  value: unknown;
}

export function outputFields(output: Record<string, unknown> | undefined): OutputField[] {
  return Object.entries(output ?? {}).map(([name, value]) => ({ key: name, name, value }));
}

/** The output template the rows say (nameless rows left out; a repeated name keeps its first). */
export function outputTemplate(fields: readonly OutputField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const name = f.name.trim();
    if (!name || Object.hasOwn(out, name)) continue;
    out[name] = f.value;
  }
  return out;
}

export function outputProblems(fields: readonly OutputField[]): Map<string, string> {
  const out = nameProblems(fields, "field");
  for (const f of fields) {
    if (!out.has(f.key) && (f.value === "" || f.value === undefined)) {
      out.set(f.key, "Pick what it gives back here.");
    }
  }
  return out;
}

const WHOLE_REF = /^\{\{\s*([^}]+?)\s*\}\}$/;
const ANY_REF = /\{\{\s*([^}]+?)\s*\}\}/g;

/** A value in words: "Draft the note · summary", "Sent to Input · customer", "A fixed value". */
export function valueWords(value: unknown, name: Namer): string {
  if (typeof value !== "string") return value === undefined ? "Nothing yet" : "A fixed value";
  if (value.trim() === "") return "Nothing yet";
  const whole = WHOLE_REF.exec(value.trim());
  if (whole?.[1]) return referenceLabel(whole[1], name);
  return value.replace(ANY_REF, (_, expr: string) => referenceLabel(expr, name));
}

/** "summary: Draft the note · summary": a field on the chart's Gives back box. */
export function outputLine(f: Pick<OutputField, "name" | "value">, name: Namer): string {
  return `${f.name || "Unnamed"}: ${valueWords(f.value, name)}`;
}

/**
 * What a Gives back value may read: what the automation takes in and what its top-level steps
 * give (the validator's `output` scope), as the builder's field picker lists them.
 */
export function outputPaths(
  def: Pick<AutomationDefinition, "input" | "steps">,
  ctx: TypingContext,
): PathOption[] {
  const out: PathOption[] = [...pathOptions(def.input, "input")];
  for (const step of def.steps) {
    out.push(
      ...pathOptions(processes.stepOutputSchema(step, ctx), `steps.${step.id}.output`, 4, step.id),
    );
  }
  return out;
}

// ── The chart's two end boxes ────────────────────────────────────────────────────────────────────

/** "Takes in" and "Gives back" as the chart draws them. */
export function automationEnds(
  def: Pick<AutomationDefinition, "input" | "output">,
  name: Namer,
): FlowEnds {
  // The chart shows the first line and "and N more"; pointing at the box lists them all.
  const lines = (all: string[], none: string) => (all.length > 0 ? all : [none]);
  return {
    start: {
      title: "Takes in",
      lines: lines(inputFields(def.input).map(inputLine), "Nothing. Add what it needs to start."),
    },
    givesBack: {
      title: "Gives back",
      lines: lines(
        outputFields(def.output).map((f) => outputLine(f, name)),
        "Nothing yet. Pick what later steps can use.",
      ),
    },
  };
}

// ── The automation as the builder's editing model reads it ───────────────────────────────────────

/** What of an automation the builder edits beside its steps. */
export interface AutomationFace {
  name: string;
  description: string;
  input: JsonSchema;
  output: Record<string, unknown>;
}

/**
 * The editor's draft: the automation's steps as the one process of a bundle (so the builder's
 * edits, its inspector and its History apply as they are), with its name, input and output beside
 * them so one undo covers those too. The bundle's agent is a stand-in: nothing of it is saved.
 */
// DECISION (F7): a stand-in bundle around the steps, rather than a second editing model and a
// second undo for automations: the builder's operations, inspector and History all take a bundle.
export type AutomationDraft = ProcessAgentBundle & { automation: AutomationFace };

export function toDraft(def: AutomationDefinition): AutomationDraft {
  const bundle = {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      // Read by the inspector where a step is the agent's to decide ("… says it's done").
      identity: { name: "the agent using it", role: "", mission: "" },
      kind: "functional",
      model: { id: "automation", maxTokens: 4096 },
      instructions: "",
      skills: [],
      extraTools: [],
      // An automation's writes keep their approval; the agent using it sets its own mode.
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: def.slug,
        name: def.name,
        workflow: { schemaVersion: 4, triggers: [], steps: def.steps },
      },
    ],
  } as unknown as ProcessAgentBundle;
  return {
    ...bundle,
    automation: {
      name: def.name,
      description: def.description,
      input: def.input,
      output: def.output,
    },
  };
}

/** The draft's one process. */
export function draftProcess(draft: AutomationDraft): Process {
  const w = draft.workflows[0]?.workflow;
  return w ?? ({ schemaVersion: 4, triggers: [], steps: [] } as unknown as Process);
}

/** The draft with its process changed. */
export function withProcess(draft: AutomationDraft, process: Process): AutomationDraft {
  const [first, ...rest] = draft.workflows;
  if (!first || first.workflow === process) return draft;
  return { ...draft, workflows: [{ ...first, workflow: process }, ...rest] };
}

/** The draft with its name, input or output changed. */
export function withFace(draft: AutomationDraft, face: Partial<AutomationFace>): AutomationDraft {
  return { ...draft, automation: { ...draft.automation, ...face } };
}

/**
 * The definition a save posts: the stored one with the draft's name, input, output and steps.
 * `requires` goes as it was; the server works it out again and never trusts what is sent.
 */
export function toDefinition(
  draft: AutomationDraft,
  base: AutomationDefinition,
): AutomationDefinition {
  return {
    ...base,
    name: draft.automation.name.trim() || base.name,
    description: draft.automation.description,
    input: draft.automation.input,
    output: draft.automation.output,
    steps: draftProcess(draft).steps,
  };
}
