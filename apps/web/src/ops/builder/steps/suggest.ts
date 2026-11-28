// Suggest's call shape (docs/step-model-plan.md §5): the AI icon at the top of a step's form and
// beside each field opens a pop-up with three choices. This file fixes what the pop-up asks and
// what it gets back; the answer is the Builder's AI (`POST /api/ops/agents/:id/suggest`, stream F).

import type { StepSuggestion as Answer, StepSuggestRequest as Ask } from "@countersign/core";
import type { Step, Workflow } from "./types";

export type SuggestHow = Ask["how"];

/** The three choices in the pop-up, in its order, in the words the plan gives them. */
export const SUGGEST_CHOICES: readonly { how: SuggestHow; label: string; hint: string }[] = [
  { how: "tell", label: "Tell it what you need", hint: "In your own words." },
  { how: "default", label: "Use the default", hint: "What most steps like this use." },
  { how: "resolve", label: "Resolve", hint: "Fix what is flagged." },
];

export interface SuggestRequest {
  /** The step, and the field (absent: the whole step). */
  step: Step;
  field?: string | undefined;
  how: SuggestHow;
  text?: string | undefined;
}

export interface Suggestion {
  /** The step as it should now be. */
  step: Step;
  summary: string;
  applied: boolean;
}

/** Asks for a suggestion; the host knows the workflow around the step and the agent it is in. */
export type SuggestFn = (request: SuggestRequest) => Promise<Suggestion>;

/** The workflow as drawn, with the step the form holds in its place. */
export function withStep(workflow: Workflow, step: Step): Workflow {
  const swap = (list: Step[]): Step[] =>
    list.map((s) => {
      if (s.id === step.id) return step;
      if (s.kind === "fork") {
        return {
          ...s,
          paths: s.paths.map((p) => ({ ...p, steps: swap(p.steps) })),
          otherwise: { ...s.otherwise, steps: swap(s.otherwise.steps) },
        };
      }
      if (s.kind === "for_each" || s.kind === "repeat") return { ...s, steps: swap(s.steps) };
      return s;
    });
  return { ...workflow, steps: swap(workflow.steps) };
}

/** What goes over the wire: the workflow as drawn, with the step the form holds in its place. */
export function suggestBody(workflow: Workflow, request: SuggestRequest): Ask {
  return {
    workflow: withStep(workflow, request.step),
    stepId: request.step.id,
    how: request.how,
    ...(request.field ? { field: request.field } : {}),
    ...(request.text ? { text: request.text } : {}),
  };
}

/** The server's answer as the pop-up reads it. */
export function readSuggestion(answer: Answer, fallback: Step): Suggestion {
  return {
    step: (answer.step as Step | undefined) ?? fallback,
    summary: answer.summary,
    applied: answer.applied,
  };
}

/**
 * Why a suggestion can't be applied, in plain words, or null when it can. Suggest is held to the
 * same rules as a person (§5): it never changes a step's id or kind, and never loosens an approval
 * (invariant 8): an approver that was on stays on, as `required`, with no condition that skips it.
 */
export function refuseSuggestion(before: Step, after: Step): string | null {
  if (before.id !== after.id || before.kind !== after.kind) {
    return "That suggestion would change which step this is, so it wasn't applied.";
  }
  const was = before.checks?.approval;
  const now = after.checks?.approval;
  if (was && (!now || now.required !== "required" || now.when !== undefined)) {
    return "That suggestion would loosen an approval, so it wasn't applied.";
  }
  if (!was && now && (now.required !== "required" || now.when !== undefined)) {
    return "That suggestion would add an approval that doesn't always ask, so it wasn't applied.";
  }
  return null;
}

/** The server's answer, unless it breaks a rule: then nothing is applied and the pop-up says why. */
export function guardedSuggestion(answer: Answer, before: Step): Suggestion {
  const read = readSuggestion(answer, before);
  if (!read.applied) return read;
  const refused = refuseSuggestion(before, read.step);
  return refused ? { step: before, summary: refused, applied: false } : read;
}
