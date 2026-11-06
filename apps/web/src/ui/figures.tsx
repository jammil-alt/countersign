// Figures (docs/design/prototype.html `.big`, `.bar`, `.spark`): a stat tile with its label, value
// and a note; a progress bar; small bars of recent runs. Marks use the data and status tokens
// only; every one carries words for people who can't see the colour.
import type { ReactNode } from "react";
import { cx } from "./cx";

/** "TASKS DONE · 38 · Across 112 runs". `alert` draws the tile's border and label in risk. */
export function StatTile({
  label,
  value,
  note,
  noteTone,
  alert,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  /** `risk` for a problem, `signal` for waiting on you, `positive` for done. */
  noteTone?: "risk" | "signal" | "positive";
  alert?: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className={cx("ds-card ui-stat", alert && "ui-stat--alert")}>
      <p className="eyebrow ui-stat__label">{label}</p>
      <p className="ui-stat__value">{value}</p>
      {note ? (
        <p className={cx("ui-stat__note", noteTone && `ui-tone-${noteTone}`)}>{note}</p>
      ) : null}
    </div>
  );
}

/** "Step 3 of 6": a bar filled to value ÷ max. `waiting` fills in signal, `risk` in risk. */
export function ProgressBar({
  value,
  max,
  label,
  tone = "accent",
}: {
  value: number;
  max: number;
  /** What it measures, for screen readers ("Step 3 of 6"). */
  label: string;
  tone?: "accent" | "waiting" | "risk";
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cx("ui-bar", tone !== "accent" && `ui-bar--${tone}`)}
    >
      <i style={{ width: `${Math.round(share * 1000) / 10}%` }} />
    </div>
  );
}

/** Small bars, one per value, scaled to the largest; `failed` bars in risk. */
export function Sparkbars({
  values,
  label,
}: {
  values: readonly { value: number; failed?: boolean }[];
  /** What the bars show ("Last 24 runs: 2 failed"). */
  label: string;
}) {
  const top = Math.max(1, ...values.map((v) => v.value));
  return (
    <span role="img" aria-label={label} className="ui-spark">
      {values.map((v, i) => (
        <i
          // biome-ignore lint/suspicious/noArrayIndexKey: bars are positional.
          key={i}
          className={v.failed ? "is-failed" : undefined}
          style={{ height: `${Math.max(10, Math.round((v.value / top) * 100))}%` }}
        />
      ))}
    </span>
  );
}
