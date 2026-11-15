// Agent motion (docs/plan.md §1.106, the design system's components/Motion): a running step's
// thinking state, and a job's progress toward a known total. The markup is the delivery's,
// class for class; the CSS is the design system's motion.css. Both stop moving under
// prefers-reduced-motion (the CSS's own rule); progress still updates.
import type { ThinkingState } from "@countersign/core";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

/**
 * A running step's loop, 24px. Decorative: the step's own words say what it does, so it is
 * hidden from screen readers.
 */
export function Thinking({ state, className }: { state: ThinkingState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-thinking={state}
      className={cx("mz-think", `mz-think--${state}`, className)}
    >
      {state === "weighing" ? (
        <>
          <i />
          <i />
          <i />
        </>
      ) : state === "drafting" ? (
        <>
          <i />
          <i />
          <i />
          <b />
        </>
      ) : state === "rechecking" ? (
        <>
          <b />
          <i />
          <i />
          <i />
          <i />
        </>
      ) : (
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path className="p p1" pathLength={1} d="M4 6 L13 4 L20 10" />
          <path className="p p2" pathLength={1} d="M4 6 L7 18 L18 19" />
          <path className="p p3" pathLength={1} d="M18 19 L20 10" />
          <circle className="n n0" cx="4" cy="6" r="1.75" />
          <circle className="n" cx="13" cy="4" r="1.75" />
          <circle className="n" cx="20" cy="10" r="1.75" />
          <circle className="n" cx="7" cy="18" r="1.75" />
          <circle className="n" cx="18" cy="19" r="1.75" />
        </svg>
      )}
    </span>
  );
}

/** 0–100, whole numbers, as the delivery's `mzSetProgress` rounds it. */
export function clampPercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)));
}

/** How full each of the ten sheets is (0–1): one sheet per 10%, filling from the bottom. */
export function sheetFills(percent: number): number[] {
  const p = clampPercent(percent);
  return Array.from({ length: 10 }, (_, m) => Math.max(0, Math.min(1, (p - 10 * m) / 10)));
}

/** Which of the ruler's 41 ticks are on: tick j at j × 2.5%. */
export function rulerTicks(percent: number): boolean[] {
  const p = clampPercent(percent);
  return Array.from({ length: 41 }, (_, j) => p > 0 && j * 2.5 <= p);
}

/**
 * Progress toward a known total, driven by real progress: Ruler (a large count over a rule) or
 * Sheets (ten sheets, compact); the two are interchangeable. `label` is what it is doing now
 * ("Reading 14 open invoices"), `who` the agent or person doing it.
 */
export function Progress({
  variant,
  percent,
  label,
  name,
  who,
  testId,
}: {
  variant: "ruler" | "sheets";
  percent: number;
  label: ReactNode;
  /** What it measures, for screen readers ("Run progress"). */
  name: string;
  who?: ReactNode;
  testId?: string;
}) {
  const p = clampPercent(percent);
  const bar = {
    role: "progressbar",
    "aria-label": name,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": p,
    "data-testid": testId,
  } as const;
  if (variant === "ruler") {
    return (
      <div className="mz-progress mz-progress--ruler" {...bar}>
        <div>
          <div className="mz-progress__pct">{p}%</div>
          <div className="mz-progress__label">{label}</div>
        </div>
        <div className="mz-ruler">
          {rulerTicks(p).map((on, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the 41 ticks are fixed.
            <span key={j} className={cx(on && "is-on")} />
          ))}
        </div>
        <div className="mz-ruler__scale" aria-hidden="true">
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100</span>
        </div>
        {who ? <span className="mz-step__who">{who}</span> : null}
      </div>
    );
  }
  return (
    <div className="mz-progress mz-progress--sheets" {...bar}>
      <div className="mz-progress__head">
        <span className="mz-progress__label">{label}</span>
        <span className="mz-progress__pct">{p}%</span>
      </div>
      <div className="mz-sheets">
        {sheetFills(p).map((fill, m) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the ten sheets are fixed.
            key={m}
            className={cx(fill > 0 && "is-started")}
            style={{ "--fill": fill } as CSSProperties}
          />
        ))}
      </div>
      {who ? <span className="mz-step__who">{who}</span> : null}
    </div>
  );
}
