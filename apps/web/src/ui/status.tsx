// One status chip for every state a screen shows, with a fixed colour per state (brand book):
// running = slate, waiting on you = signal, blocked and failed = risk, done and checked = positive,
// setting up, idle and paused = neutral, a person's touch = copper. The words are always the
// caller's (a chip is never colour alone), so the same chip reads in every language.
import type { ReactNode } from "react";
import { cx } from "./cx";
import { pillClass, type Tone } from "./primitives";

export const CHIP_STATES = [
  "running",
  "waiting",
  "blocked",
  "failed",
  "done",
  "checked",
  "setup",
  "idle",
  "paused",
  "person",
] as const;
export type ChipState = (typeof CHIP_STATES)[number];

/** The fixed mapping, state → the tone it draws in. */
export const CHIP_TONE: Record<ChipState, Tone> = {
  running: "accent",
  waiting: "warning",
  blocked: "risk",
  failed: "risk",
  done: "positive",
  checked: "positive",
  setup: "neutral",
  idle: "neutral",
  paused: "neutral",
  person: "person",
};

/** `<StatusChip state="waiting">Waiting on you</StatusChip>`: a dot and the words. */
export function StatusChip({
  state,
  children,
  className,
  testId,
}: {
  state: ChipState;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={cx(pillClass(CHIP_TONE[state]), "ui-chip", className)}
    >
      {children}
    </span>
  );
}

/** A run's status (queued, running, waiting, succeeded, failed, cancelled) as a chip state. */
export function runChipState(status: string): ChipState {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

/** A service's or agent's status (active, paused, draft, testing, retired) as a chip state. */
export function serviceChipState(status: string): ChipState {
  switch (status) {
    case "active":
      return "running";
    case "draft":
    case "testing":
      return "setup";
    case "paused":
      return "paused";
    default:
      return "idle";
  }
}
