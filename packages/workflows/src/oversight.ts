// R6 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Agents and their owner"): the owner's watch in
// the executor. The owner is v0.13's run oversight (§10.11) under its proper name, so this module
// adds no loop and no port: the executor's `overseen` loop and the `OversightPort` stay the one way
// a step is reviewed. What is here is which steps go to the owner and when, for v3 skill and action
// steps exactly as v0.13 decides it, and for v4 read, skill, write and conversation steps the same
// way, plus the cheap watch on every v4 step's result (core `anomalySignals`), which asks for a
// checkpoint review when a result is plainly off. A step's checks (confer, approval, notify) run
// inside the step, so they are watched with it: a confer that disagreed is one of the signals.
//
// Pure: no model, no database, no durable step of its own. The signals ride on the review's
// request; the history they compare with is loaded once when the run starts (packages/agents
// `ownerHistory`).

import {
  type AnomalySignal,
  anomalySignals,
  type OversightSettings,
  type OwnerWatchedStep,
  ownerReviewsFailure,
  ownerReviewsSuccess,
  ownerWatches,
  type processes,
  runErrorKey,
  stepPathOf,
  type TotalSample,
} from "@countersign/core";
import type { OversightRequest } from "./ports";

/** The owner as the executor sees it: v0.13's settings, and (v4) the cheap watch. */
export interface OwnerWatch {
  /** The agent's `definition.oversight` (core `ownerOf(…).settings`); absent means `off`. */
  settings?: OversightSettings | undefined;
  /**
   * The cheap watch on every step's result, for v4 processes (core `ownerOf(…).watch`). Absent:
   * no signals, so a v3 run is reviewed exactly as v0.13 reviews it.
   */
  watch?:
    | {
        /** Each step's earlier totals by step path (`ownerHistory`), newest first. */
        history?: Readonly<Record<string, readonly TotalSample[]>> | undefined;
      }
    | undefined;
}

/**
 * Whether a failure of this step goes to the owner: the executor's v0.13 rule (a port, and the
 * step's failures reviewed) for any watched step, v3 or v4.
 */
export function ownerReviewsFailureOf(
  owner: OwnerWatch | undefined,
  step: { kind: string; review?: OwnerWatchedStep["review"] },
): boolean {
  return owner !== undefined && ownerReviewsFailure(owner.settings, step);
}

/** What the owner does after an attempt that succeeded. */
export interface AfterSuccess {
  review: boolean;
  /** The signals that asked for the review (empty when it is a checkpoint's, or none). */
  signals: AnomalySignal[];
}

/**
 * After an attempt that succeeded: the cheap watch's signals (v4 only), then whether the owner
 * reviews it as a checkpoint: v0.13's rule (a checkpoint under `checkpoints`, `all`, `always`), or
 * a signal while the owner reviews anything. `name` is the step's durable name; its history is
 * found by step path, so every iteration of a loop shares one.
 */
export function ownerAfterSuccess(
  owner: OwnerWatch | undefined,
  step: { kind: string; review?: OwnerWatchedStep["review"] },
  at: {
    name: string;
    checkpoint: boolean;
    output: unknown;
    /** The verdicts of the step's confer check, when it had one. */
    confer?: readonly processes.ConferVerdict[] | undefined;
  },
): AfterSuccess {
  if (!ownerWatches(step)) return { review: false, signals: [] };
  const signals = owner?.watch
    ? anomalySignals({
        kind: step.kind,
        output: at.output,
        history: lookup(owner.watch.history, stepPathOf(at.name)),
        confer: at.confer,
      })
    : [];
  const review = ownerReviewsSuccess(owner?.settings, step, at.checkpoint, signals);
  return { review, signals: review ? signals : [] };
}

function lookup(
  history: Readonly<Record<string, readonly TotalSample[]>> | undefined,
  key: string,
): readonly TotalSample[] | undefined {
  return history && Object.hasOwn(history, key) ? history[key] : undefined;
}

/**
 * The templates a review shows as the step's input: its `input`, or a conversation's who and goal
 * (it has no input to correct; core `ownerAllowedActions` never offers it `retry_with`).
 */
export function ownerStepInput(step: OwnerWatchedStep): unknown {
  if (step.kind === "conversation") return { with: step.with, goal: step.goal };
  return step.input;
}

/**
 * `<tool id or step kind>:<code>` (ARCHITECTURE §10.10): a step that calls one tool (v3 action,
 * v4 read and write) names it, any other its kind; the executor's rule for v3, kept.
 */
export function ownerErrorKey(step: OwnerWatchedStep, reason: string | undefined): string {
  const tool =
    step.kind === "action" || step.kind === "read" || step.kind === "write" ? step.tool : null;
  return runErrorKey({ tool, kind: step.kind }, reason ?? null);
}

/**
 * The review request for any watched step: `OversightRequest` with the step widened to v4 kinds
 * and the watch's signals. packages/agents' `OverseeRequest` takes exactly these fields.
 */
// DECISION: a widened request type here, not an edit of `OversightRequest` (ports.ts): v3's port
// keeps its type until the v4 executor (R3) widens `OversightRequest.step` to `OwnerWatchedStep`
// and adds `signals`, when this becomes an alias of it.
export type OwnerReviewRequest = Omit<OversightRequest, "step"> & {
  step: OwnerWatchedStep;
  signals?: readonly AnomalySignal[];
};

/** Builds the owner's review request; signals ride only on a review of a step that succeeded. */
export function ownerReviewRequest(
  base: Omit<OwnerReviewRequest, "signals" | "errorKey"> & { errorKey?: string },
  signals: readonly AnomalySignal[] = [],
): OwnerReviewRequest {
  const failing = base.cause === "failed";
  return {
    ...base,
    errorKey: base.errorKey ?? (failing ? ownerErrorKey(base.step, base.error) : ""),
    ...(!failing && signals.length > 0 ? { signals } : {}),
  };
}
