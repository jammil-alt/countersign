// Builds (docs/plan.md §1.108): the words and tones the build screens share.
import {
  type BuildItemKind,
  type BuildItemState,
  type BuildPhase,
  type FitVerdict,
  PHASE_WORDS,
  type QaCheck,
  sliceWhole,
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
    how: "Answer it here or in the conversation. The Builder puts the answer in the brief and marks it done.",
  },
  gap: {
    label: "Gap",
    how: "Decide how to cover it: build it, give it to a person, or drop it from scope. The Builder makes the change.",
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
    how: "Change the agent, or answer the client, then set it to Done.",
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

/** A question closed without an answer here: the Close menu. */
export const CLOSE_CHOICES = [
  { key: "done", label: "Done (answered elsewhere)" },
  { key: "deferred", label: "Put off" },
  { key: "not-needed", label: "Not needed" },
] as const;

/** The line a question closed as not needed keeps in its detail. */
// DECISION (docs/plan.md §1.166): items have no note field, so "Not needed" is Done with this line
// added to the item's detail; no schema change.
export const NOT_NEEDED_NOTE = "Closed as not needed.";

/** An item's detail with a closing note after it, within the item's 2,000 characters. */
export function withNote(detail: string, note: string, max = 2000): string {
  const before = detail.trim();
  if (!before) return note;
  const room = max - note.length - 1;
  return `${sliceWhole(before, Math.max(0, room)).trimEnd()}\n${note}`;
}

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
