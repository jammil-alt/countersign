// Feedback (2026-11-16): the period's model cost as a line, day by day, starting on the first day
// with any usage rather than at the start of the period. One series on the design system's data
// tokens (dataviz: a 2px line, round joins; a hairline baseline; no legend box, the title names it;
// a crosshair that snaps to the nearest day with one tooltip; the same readout by keyboard with the
// arrow keys; recessive axis words; the tables below are its table view).
import { dec } from "@countersign/core";
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from "react";
import { cost } from "./format";

export interface ChartPoint {
  key: string;
  /** Under the line, for the few days that are named ("Nov 3"). */
  label: string;
  /** In the readout ("Nov 3, 2026"). */
  long: string;
  /** Decimal string, never a float until it becomes a height. */
  costUsd: string;
  runs: number;
}

/** The points from the first one with any cost or run; all of them when none has any. */
export function fromFirstUsage(points: readonly ChartPoint[]): readonly ChartPoint[] {
  const first = points.findIndex((p) => p.runs > 0 || !dec(p.costUsd).isZero());
  return first <= 0 ? points : points.slice(first);
}

const W = 1000;
const H = 200;
const PAD_TOP = 8;

export function LineChart({
  points,
  testId = "usage-line",
}: {
  points: readonly ChartPoint[];
  testId?: string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const plot = useRef<SVGSVGElement>(null);
  const tipId = useId();
  // Heights only: the figures shown are the decimal strings.
  const values = points.map((p) => dec(p.costUsd).toNumber());
  const top = Math.max(...values, 0);
  const n = points.length;
  const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const y = (v: number) => (top > 0 ? H - (v / top) * (H - PAD_TOP) : H);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const highest = points[values.indexOf(top)];
  const shown = at === null ? null : points[at];
  // The first, middle and last days are named under the line, so the axis never crowds.
  const ticks = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];

  const nearest = (e: PointerEvent<SVGSVGElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || box.width === 0 || n === 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    setAt(Math.round(ratio * (n - 1)));
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (n === 0) return;
    if (e.key === "ArrowRight") setAt((i) => Math.min(n - 1, (i ?? -1) + 1));
    else if (e.key === "ArrowLeft") setAt((i) => Math.max(0, (i ?? n) - 1));
    else if (e.key === "Home") setAt(0);
    else if (e.key === "End") setAt(n - 1);
    else return;
    e.preventDefault();
  };

  const summary =
    n === 0
      ? "Model cost: no days to show"
      : `Model cost by day, ${points[0]?.long} to ${points.at(-1)?.long}, highest ${cost(
          highest?.costUsd ?? "0",
        )} on ${highest?.long}. Use the arrow keys to read each day.`;
  return (
    <figure data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-xs text-ink-muted figures">
        <span>{top > 0 ? cost(highest?.costUsd ?? "0") : "$0.00"}</span>
        {shown ? (
          <span
            id={tipId}
            role="status"
            className="text-sm text-ink"
            data-testid={`${testId}-readout`}
          >
            <span className="font-medium">{cost(shown.costUsd)}</span>
            <span className="text-ink-muted">
              {" "}
              · {shown.runs} {shown.runs === 1 ? "run" : "runs"} · {shown.long}
            </span>
          </span>
        ) : null}
      </div>
      {/* The arrow keys read the line day by day. */}
      <div
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus is how the keys reach the readout.
        tabIndex={0}
        role="img"
        aria-label={summary}
        aria-describedby={shown ? tipId : undefined}
        data-testid={`${testId}-plot`}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
        className="relative h-40 outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <svg
          ref={plot}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="block h-full w-full touch-none overflow-visible"
          aria-hidden
          onPointerMove={nearest}
          onPointerDown={nearest}
          onPointerLeave={() => setAt(null)}
        >
          <line
            x1={0}
            x2={W}
            y1={H}
            y2={H}
            stroke="var(--line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {n > 1 ? (
            <path
              d={path}
              fill="none"
              stroke="var(--data-line)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              data-testid={`${testId}-path`}
            />
          ) : null}
          {at !== null ? (
            <line
              x1={x(at)}
              x2={x(at)}
              y1={0}
              y2={H}
              stroke="var(--line-strong)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
        {/* The marker as HTML, so it stays round where the plot is stretched. */}
        {at !== null || n === 1 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface box-content bg-data-line"
            style={{
              left: `${(x(at ?? 0) / W) * 100}%`,
              top: `${(y(values[at ?? 0] ?? 0) / H) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <div className="relative h-4 text-xs text-ink-muted">
        {ticks.map((i) => {
          const p = points[i];
          if (!p) return null;
          const left = (x(i) / W) * 100;
          return (
            <span
              key={p.key}
              className="absolute whitespace-nowrap"
              style={
                i === n - 1 && n > 1
                  ? { right: 0 }
                  : i === 0
                    ? { left: 0 }
                    : { left: `${left}%`, transform: "translateX(-50%)" }
              }
            >
              {p.label}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
