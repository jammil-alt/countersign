// Builds (docs/plan.md §1.108): the words and tones the build screens share.
import {
  type BuildItemKind,
  type BuildItemState,
  type BuildPhase,
  type FitVerdict,
  PHASE_WORDS,
} from "@countersign/core";
import type { Tone } from "../../ui/primitives";

export const BUILDS_PATH = "/ops/builds";
export const buildPath = (id: string) => `${BUILDS_PATH}/${id}`;

/**
 * Where a build opens from the lab's Drafts (docs/plan.md §1.172): one started on Describe it, in
 * the builder's list of steps once it has a draft and on Check the steps until then; any other, on its
 * build page.
 */
export function buildHref(b: {
  id: string;
  flow?: "phases" | "describe" | undefined;
  agentId: string | null;
}): string {
  if (b.flow !== "describe") return buildPath(b.id);
  return b.agentId ? `/ops/agents/${b.agentId}/steps` : `/ops/lab/check/${b.id}`;
}

export const phaseLabel = (p: BuildPhase) => PHASE_WORDS[p].label;

export const VERDICT_TONE: Record<FitVerdict, Tone> = {
  native: "positive",
  configure: "accent",
  build: "warning",
  figure_out: "neutral",
  not_possible: "risk",
};

export const ITEM_TONE: Record<BuildItemState, Tone> = {
  open: "warning",
  in_progress: "accent",
  waiting: "warning",
  done: "positive",
  deferred: "neutral",
};

/**
 * Feedback (2026-11-16): "what is the human ask, and how to resolve it". Each kind of open item
 * by what it is and what settles it.
 */
export const ITEM_KIND_WORDS: Record<BuildItemKind, { label: string; how: string }> = {
  question: {
    label: "Question",
    how: "Answer it here or in the conversation. It closes when the Builder has your answer.",
  },
  gap: {
    label: "Gap",
    how: "Pick the step that covers it: the Builder changes the process or builds a skill, or Mezonas engineering writes the code. It closes when that is done.",
  },
  precondition: {
    label: "Must be true first",
    how: "Get it done, often by the client in their portal, then mark it done.",
  },
  test: {
    label: "Test",
    how: "Fix what failed, then run the tests again. It closes when the test passes.",
  },
  feedback: {
    label: "Client feedback",
    how: "Change the agent for it, one of the three ways. It closes when the change is made.",
  },
  qa: {
    label: "QA",
    how: "Check it in QA and sign it, or accept it with a reason.",
  },
  note: {
    label: "Note",
    how: "A note to keep in mind. Mark it done when it no longer matters.",
  },
};

/**
 * Owner (2026-11-21): an issue or a decision is closed out where it is listed. What each choice
 * says to the Builder, in the issue's thread (the Builder's turn gets the issue as its `about`).
 */
export const TO_BUILDER = {
  answer: (title: string, text: string) => `About “${title}”: ${text}`,
  gap: {
    build: (title: string) => `About “${title}”: build it. Cover it in the draft.`,
    person: (title: string) => `About “${title}”: a person does it. Make it a person step.`,
    drop: (title: string) => `About “${title}”: drop it. Take it out of scope.`,
  },
  change: (what: string, text: string) =>
    `About “${what}”: change this decision. It should be: ${text}. Rewrite the decision, and the draft to match.`,
  askEachClient: (what: string) =>
    `About “${what}”: ask each client. Move it into the client intake form, so each client gives their own answer.`,
  personDecides: (what: string) =>
    `About “${what}”: a person decides each run. Make it a person step.`,
} as const;

/** The Gap buttons, in order. */
export const GAP_CHOICES = [
  { key: "build", label: "Build it" },
  { key: "person", label: "A person does it" },
  { key: "drop", label: "Drop it" },
] as const;

/**
 * A question closed without an answer here: the Close menu. docs/plan.md §1.169: "answered
 * elsewhere" is gone; an answer is typed, and the Builder closes the question by it.
 */
export const CLOSE_CHOICES = [
  { key: "deferred", label: "Put off" },
  { key: "not-needed", label: "Not needed" },
] as const;

/** The line a question closed as not needed keeps in its detail; the server adds it (§1.169). */
export { NOT_NEEDED_NOTE, withNote } from "@countersign/core";

export const BRIEF_STATE_WORDS = {
  confirmed: "Confirmed",
  assumed: "Assumed",
  open: "Open",
} as const;
export const BRIEF_STATE_TONE: Record<keyof typeof BRIEF_STATE_WORDS, Tone> = {
  confirmed: "positive",
  assumed: "neutral",
  open: "warning",
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
