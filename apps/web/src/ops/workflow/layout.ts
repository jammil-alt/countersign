// How wide a workflow's nested parts must be to stay readable (UI cleanup: at about 1,100px wide,
// nested fork paths shrank to about 40px). Each fork path keeps at least a card's width, a fork is
// as wide as its paths side by side, and the canvas scrolls sideways inside its own box when the
// whole is wider than the page, never the page itself.
// DECISION: widths are worked out from the workflow's shape, not measured, so they hold in tests
// and on first paint; a path is at least CARD_MIN wide whatever its contents.
import type { Step } from "@countersign/core";

/** The narrowest a step card may get inside a fork path or a loop. */
export const CARD_MIN = 200;
/** A path's or loop's own padding and border, both sides (p-3 and 1px). */
const BOX = 2 * 12 + 2;
/** The gap between fork paths (gap-3). */
const GAP = 12;

/** The width a list of steps needs: its widest step, at least a card's. */
export function listMinWidth(steps: readonly Step[]): number {
  return Math.max(CARD_MIN, ...steps.map(stepMinWidth));
}

/** The width one step needs: a fork its paths side by side, a loop its block, else a card. */
export function stepMinWidth(step: Step): number {
  if (step.kind === "fork") return forkMinWidth(step);
  if (step.kind === "for_each") return listMinWidth(step.steps) + BOX;
  return CARD_MIN;
}

/** Each column's width (its paths, then otherwise), in pixels. */
export function forkColumnWidths(step: Extract<Step, { kind: "fork" }>): number[] {
  return [...step.paths.map((p) => p.steps), step.otherwise.steps].map(
    (steps) => listMinWidth(steps) + BOX,
  );
}

export function forkMinWidth(step: Extract<Step, { kind: "fork" }>): number {
  const columns = forkColumnWidths(step);
  return columns.reduce((a, b) => a + b, 0) + GAP * (columns.length - 1) + BOX;
}

/** The fork grid's columns: each at least its width, sharing what is left. */
export function forkGridColumns(step: Extract<Step, { kind: "fork" }>): string {
  return forkColumnWidths(step)
    .map((w) => `minmax(${w}px, 1fr)`)
    .join(" ");
}
