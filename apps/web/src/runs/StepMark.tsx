// The checkbox at the start of a step row (design screen 6): filled with a tick when the step is
// done, a numbered outline while it waits or runs, a cross when it failed, empty when skipped.
import { cx } from "../ui/primitives";

export function StepMark({ status, n }: { status: string; n: number }) {
  const done = status === "succeeded";
  const failed = status === "failed";
  const active = status === "waiting" || status === "running";
  return (
    <span
      aria-hidden
      data-mark={status}
      className={cx(
        "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-sm border font-mono text-[11px]",
        done && "border-primary bg-primary text-card",
        failed && "border-tone-warning-edge bg-tone-warning text-tone-warning-ink",
        active && "border-action text-action",
        !done && !failed && !active && "border-control text-faint",
      )}
    >
      {done ? "✓" : failed ? "×" : active ? n : ""}
    </span>
  );
}
