// The mark at the start of a step row (design screen 6, on the Mezonas Stepper's ds-step__mark):
// filled slate with a tick when the step is done, the step number while it runs, signal while it
// waits on a person, risk with a cross when it failed, empty when skipped.
import { Icon } from "../ui/icons";
import { cx } from "../ui/primitives";

export function StepMark({ status, n }: { status: string; n: number }) {
  const done = status === "succeeded";
  const failed = status === "failed";
  const waiting = status === "waiting";
  const running = status === "running";
  return (
    <span
      aria-hidden
      data-mark={status}
      className={cx(
        "ds-step__mark mt-0.5 shrink-0 font-sans text-xs font-medium figures",
        done && "border-slate bg-slate text-on-slate",
        failed && "border-risk bg-risk-tint text-risk",
        waiting && "border-signal bg-signal-tint text-signal-ink",
        running && "border-slate text-slate",
      )}
    >
      {done ? (
        <Icon name="check" size={14} />
      ) : failed ? (
        <Icon name="close" size={14} />
      ) : waiting || running ? (
        n
      ) : (
        ""
      )}
    </span>
  );
}
