// The back office work screens' shared parts (docs/plan.md §1.124), on the design system's App
// patterns only (README "App patterns"): KPI boxes, page tabs, filter chips, due dates, urgency,
// where an item stands, the safety hold banner and board cards. No colours of their own.
import type { HoldView, Standing, WorkKpi, WorkUrgency } from "@countersign/core";
import { type ReactNode, useRef } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../ui/cx";
import { useEvenColumns, useScrollEdges } from "../../ui/tileRows";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 27" for an ISO date or instant. */
export function shortDate(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${MON[Number(m) - 1]} ${Number(d)}`;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

const dayDiff = (iso: string, today: string) =>
  Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / 86_400_000);

export function Kpis({ items, compact }: { items: WorkKpi[]; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Even rows (3 + 2, never 4 + 1) at any width (ui/tileRows.ts).
  const even = useEvenColumns(ref, items.length);
  return (
    <div
      ref={ref}
      className={compact ? "ds-kpis ds-kpis--compact" : "ds-kpis"}
      style={even}
      data-testid="work-kpis"
    >
      {items.map((k) => {
        const cls = `ds-kpi${k.tone ? ` ds-kpi--${k.tone}` : ""}`;
        const body = (
          <>
            <span className="ds-kpi__label">{k.label}</span>
            <span className="ds-kpi__value">{k.value}</span>
            {k.note ? <span className="ds-kpi__note">{k.note}</span> : null}
          </>
        );
        return k.href ? (
          <Link key={k.label} className={cls} to={k.href}>
            {body}
          </Link>
        ) : (
          <div key={k.label} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export function PageTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: { to: string; label: string; count?: number | undefined; current: boolean }[];
}) {
  return (
    <nav className="ds-tabs page-tabs" aria-label={label}>
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} aria-current={t.current ? "page" : undefined}>
          {t.label}
          {t.count !== undefined ? <span className="count">{t.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Filter chips. Where the row has room to grow (`wrap`, Your call's bar) they wrap onto a second
 * line; in a table's bar, whose height is fixed, they scroll sideways, with a fade at the edge that
 * has more past it and a thin scrollbar, so none is cut off unseen.
 */
export function FilterChips<K extends string>({
  chips,
  value,
  onChange,
  wrap = false,
}: {
  chips: { key: K; label: string; count: number }[];
  value: K;
  onChange: (k: K) => void;
  wrap?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref);
  return (
    <div
      ref={ref}
      className={cx("ds-filters ui-filters", wrap && "ui-filters--wrap")}
      data-more={wrap ? undefined : edges}
      data-testid="work-filters"
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="ds-filter"
          aria-pressed={value === c.key}
          onClick={() => onChange(c.key)}
          data-testid={`work-filter-${c.key}`}
        >
          {c.label}
          <span className="ds-num">{c.count}</span>
        </button>
      ))}
    </div>
  );
}

/** A due date: late in risk with how late, today in signal, else the date and how far off. */
export function Due({
  iso,
  done,
  today = todayIso(),
}: {
  iso: string | null;
  done?: boolean;
  today?: string;
}) {
  if (!iso) return <span className="mz-due mz-due--none">{done ? "Done" : "No date"}</span>;
  const n = dayDiff(iso, today);
  if (done) return <span className="mz-due">{shortDate(iso)}</span>;
  if (n < 0) {
    return (
      <span className="mz-due mz-due--late">
        {shortDate(iso)}
        <small>
          {-n} day{n === -1 ? "" : "s"} late
        </small>
      </span>
    );
  }
  if (n === 0) return <span className="mz-due mz-due--today">Today</span>;
  return (
    <span className="mz-due">
      {shortDate(iso)}
      <small>{n === 1 ? "Tomorrow" : `In ${n} days`}</small>
    </span>
  );
}

export function UrgencyPill({ urgency }: { urgency: WorkUrgency | null }) {
  if (!urgency) return null;
  return (
    <span className={`mz-urgency mz-urgency--${urgency}`}>
      {urgency[0]?.toUpperCase()}
      {urgency.slice(1)}
    </span>
  );
}

/** Where an item stands, with its one line. */
export function StandingPill({ standing, line }: { standing: Standing; line: string }) {
  const text = line || DEFAULT_LINE[standing];
  switch (standing) {
    case "you":
      return <span className="ds-pill ds-pill--warning ds-pill--sm">Needs you · {text}</span>;
    case "agent":
      return <span className="mz-agentline mz-agentline--working">{text}</span>;
    case "client":
      return <span className="ds-pill ds-pill--neutral ds-pill--sm">{text}</span>;
    case "stalled":
      return <span className="ds-pill ds-pill--risk ds-pill--sm">{text}</span>;
    default:
      return <span className="ds-pill ds-pill--positive ds-pill--sm">{text}</span>;
  }
}

const DEFAULT_LINE: Record<Standing, string> = {
  you: "Your move",
  agent: "Reggie on it",
  client: "Waiting on the client",
  stalled: "Stuck",
  done: "Done",
};

/** The safety hold, over a list or a record. */
export function HoldBanner({ holds, actions }: { holds: HoldView[]; actions?: ReactNode }) {
  if (holds.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="work-holds">
      {holds.map((h) => (
        <div key={h.agent.id} className="mz-hold">
          <span>
            <b>Safety hold on:</b> {h.client.name}'s {h.agent.name}, since {shortDate(h.since)}.{" "}
            {h.held.writes} write{h.held.writes === 1 ? "" : "s"} and {h.held.messages} message
            {h.held.messages === 1 ? "" : "s"} held.
          </span>
          {actions ?? (
            <Link className="ds-btn ds-btn--secondary ds-btn--sm" to={`/ops/issues/${h.issueId}`}>
              Review
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

/** A to-do line: who has it and when it's due. */
export function TodoLine({
  title,
  owner,
  due,
}: {
  title: string;
  owner: "operator" | "reggie" | "client";
  due: string | null;
}) {
  return (
    <div className="mz-todo">
      <input type="checkbox" aria-label="Done" disabled />
      <div>
        {title}
        {due ? <small>{shortDate(due)}</small> : null}
      </div>
      {owner === "operator" ? (
        <span className="ds-pill ds-pill--person ds-pill--sm">You</span>
      ) : owner === "client" ? (
        <span className="ds-pill ds-pill--neutral ds-pill--sm">Client</span>
      ) : (
        <span className="mz-agentline">Reggie</span>
      )}
    </div>
  );
}
