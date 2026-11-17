// The Sales screens' small parts (docs/design/pipelines.html), each on the design system's app
// patterns (packages/design-system README "App patterns"): KPI boxes, page tabs, filter chips,
// due dates, where a deal stands, and sortable column heads. No new colours, fonts, radii or
// shadows; both themes come from the tokens.
// DECISION: kept in the Sales folder for now; the shared work parts (apps/web/src/ops/work/,
// §1.123 stage 0) replace them when they land, with the same classes.
import { type DealStanding, daysFrom, shortDay, wholeMoney } from "@countersign/core";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../../ui/cx";

export function Kpis({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="ds-kpis" data-testid={testId}>
      {children}
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  tone,
  to,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: "signal" | "risk" | "positive" | undefined;
  to?: string;
  testId?: string;
}) {
  const className = cx("ds-kpi", tone && `ds-kpi--${tone}`);
  const inner = (
    <>
      <span className="ds-kpi__label">{label}</span>
      <span className="ds-kpi__value">{value}</span>
      {note ? <span className="ds-kpi__note">{note}</span> : null}
    </>
  );
  return to ? (
    <Link to={to} className={className} data-testid={testId}>
      {inner}
    </Link>
  ) : (
    <div className={className} data-testid={testId}>
      {inner}
    </div>
  );
}

/** A section's lists as page tabs: links, the current one marked, each with its count. */
export function PageTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: { to: string; label: string; count?: number; current: boolean }[];
}) {
  return (
    <nav className="ds-tabs page-tabs mb-4" aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} aria-current={t.current ? "page" : undefined}>
          {t.label}
          {t.count !== undefined ? <span className="count text-ink-muted">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

export function FilterChips<K extends string>({
  filters,
  value,
  onChange,
  testId,
}: {
  filters: { key: K; label: string; count: number }[];
  value: K;
  onChange(k: K): void;
  testId?: string;
}) {
  return (
    <div className="ds-filters" data-testid={testId}>
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          className="ds-filter"
          aria-pressed={f.key === value}
          onClick={() => onChange(f.key)}
          data-testid={testId ? `${testId}-${f.key}` : undefined}
        >
          {f.label}
          <span className="ds-num">{f.count}</span>
        </button>
      ))}
    </div>
  );
}

/** A due date: late in risk with how late, today in signal, else the date and how far. */
export function Due({ on, today, done }: { on: string | null; today: string; done?: boolean }) {
  if (!on) return <span className="mz-due mz-due--none">{done ? "Done" : "No date"}</span>;
  if (done) return <span className="mz-due">{shortDay(on)}</span>;
  const n = daysFrom(today, on);
  if (n < 0) {
    return (
      <span className="mz-due mz-due--late">
        {shortDay(on)}
        <small>
          {-n} day{n === -1 ? "" : "s"} late
        </small>
      </span>
    );
  }
  if (n === 0) return <span className="mz-due mz-due--today">Today</span>;
  return (
    <span className="mz-due">
      {shortDay(on)}
      <small>{n === 1 ? "Tomorrow" : `In ${n} days`}</small>
    </span>
  );
}

/** Where it stands, in words: gold "Needs you", Reggie at work, the client, stalled, done. */
export function Standing({
  standing,
  text,
  testId,
}: {
  standing: DealStanding;
  text: string;
  testId?: string;
}) {
  switch (standing) {
    case "you":
      return (
        <span className="ds-pill ds-pill--warning ds-pill--sm" data-testid={testId}>
          Needs you · {text}
        </span>
      );
    case "agent":
      return (
        <span className="mz-agentline mz-agentline--working" data-testid={testId}>
          {text}
        </span>
      );
    case "client":
      return (
        <span className="ds-pill ds-pill--neutral ds-pill--sm" data-testid={testId}>
          {text}
        </span>
      );
    case "stalled":
      return (
        <span className="ds-pill ds-pill--risk ds-pill--sm" data-testid={testId}>
          {text}
        </span>
      );
    default:
      return (
        <span className="ds-pill ds-pill--positive ds-pill--sm" data-testid={testId}>
          {text}
        </span>
      );
  }
}

export type SortDir = 1 | -1;
export interface Sort<C extends string> {
  col: C;
  dir: SortDir;
}

/** A sortable column head: a dt-sort button, its order said with aria-sort. */
export function SortHead<C extends string>({
  col,
  label,
  sort,
  onSort,
  numeric,
}: {
  col: C;
  label: string;
  sort: Sort<C>;
  onSort(s: Sort<C>): void;
  numeric?: boolean;
}) {
  const on = sort.col === col;
  return (
    <th
      className={numeric ? "n" : undefined}
      aria-sort={on ? (sort.dir > 0 ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        className="dt-sort"
        onClick={() => onSort({ col, dir: on ? (-sort.dir as SortDir) : 1 })}
      >
        {label}
      </button>
    </th>
  );
}

/** "$2,400" (whole dollars); "+$1,200" for more from a client, except a renewal. */
export function monthValue(d: {
  mrr: string;
  currency: string;
  kind: "new" | "expansion";
  renewal: boolean;
}): string {
  const v = wholeMoney(d.mrr, d.currency);
  return d.kind === "expansion" && !d.renewal ? `+${v}` : v;
}

/** "2400.5000" → "2400.5": a stored amount as a person would type it. */
export function plainAmount(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
