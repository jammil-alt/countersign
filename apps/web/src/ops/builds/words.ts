// Builds (docs/plan.md §1.108): the words and tones the build screens share.
import {
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
