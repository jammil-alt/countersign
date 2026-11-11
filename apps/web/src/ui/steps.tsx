// A run's or a worksheet's steps in order (docs/design/prototype.html `.steps`, `.tl`): a numbered
// mark on a rail, the step's title and detail, and optionally its time on the left. Marks: done is
// a positive check, the current step a slate ring, waiting on you signal "!", failed risk "!",
// a person's step copper. Each mark also says its state in words for screen readers. A step with
// `onOpen` opens its details (the run pages' step panel): its title is a button, marked while open.
import type { ReactNode } from "react";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { cx } from "./cx";
import { Icon } from "./icons";

export const STEP_STATES = ["done", "current", "waiting", "failed", "person", "todo"] as const;
export type StepState = (typeof STEP_STATES)[number];

export interface StepItem {
  /** Stable across renders (a step id). */
  key: string;
  title: ReactNode;
  detail?: ReactNode;
  state: StepState;
  /** "8:01:12", "next": shown in a column on the left when any step has one. */
  time?: ReactNode;
  /** Receipts, an in/out box, anything under the detail. */
  children?: ReactNode;
  testId?: string;
  /** Opens the step's details: the title becomes a button. */
  onOpen?: () => void;
  /** The step whose details are open. */
  selected?: boolean;
}

const STATE_WORDS = {
  done: "ui.step.done",
  current: "ui.step.current",
  waiting: "ui.step.waiting",
  failed: "ui.step.failed",
  person: "ui.step.person",
  todo: "ui.step.todo",
} as const satisfies Record<StepState, MessageKey>;

export function StepList({ steps, testId }: { steps: readonly StepItem[]; testId?: string }) {
  const { t } = useI18n();
  const timed = steps.some((s) => s.time !== undefined);
  return (
    <ol data-testid={testId} className={cx("ui-steps", timed && "ui-steps--timed")}>
      {steps.map((s, i) => (
        <li
          key={s.key}
          data-testid={s.testId}
          data-state={s.state}
          className={cx("ui-steps__item", s.selected && "is-selected")}
        >
          {timed ? <span className="ui-steps__time">{s.time}</span> : null}
          <span className="ui-steps__rail">
            <span className={cx("ui-steps__mark", `is-${s.state}`)}>
              {s.state === "done" ? (
                <Icon name="check" size={14} />
              ) : s.state === "waiting" || s.state === "failed" ? (
                "!"
              ) : (
                i + 1
              )}
            </span>
            <span className="sr-only">{t(STATE_WORDS[s.state])}</span>
          </span>
          <div className="ui-steps__body">
            {s.onOpen ? (
              <button
                type="button"
                className="ui-steps__open"
                aria-haspopup="dialog"
                aria-expanded={s.selected ?? false}
                data-testid={s.testId ? `${s.testId}-open` : undefined}
                onClick={s.onOpen}
              >
                <span className={cx("ui-steps__title", s.state === "person" && "text-copper-ink")}>
                  {s.title}
                </span>
                {s.detail ? <span className="text-sm text-ink-muted">{s.detail}</span> : null}
              </button>
            ) : (
              <>
                <p className={cx("ui-steps__title", s.state === "person" && "text-copper-ink")}>
                  {s.title}
                </p>
                {s.detail ? <p className="text-sm text-ink-muted">{s.detail}</p> : null}
              </>
            )}
            {s.children}
          </div>
        </li>
      ))}
    </ol>
  );
}
