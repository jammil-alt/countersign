// The Data tab's values (docs/step-model-plan.md §5): what comes in to a step, what its incoming side
// changed, and what goes out, as plain JSON values. From the step's last test run when there is one,
// otherwise sample data made from the fields' types. For understanding only: nothing here is a check.
// Pure.

import { findStep } from "./model";
import { actionPath, inputFields, outputFields, type UsesContext, usesLabel } from "./options";
import type { Field, Step, Workflow } from "./types";

/** What a step's last test run saw. */
export interface LastRun {
  input?: unknown;
  output?: unknown;
}

export type Runs = Readonly<Record<string, LastRun>>;

/** A made-up value of a field's type. */
export function sampleFor(field: Field): unknown {
  switch (field.type) {
    case "text":
      return "Sample text";
    case "number":
      return 12;
    case "money":
      return "125.00";
    case "date":
      return "2026-01-15";
    case "yes_no":
      return true;
    case "list":
      return [sampleFields(field.of ?? [])];
    case "group":
      return sampleFields(field.of ?? []);
    case "record":
      return `${field.record ?? "record"} id`;
  }
}

/** One item with a made-up value in each field. */
export function sampleFields(fields: readonly Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.name, sampleFor(f)]));
}

/** A value at a dotted path (`header.vendorName`); undefined when nothing is there. */
export function valueAt(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const key of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = Array.isArray(at)
      ? (at[0] as Record<string, unknown> | undefined)?.[key]
      : (at as Record<string, unknown>)[key];
  }
  return at;
}

const REF = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** A step's output: its last run's, else a sample from its fields. */
export function goingOut(
  step: Step,
  uses: UsesContext,
  runs: Runs = {},
  last?: LastRun,
): { value: unknown; sample: boolean } {
  const run = last ?? runs[step.id];
  if (run?.output !== undefined) return { value: run.output, sample: false };
  return { value: sampleFields(outputFields(step, uses)), sample: true };
}

/**
 * The step's input as it arrives: each entry's reference replaced by what the step before gave
 * (its last run, else a sample), a fixed value as it is. A reference to nothing known stays as written.
 */
export function comingIn(
  step: Step,
  workflow: Pick<Workflow, "steps">,
  uses: UsesContext,
  runs: Runs = {},
  last?: LastRun,
  trigger: readonly Field[] = [],
): { value: unknown; sample: boolean } {
  const run = last ?? runs[step.id];
  if (run?.input !== undefined) return { value: run.input, sample: false };
  const input = "input" in step ? (step.input as Record<string, unknown>) : {};
  let sample = false;
  const resolve = (raw: unknown): unknown => {
    if (typeof raw !== "string") return raw;
    const ref = REF.exec(raw)?.[1];
    if (!ref) return raw;
    const parts = ref.split(".");
    if (parts[0] === "trigger") {
      sample = true;
      const rest = parts.slice(1);
      return valueAt(sampleFields(trigger), rest) ?? raw;
    }
    if (parts[0] === "steps" && parts[1] && parts[2] === "output") {
      const from = findStep(workflow, parts[1])?.step;
      if (!from) return raw;
      const out = goingOut(from, uses, runs);
      if (out.sample) sample = true;
      const rest = parts.slice(3);
      return rest.length === 0 ? out.value : (valueAt(out.value, rest) ?? raw);
    }
    return raw;
  };
  const value = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, resolve(v)]));
  // A step with nothing mapped yet still shows the fields it takes, made up.
  if (Object.keys(value).length === 0) {
    const fields = inputFields(step, uses);
    if (fields.length > 0) return { value: sampleFields(fields), sample: true };
  }
  return { value, sample };
}

/** What the incoming side did and what the step then did with it, in plain lines. */
export function changed(step: Step, uses: UsesContext): { translated: string[]; did: string } {
  const translated: string[] = [];
  if (step.kind === "do" && step.translation) {
    for (const f of step.translation.fields) {
      const from = f.from === undefined ? "nothing mapped yet" : brief(f.from);
      translated.push(`${f.name} ← ${from}`);
    }
  }
  return { translated, did: didWords(step, uses) };
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function didWords(step: Step, uses: UsesContext): string {
  switch (step.kind) {
    case "do": {
      const u = step.uses;
      if (u?.type === "action") {
        const a = uses.actions.get(u.action);
        const what = a ? actionPath(a) : u.action;
        if (!a) return `Runs ${what}.`;
        return a.kind === "get"
          ? `Reads from ${what}.`
          : a.kind === "save"
            ? `Saves to our records: ${what}.`
            : a.kind === "send"
              ? `Sends: ${what}.`
              : `Changes the client's tool: ${what}.`;
      }
      if (u) return `Uses ${usesLabel(step, uses)}.`;
      if (step.doneBy === "rules") {
        const n = step.rules?.rows?.length ?? 0;
        return n === 0
          ? "No rule rows yet."
          : `Works the ${n} rule ${n === 1 ? "row" : "rows"} you wrote.`;
      }
      if (step.doneBy === "ai") return "The AI answers from what you told it.";
      if (step.doneBy === "person") return "A person answers or approves.";
      if (step.doneBy === "contact") return "Talks with an outside contact until the goal is met.";
      return "Nothing chosen yet.";
    }
    case "loop":
      return "A model reads with the actions you allowed, until the goal is met.";
    case "fork":
      return "Takes one of its paths.";
    case "for_each":
      return "Runs the steps inside once per item.";
    case "repeat":
      return "Runs the steps inside again until it is done.";
    case "wait":
      return "Pauses the run.";
    case "handoff":
      return "Starts another run.";
    case "end":
      return "Delivers what the workflow promised.";
  }
}
