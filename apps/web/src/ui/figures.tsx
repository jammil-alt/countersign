// Figures (docs/design/prototype.html `.big`, `.bar`, `.spark`): a stat tile with its label, value
// and a note; a progress bar; small bars of recent runs; a sparkline and the change from last time.
// Marks use the data and status tokens only; every one carries words for people who can't see the
// colour.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "./cx";

/** A state colour for a tile, card or row's accent (brand book): always beside a word. */
export type AccentTone = "signal" | "positive" | "risk" | "slate" | "copper";

/**
 * "TASKS DONE · 38 · Across 112 runs". `alert` draws the tile's border and label in risk. `tone`
 * gives it its state colour: a thin accent on top, and for `signal` (waiting on you) the tint.
 * `mark` sits beside the value (a `Sparkline` or a `Delta`); `to` makes the whole tile a link.
 */
export function StatTile({
  label,
  value,
  note,
  noteTone,
  alert,
  tone,
  mark,
  to,
  testId,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  /** `risk` for a problem, `signal` for waiting on you, `positive` for done. */
  noteTone?: "risk" | "signal" | "positive";
  alert?: boolean;
  tone?: AccentTone | undefined;
  mark?: ReactNode;
  to?: string | undefined;
  testId?: string;
}) {
  const className = cx(
    "ds-card ui-stat",
    alert && "ui-stat--alert",
    tone && `ui-accent ui-stat--${tone}`,
    to && "ui-stat--link",
  );
  const body = (
    <>
      <p className="eyebrow ui-stat__label">{label}</p>
      <span className="ui-stat__row">
        <span className="ui-stat__value">{value}</span>
        {mark ? <span className="ui-stat__mark">{mark}</span> : null}
      </span>
      {note ? (
        <p className={cx("ui-stat__note", noteTone && `ui-tone-${noteTone}`)}>{note}</p>
      ) : null}
    </>
  );
  if (to) {
    return (
      <Link to={to} data-testid={testId} data-tone={tone} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <div data-testid={testId} data-tone={tone} className={className}>
      {body}
    </div>
  );
}

/** A row of figures (at most four is the rule), folding to two at phone width. */
export function KpiStrip({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="ui-kpis" data-testid={testId}>
      {children}
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

/** Runs each day for a sparkline: `{ runs, failed }` per day, oldest first. */
export interface SparkDay {
  runs: number;
  failed?: number;
}

/** Whether a run of days has anything to draw (all zero: leave the chart out). */
export function hasRuns(days: readonly SparkDay[] | undefined): days is readonly SparkDay[] {
  return !!days && days.some((d) => d.runs > 0);
}

const SPARK_W = 88;
const SPARK_H = 24;

/**
 * The design system's sparkline (`dt-spark`): a line of runs per day, a dot on today, and a risk
 * dot on each day that had a failed run. `label` says it in words.
 */
export function Sparkline({
  days,
  label,
  testId,
}: {
  days: readonly SparkDay[];
  label: string;
  testId?: string;
}) {
  const top = Math.max(1, ...days.map((d) => d.runs));
  const step = days.length > 1 ? (SPARK_W - 4) / (days.length - 1) : 0;
  const pts = days.map((d, i) => ({
    x: 2 + i * step,
    y: SPARK_H - 3 - (d.runs / top) * (SPARK_H - 6),
    failed: (d.failed ?? 0) > 0,
  }));
  const last = pts.at(-1);
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testId}
      className="dt-spark ui-sparkline"
      width={SPARK_W}
      height={SPARK_H}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
    >
      <polyline className="ln" points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />
      {pts
        .filter((p) => p.failed)
        .map((p) => (
          <circle key={`f${p.x}`} className="ui-sparkline__failed" cx={p.x} cy={p.y} r={2.5} />
        ))}
      {last ? <circle className="dot" cx={last.x} cy={last.y} r={3} /> : null}
    </svg>
  );
}

/**
 * The change from last time (`dt-delta`): an arrow in `data-up` or `data-down` and the words,
 * which the caller gives in the reader's language ("Up 3 from last week").
 */
export function Delta({
  now,
  before,
  words,
  testId,
}: {
  now: number;
  before: number;
  words: (direction: "up" | "down" | "same", by: number) => string;
  testId?: string;
}) {
  const by = Math.abs(now - before);
  const direction = now > before ? "up" : now < before ? "down" : "same";
  return (
    <span className="dt-delta ui-delta" data-testid={testId} data-direction={direction}>
      {direction === "same" ? null : (
        <span aria-hidden className={direction}>
          {direction === "up" ? "▲" : "▼"}
        </span>
      )}
      <span>{words(direction, by)}</span>
    </span>
  );
}
