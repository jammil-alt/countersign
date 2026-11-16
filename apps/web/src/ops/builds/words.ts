// Builds (docs/plan.md §1.108): the words and tones the build screens share.
import {
  type BuildItemKind,
  type BuildItemState,
  type BuildPhase,
  type FitVerdict,
  PHASE_WORDS,
  type QaCheck,
} from "@countersign/core";
import type { Tone } from "../../ui/primitives";

export const BUILDS_PATH = "/ops/builds";
export const buildPath = (id: string) => `${BUILDS_PATH}/${id}`;

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
    how: "Answer it to the Builder in the conversation; it marks it done when the brief has the answer.",
  },
  gap: {
    label: "Gap",
    how: "Decide how to cover it: build it, give it to a person, or drop it from scope. Tell the Builder which.",
  },
  precondition: {
    label: "Must be true first",
    how: "Get it done, often by the client in their portal, then set it to Done.",
  },
  test: {
    label: "Test",
    how: "Fix what failed, then run the tests again. It closes when the test passes.",
  },
  feedback: {
    label: "Client feedback",
    how: "Change the agent, or answer the client, then set it to Done.",
  },
  qa: {
    label: "QA",
    how: "Check it in QA and sign it, or accept it with a reason.",
  },
  note: {
    label: "Note",
    how: "A note to keep in mind. Set it to Done when it no longer matters.",
  },
};

export const QA_TONE: Record<QaCheck["state"], Tone> = {
  pass: "positive",
  fail: "risk",
  accepted: "person",
  unknown: "neutral",
};

export const QA_STATE_WORDS: Record<QaCheck["state"], string> = {
  pass: "Passes",
  fail: "Fails",
  accepted: "Accepted",
  unknown: "Not known yet",
};

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

export const SOURCE_WORDS = { generate: "Generate", upload: "Upload", sandbox: "Sandbox" } as const;

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
