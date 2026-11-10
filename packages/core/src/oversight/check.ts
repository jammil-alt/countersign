// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's check on every step, recorded.
// The owner's cheap watch (watch.ts) runs on every attempt at a v4 read, skill or write step; until
// now it recorded nothing when the step was clean. Each attempt now leaves one `owner_check` row
// saying what the owner did: nothing was off (clean), something was off and no review followed
// (flagged, with why), it reviewed the step (reviewed, with the decision), or it doesn't watch
// (not watched: the owner, or the step's review, is off). No model call: the check is the rules
// the watch already ran. Back office only (invariant 11).
//
// Pure: the executor builds the entry (packages/workflows), apps/api stores and shows it.

import { z } from "zod";
import { Decimal } from "../money";
import {
  OVERSIGHT_ACTIONS,
  OVERSIGHT_CAUSES,
  OVERSIGHT_DEFAULT_MAX_COST_USD,
  type OversightActionName,
  type OversightCause,
  type OversightReview,
  OWNER_REVIEW_DUES,
  type OwnerReviewDue,
} from "./decision";
import type { AnomalySignal } from "./watch";

export const OWNER_CHECK_RESULTS = ["clean", "flagged", "reviewed", "not_watched"] as const;
export type OwnerCheckResult = (typeof OWNER_CHECK_RESULTS)[number];
/**
 * How the attempt ended: done (`succeeded`), `failed` (or threw), `escalated` (a budget was
 * reached and it went to us), `rejected` (a person turned its write or sign-off down) or
 * `unanswered` (nobody answered in time).
 */
// DECISION (wave 6 review): an escalation, a person's no and nobody answering are outcomes of their
// own, so the line names what happened rather than "Failed" or "nothing off".
export const OWNER_CHECK_ATTEMPTS = [
  "succeeded",
  "failed",
  "escalated",
  "rejected",
  "unanswered",
] as const;
export type OwnerCheckAttempt = (typeof OWNER_CHECK_ATTEMPTS)[number];
/**
 * Why a review that was due wasn't made (on a flagged step, or a clean one whose routine review
 * was due), why the run ended before the owner looked, or why the step wasn't watched.
 */
export const OWNER_CHECK_REASONS = [
  /** Two reviews for the step, or the run's `maxPerRun`, already made. */
  "limit",
  /** The review itself failed (the step's own result stands). */
  "review_failed",
  /** The review gave no decision (the cost limit, an answer that failed validation). */
  "no_decision",
  /** The step's input could not be resolved to show the reviewer. */
  "input_unresolved",
  /** A person's answer (a no, or nobody answering in time) ended the run during the attempt. */
  "ended_by_person",
  /** The agent's owner is off. */
  "owner_off",
  /** This step's review is off. */
  "step_off",
] as const;
export type OwnerCheckReason = (typeof OWNER_CHECK_REASONS)[number];

/** One attempt's check, as the executor hands it to its port (`OwnerCheckLog`). */
export interface OwnerCheckEntry {
  runId: string;
  /** The step's durable name (`step_run.node_id`). */
  nodeId: string;
  /** 1.. per node. */
  attempt: number;
  result: OwnerCheckResult;
  attemptOutcome: OwnerCheckAttempt;
  /** What the cheap watch saw on a success (empty for a failure or a step not watched). */
  signals: readonly AnomalySignal[];
  reason?: OwnerCheckReason;
  /** `reviewed`: why, and the verdict's action. Also on a review that was due and not made. */
  cause?: OversightCause;
  verdict?: OversightActionName;
  /** Why a step that succeeded was due a review whatever its result (checkpoint, all, always). */
  reviewDue?: OwnerReviewDue;
}

/** The cheap watch's signals as the API carries them. */
export const AnomalySignalView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty_output") }),
  z.object({
    kind: z.literal("total_outlier"),
    field: z.string(),
    amount: z.string(),
    currency: z.string().nullable(),
    median: z.string(),
    runs: z.number().int(),
  }),
  z.object({ kind: z.literal("confer_disagreed"), count: z.number().int() }),
]);
export type AnomalySignalView = z.infer<typeof AnomalySignalView>;

