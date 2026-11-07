// UI cleanup: what the period's work cost, as a plain bar chart on the design system's data tokens
// (dataviz: one series, so no legend box; thin bars on a baseline with a 2px gap and rounded tops;
// a tooltip on hover or focus for every bar; recessive axis words; the tables below are its table
// view). Bars are by day for a short period, else by month.
import { dec } from "@countersign/core";
import { cx } from "../ui/primitives";
import { cost } from "./format";

export interface ChartPoint {
  key: string;
  /** Under the bar, for the few bars that are labelled ("Nov 3"). */
  label: string;
  /** In the tooltip ("Nov 3, 2026"). */
  long: string;
  /** Decimal string, never a float until it becomes a height. */
  costUsd: string;
  runs: number;
}

export function SpendChart({
  points,
  testId = "usage-chart",
}: {
  points: readonly ChartPoint[];
  testId?: string;
}) {
  // Heights only: the figures shown are the decimal strings.
  const values = points.map((p) => dec(p.costUsd).toNumber());
  const top = Math.max(...values, 0);
  // Label the first, middle and last bars, so the axis never crowds.
  const labelled = new Set(
    points.length <= 7
      ? points.map((_, i) => i)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1],
  );
  const summary = `Model cost, ${points.length} ${points.length === 1 ? "bar" : "bars"}, highest ${cost(
    points[values.indexOf(top)]?.costUsd ?? "0",
  )}`;
  return (
    <figure data-testid={testId} className="flex flex-col gap-2">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="flex items-baseline justify-between text-xs text-ink-muted figures">
        <span>{top > 0 ? cost(points[values.indexOf(top)]?.costUsd ?? "0") : "$0.00"}</span>
      </div>
      <div className="flex h-40 items-end gap-[2px] border-b border-line-strong">
        {points.map((p, i) => {
          const v = values[i] ?? 0;
          const pct = top > 0 ? (v / top) * 100 : 0;
          return (
            <div
              key={p.key}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: each bar's figure shows on focus too.
              tabIndex={0}
              role="img"
              data-testid={`${testId}-bar-${p.key}`}
              aria-label={`${p.long}: ${cost(p.costUsd)}, ${p.runs} ${p.runs === 1 ? "run" : "runs"}`}
              className="group relative flex h-full min-w-0 flex-1 items-end outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              <span
                aria-hidden
                className={cx(
                  "block w-full rounded-t-sm bg-data-bar group-hover:opacity-80 group-focus-visible:opacity-80",
                  v > 0 ? "min-h-[2px]" : "",
                )}
                style={{ height: `${pct}%` }}
              />
              <span
                role="tooltip"
                className="ds-tooltip pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap group-hover:block group-focus-visible:block"
              >
                {p.long} · {cost(p.costUsd)} · {p.runs} {p.runs === 1 ? "run" : "runs"}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex gap-[2px] text-xs text-ink-muted">
        {points.map((p, i) => (
          <span
            key={p.key}
            className={cx(
              "min-w-0 flex-1 overflow-visible whitespace-nowrap",
              i === points.length - 1 && points.length > 1 ? "text-right" : "",
            )}
          >
            {labelled.has(i) ? p.label : ""}
          </span>
        ))}
      </div>
    </figure>
  );
}
