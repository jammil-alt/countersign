// Triggers and outputs on the builder (owner, 2026-11-23; the mock-up "Ways in, ways out", page
// "In the builder"). An agent's workflows are one main workflow, its triggers (workflows that hand
// work into it) and its outputs (workflows it hands work out to): core's `workflowRoles`. Nothing
// new to learn: each is a workflow of its own, opened by its tab. Here: the icon and word for each
// role (`RoleChip`, after a tab's name), the triggers above the main workflow's chart and its
// outputs below it (`WaysBand`), and on a trigger's or an output's tab, the line back to the main
// workflow. Every link is the tab's own link.
import type { processes } from "@countersign/core";
import { Link } from "react-router-dom";
import { ConnectorMark } from "../../connections/ConnectorMark";
import { cx } from "../../ui/cx";

type Role = "trigger" | "output";

/**
 * The trigger's and the output's icons, drawn to the Mezonas set's rules (24px grid, 1.5px stroke,
 * square caps, miter joins, outline): an arrow into a bracket, and its mirror out of one.
 */
// DECISION (owner, 2026-11-23, "this looks good"): the mock-up's first pair. Drawn here, not in
// packages/design-system, which is replaced whole by the owner's next delivery (CLAUDE.md).
export function RoleIcon({ role, size = 16 }: { role: Role; size?: 14 | 16 | 20 | 24 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      data-role-icon={role}
    >
      <path
        d={
          role === "trigger"
            ? "M13 4h6v16h-6 M3 12h11 M10 8l4 4-4 4"
            : "M11 4H5v16h6 M9 12h12 M17 8l4 4-4 4"
        }
      />
    </svg>
  );
}

const WORD: Record<Role, string> = { trigger: "Trigger", output: "Output" };

/** The icon and its word, always together (brand book: an icon never stands alone). */
export function RoleChip({ role, className }: { role: Role; className?: string }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1 text-xs font-medium text-slate", className)}
      data-testid={`role-chip-${role}`}
    >
      <RoleIcon role={role} />
      {WORD[role]}
    </span>
  );
}

/** A system a workflow reaches: its connector's id and name. */
export interface WaySystem {
  id: string;
  name: string;
}

/** One trigger or output, as its card says it. */
export interface WayCard {
  slug: string;
  name: string;
  /** "Starts every night at 2:00" for a trigger; empty for an output. */
  starts: string;
  steps: number;
  systems: readonly WaySystem[];
}

function Systems({ systems }: { systems: readonly WaySystem[] }) {
  if (systems.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink">
      {systems.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1.5">
          <ConnectorMark name={s.name} connector={s.id} size="xs" />
          {s.name}
        </span>
      ))}
    </span>
  );
}

function Card({ way, role, href }: { way: WayCard; role: Role; href: string }) {
  return (
    <Link
      to={href}
      data-testid={`way-card-${way.slug}`}
      className="flex min-w-[220px] max-w-[340px] flex-1 flex-col gap-1 rounded-md border border-dashed border-slate bg-slate-tint px-3.5 py-3 text-ink no-underline hover:border-solid"
    >
      <RoleChip role={role} />
      <span className="font-medium">{way.name}</span>
      <span className="text-sm text-ink-muted">
        {[way.starts, `${way.steps} ${way.steps === 1 ? "step" : "steps"}`]
          .filter(Boolean)
          .join(" · ")}
      </span>
      <Systems systems={way.systems} />
      <span className="text-sm font-medium text-slate">Open its workflow ›</span>
    </Link>
  );
}

export interface WaysBandProps {
  /** What the open workflow is (core's `workflowRoles`). */
  role: processes.WorkflowRoleInfo | undefined;
  /** The main workflow's name. */
  mainName: string;
  /** A workflow's tab, by slug. */
  href(slug: string): string;
  /** The main workflow's triggers and outputs, on the main workflow's tab. */
  triggers: readonly WayCard[];
  outputs: readonly WayCard[];
  /** The systems the open workflow reaches, for the line on a trigger's or an output's tab. */
  systems: readonly WaySystem[];
  /** Above the chart, or below it. */
  place: "top" | "bottom";
}

/**
 * Above the chart: the main workflow's triggers, or on a trigger's or output's tab the line back
 * to the main workflow. Below it: the main workflow's outputs. Nothing for any other workflow.
 */
export function WaysBand(p: WaysBandProps) {
  const role = p.role?.role;
  const main = p.role?.main;
  if (!role || !main) return null;
  if (role === "main") {
    const ways = p.place === "top" ? p.triggers : p.outputs;
    if (ways.length === 0) return null;
    const kind: Role = p.place === "top" ? "trigger" : "output";
    return (
      <section
        aria-label={kind === "trigger" ? "Triggers into this workflow" : "Outputs of this workflow"}
        data-testid={`ways-${kind}s`}
        className={cx(
          "flex flex-wrap items-stretch justify-center gap-3 bg-surface px-4 py-3",
          p.place === "top" ? "border-b border-line" : "border-t border-line",
        )}
      >
        {ways.map((w) => (
          <Card key={w.slug} way={w} role={kind} href={p.href(w.slug)} />
        ))}
      </section>
    );
  }
  if (p.place !== "top" || (role !== "trigger" && role !== "output")) return null;
  return (
    <div
      data-testid="ways-back"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-4 py-2.5 text-sm"
    >
      <RoleChip role={role} />
      <span className="text-ink-muted">
        {role === "trigger" ? "Hands work into " : "Takes work from "}
        <Link to={p.href(main)} className="font-medium" data-testid="ways-back-link">
          {p.mainName} ›
        </Link>
      </span>
      {p.systems.length > 0 ? (
        <span className="flex items-center gap-2 text-ink-muted">
          Uses <Systems systems={p.systems} />
        </span>
      ) : null}
    </div>
  );
}