/** One `owner_check` row, as the run view and the export show it. */
export const OwnerCheckView = z.object({
  id: z.string(),
  nodeId: z.string(),
  attempt: z.number().int(),
  result: z.enum(OWNER_CHECK_RESULTS),
  attemptOutcome: z.enum(OWNER_CHECK_ATTEMPTS),
  signals: z.array(AnomalySignalView),
  reason: z.enum(OWNER_CHECK_REASONS).nullable(),
  cause: z.enum(OVERSIGHT_CAUSES).nullable(),
  verdict: z.enum(OVERSIGHT_ACTIONS).nullable(),
  reviewDue: z.enum(OWNER_REVIEW_DUES).nullable(),
  /** `reviewed`: the `oversight_decision` it led to (its note, sources and cost are there). */
  decisionId: z.string().nullable(),
  /** The line the run view shows: "Owner checked: nothing off". */
  words: z.string(),
  createdAt: z.string(),
});
export type OwnerCheckView = z.infer<typeof OwnerCheckView>;

/** Stored signals, read back: anything that isn't a signal is left out. */
export function signalsOf(stored: unknown): AnomalySignalView[] {
  if (!Array.isArray(stored)) return [];
  const out: AnomalySignalView[] = [];
  for (const s of stored) {
    const parsed = AnomalySignalView.safeParse(s);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// ── Plain words ─────────────────────────────────────────────────────────────────────────────────

/** "4×", "12×", "0.05×": how far a total is from its usual, to two significant figures. */
function ratioWords(amount: string, median: string): string {
  try {
    const m = new Decimal(median);
    if (m.lte(0)) return "far from";
    const r = new Decimal(amount).dividedBy(m);
    return `${r.toSignificantDigits(2).toFixed()}× its usual`;
  } catch {
    return "far from its usual";
  }
}

/** One signal in plain words: "total 12× its usual", "an empty result", "a reviewer disagreed". */
export function signalWords(signal: AnomalySignalView | AnomalySignal): string {
  switch (signal.kind) {
    case "empty_output":
      return "an empty result";
    case "total_outlier":
      return `${signal.field} ${ratioWords(signal.amount, signal.median)}`;
    case "confer_disagreed":
      return signal.count === 1 ? "a reviewer disagreed" : `${signal.count} reviewers disagreed`;
  }
}

const VERDICT_WORDS: Record<OversightActionName, string> = {
  continue: "carried on",
  retry: "tried again",
  retry_with: "corrected the input and tried again",
  ask: "asked a person",
  stop: "stopped the run",
};

/** The end of a reason's line. */
const REASON_TAIL: Record<OwnerCheckReason, string> = {
  limit: "the review limit was reached",
  review_failed: "the review failed",
  no_decision: "the review gave no decision",
  input_unresolved: "its input could not be shown",
  ended_by_person: "the run ended there",
  owner_off: "the owner is off for this agent",
  step_off: "the owner's review is off for this step",
};

/** The routine review a step that succeeded was due, by name. */
const DUE_WORDS: Record<OwnerReviewDue, string> = {
  checkpoint: "checkpoint review",
  all: "every-step review",
  always: "routine review",
};

/** Why a step that succeeded was reviewed when nothing was off. */
const REVIEWED_WORDS: Record<OwnerReviewDue, string> = {
  checkpoint: "Checkpoint before a write → reviewed",
  all: "Reviewed (every step)",
  always: "Reviewed (always for this step)",
};

type CheckWords = {
  result: OwnerCheckResult;
  attemptOutcome: OwnerCheckAttempt;
  signals: readonly (AnomalySignalView | AnomalySignal)[];
  reason?: OwnerCheckReason | null | undefined;
  cause?: OversightCause | null | undefined;
  verdict?: OversightActionName | null | undefined;
  reviewDue?: OwnerReviewDue | null | undefined;
};

/** How the attempt ended, when it didn't simply succeed; null when it did. */
function howItEnded(outcome: OwnerCheckAttempt): string | null {
  switch (outcome) {
    case "failed":
      return "Failed";
    case "escalated":
      return "Escalated to us: a budget was reached";
    case "rejected":
      return "Turned down by a person";
    case "unanswered":
      return "Nobody answered in time";
    case "succeeded":
      return null;
  }
}

/** What set the check off: how the attempt ended, the signals, or the review that was due. */
function whatWasOff(check: CheckWords): string {
  const ended = howItEnded(check.attemptOutcome);
  if (ended) return ended;
  if (check.signals.length > 0) {
    return `Flagged: ${check.signals.map(signalWords).join(", ")}`;
  }
  return "Nothing off";
}

/**
 * The run view's line for a check: "Owner checked: nothing off", "Flagged: total 12× its usual →
 * reviewed → carried on", "Reviewed (every step) → carried on", "Failed → not reviewed: the review
 * limit was reached", "Owner checked: nothing off → every-step review not made: the review gave
 * no decision", "Turned down by a person → nothing for the owner to review", "Not watched: the
 * owner is off for this agent".
 */
export function ownerCheckWords(check: CheckWords): string {
  const reason = check.reason ?? null;
  switch (check.result) {
    case "not_watched":
      return `Not watched: ${REASON_TAIL[reason ?? "owner_off"]}`;
    case "clean": {
      const ended = howItEnded(check.attemptOutcome);
      if (reason === "ended_by_person") {
        return `${ended ?? "Owner checked: nothing off"} → not reviewed: ${REASON_TAIL[reason]}`;
      }
      if (ended) return `${ended} → nothing for the owner to review`;
      if (reason) {
        const due = check.reviewDue ? DUE_WORDS[check.reviewDue] : "routine review";
        return `Owner checked: nothing off → ${due} not made: ${REASON_TAIL[reason]}`;
      }
      return "Owner checked: nothing off";
    }
    case "flagged":
      return `${whatWasOff(check)} → not reviewed${reason ? `: ${REASON_TAIL[reason]}` : ""}`;
    case "reviewed": {
      const did = check.verdict ? VERDICT_WORDS[check.verdict] : "no change";
      const off = whatWasOff(check);
      if (off === "Nothing off") {
        // A routine review of a step nothing was off with: why it was due.
        const due = check.reviewDue;
        return `${due ? REVIEWED_WORDS[due] : "Nothing off → reviewed"} → ${did}`;
      }
      return `${off} → reviewed → ${did}`;
    }
  }
}

// ── The review setting, in the agent's settings ─────────────────────────────────────────────────

/** One choice of the owner's review setting, worded for the back office's agent settings. */
export interface OwnerReviewChoice {
  value: OversightReview;
  label: string;
  description: string;
  /** What it costs, plainly; null when it adds no model call. */
  cost: string | null;
}

/**
 * The owner's review setting (`definition.oversight.review`), each choice in plain words with its
 * cost. Every choice keeps the cheap watch (rules, no model) on v4 processes except `off`.
 */
// DECISION (wave 6): `all` is "Review every step": one model call per read, skill and write step
// the run reaches, on the owner's model, within the run's review cost limit (`maxCostUsd`).
export const OWNER_REVIEW_CHOICES: readonly OwnerReviewChoice[] = [
  {
    value: "off",
    label: "Off",
    description: "The owner doesn't watch this agent's steps. Failures stop the run as they are.",
    cost: null,
  },
  {
    value: "failures",
    label: "Review failures",
    description:
      "The owner checks every step's result by rules and reviews a step that failed or looks off.",
    cost: "One model call for each step it reviews; clean steps cost nothing.",
  },
  {
    value: "checkpoints",
    label: "Review failures and checkpoints",
    description:
      "As above, and the owner also reviews each step whose result feeds a write or reaches a person, before it does.",
    cost: "One model call for each step it reviews, checkpoints included.",
  },
  {
    value: "all",
    label: "Review every step",
    description:
      "A full AI review of every read, skill and write step, whether or not it looks off.",
    cost: `One model call on every step the run reaches, on the owner's model, up to the run's review limit (default $${OVERSIGHT_DEFAULT_MAX_COST_USD} a run).`,
  },
];
