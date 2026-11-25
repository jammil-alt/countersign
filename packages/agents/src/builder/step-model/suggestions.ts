// What the Builder offers after a v5 draft, never does by itself (docs/step-model-plan.md §10):
// - **Save as skill**, when a step written in the step (rules or AI) holds the same instructions as
//   one in another agent of the client, or in a template. The operator accepts it with the step's
//   Save as skill button (stream F), which turns it into a library skill both can use.
// - **Open in the Loop designer**, for every Loop written in the step: a Loop is tested in the
//   Agent lab against its test set before it is published (§8), so the draft is handed there as
//   the designer's form.

import { type AnyAgentBundle, canonicalJson, steps } from "@countersign/core";
import type { WrittenElsewhere } from "../context";
import type { StepAgentBundle } from "./answer";

/** Whether a step is written in the step: rules rows or AI text, with nothing in Uses. */
export function writtenIn(step: steps.Step): "rules" | "ai" | null {
  if (step.kind !== "do" || step.uses !== undefined) return null;
  if (step.doneBy === "rules" && (step.rules?.rows?.length ?? 0) > 0) return "rules";
  if (step.doneBy === "ai" && (step.ai?.text ?? "").trim() !== "") return "ai";
  return null;
}

/**
 * A key that is the same for the same instructions: AI text without case, punctuation or spacing;
 * rule rows by what they test and set (not their ids or names). Null for a step not written in it.
 */
// DECISION: exact after normalising, not "similar": a suggestion the operator must second-guess is
// noise, and two agents written from one description by the Builder say the same words.
export function writtenKey(step: steps.Step): string | null {
  const how = writtenIn(step);
  if (how === null || step.kind !== "do") return null;
  if (how === "ai") {
    const text = (step.ai?.text ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return text ? `ai:${text}` : null;
  }
  const rows = (step.rules?.rows ?? []).map(({ id: _id, name: _name, ...rest }) => rest);
  return `rules:${canonicalJson(rows)}`;
}

/** Every step written in the step in a bundle's v5 workflows, with its key (`WrittenElsewhere`). */
export function writtenSteps(
  bundle: Pick<AnyAgentBundle, "workflows">,
): { stepId: string; stepName: string; doneBy: "rules" | "ai"; key: string }[] {
  const out: { stepId: string; stepName: string; doneBy: "rules" | "ai"; key: string }[] = [];
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion !== 5) continue;
    steps.eachStep(w.workflow.steps, ({ step }) => {
      const key = writtenKey(step);
      const how = writtenIn(step);
      if (key && how) out.push({ stepId: step.id, stepName: step.name, doneBy: how, key });
    });
  }
  return out;
}

export interface SaveAsSkillSuggestion {
  workflow: string;
  stepId: string;
  stepName: string;
  doneBy: "rules" | "ai";
  /** The other agents (or templates) whose steps hold the same instructions. */
  alsoIn: WrittenElsewhere[];
  /** In plain words, for the operator. */
  text: string;
}

/** The draft's steps whose instructions another agent of the client, or a template, also has. */
export function saveAsSkillSuggestions(
  bundle: Pick<StepAgentBundle, "workflows">,
  elsewhere: readonly WrittenElsewhere[] | undefined,
): SaveAsSkillSuggestion[] {
  if (!elsewhere?.length) return [];
  const out: SaveAsSkillSuggestion[] = [];
  for (const w of bundle.workflows) {
    steps.eachStep(w.workflow.steps, ({ step }) => {
      const key = writtenKey(step);
      const how = writtenIn(step);
      if (!key || !how) return;
      const alsoIn = elsewhere.filter((e) => e.key === key);
      if (alsoIn.length === 0) return;
      const names = [...new Set(alsoIn.map((e) => `"${e.agent.name}"`))].join(", ");
      out.push({
        workflow: w.slug,
        stepId: step.id,
        stepName: step.name,
        doneBy: how,
        alsoIn,
        text: `"${step.name}" has the same ${how === "ai" ? "instructions" : "rules"} as a step in ${names}. Save it as a skill so both use one, and a change reaches both.`,
      });
    });
  }
  return out;
}

/** A Loop written in a draft, as the Loop designer's form takes it (`location.state.loop`). */
export interface LoopOffer {
  workflow: string;
  stepId: string;
  /** The Loop designer's form fields, filled from the step. */
  loop: {
    slug: string;
    name: string;
    description: string;
    goal: string;
    input: LoopFieldRow[];
    output: LoopFieldRow[];
    reads: string[];
    instructions: string;
    maxTurns: number;
    atLimit: "stop" | "hand_back";
    conferFocus: string;
    review: "auto" | "off" | "always";
  };
  text: string;
}

/** A field as the designer's form row has it: a JSON Schema type. */
export interface LoopFieldRow {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description: string;
  required: boolean;
  extra: Record<string, unknown>;
}

const JSON_TYPE: Record<steps.FieldType, LoopFieldRow["type"]> = {
  text: "string",
  number: "number",
  money: "object",
  date: "string",
  yes_no: "boolean",
  list: "array",
  group: "object",
  record: "string",
};

function row(field: steps.Field): LoopFieldRow {
  return {
    key: field.name,
    type: JSON_TYPE[field.type],
    description: field.about ?? "",
    required: field.required,
    extra: field.type === "date" ? { format: "date" } : {},
  };
}

/**
 * A slug from a name: lowercase letters and digits, one dash between runs, at most 60 characters.
 */
// DECISION (CodeQL js/polynomial-redos): a character loop, not regular expressions over the
// model's step name.
export function slugOf(name: string): string {
  let out = "";
  let dash = false;
  for (const ch of name.toLowerCase()) {
    if (out.length >= 60) break;
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (ok) {
      out += ch;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += "-";
      dash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "loop";
}

/**
 * Every Loop written in the step (no saved Loop): it isn't tested until it is a Loop skill that
 * passed its test set, so the Builder offers to open it in the Loop designer.
 */
// DECISION: the Builder never publishes, and never saves a Loop skill itself: the designer saves
// it as a draft and its test-set gate decides when it may go live (stream H). The input fields are
// the step's input names as text; the designer is where they are typed.
export function loopOffers(bundle: Pick<StepAgentBundle, "workflows">): LoopOffer[] {
  const out: LoopOffer[] = [];
  for (const w of bundle.workflows) {
    steps.eachStep(w.workflow.steps, ({ step }) => {
      if (step.kind !== "loop" || step.skill !== undefined) return;
      out.push({
        workflow: w.slug,
        stepId: step.id,
        loop: {
          slug: slugOf(step.name),
          name: step.name,
          description: step.purpose ?? step.goal.slice(0, 200),
          goal: step.goal,
          input: Object.keys(step.input).map((name) =>
            row({ name, type: "text", required: false }),
          ),
          output: step.output.map(row),
          reads: step.reads,
          instructions: step.instructions,
          maxTurns: step.maxTurns,
          atLimit: step.atLimit,
          conferFocus: "",
          review: "auto",
        },
        text: `"${step.name}" is a Loop written in the step and not tested yet. Open it in the Loop designer to save it as a Loop and run its test set before this agent is published.`,
      });
    });
  }
  return out;
}
