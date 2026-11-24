// Triggers and outputs on the builder (owner, 2026-11-23; the mock-up "Ways in, ways out", page
// "In the builder"). An agent's workflows are one main workflow, its triggers (workflows that hand
// work into it) and its outputs (workflows it hands work out to): core's `workflowRoles`. Nothing
// new to learn: each is a workflow of its own, opened by its tab. Here: the icon and word for each
// role (`RoleChip`, after a tab's name), the triggers above the main workflow's chart and its
// outputs below it (`WaysBand`), and on a trigger's or an output's tab, the line back to the main
// workflow. Every link is the tab's own link.
//
// All ways in, in one place (owner, 2026-11-24): the main workflow's own starts are trigger cards
// too, before the trigger workflows. A start has no steps of its own; "Add steps" gives it some by
// moving it to a workflow of its own that hands into the main one (`startToWorkflow`). "Add a
// trigger" adds a start, opened to pick how it starts.
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
/** As a variable: Biome reads a literal `role` prop as an ARIA role. */
const TRIGGER: Role = "trigger";

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

const CARD =
  "flex min-w-[220px] max-w-[340px] flex-1 flex-col gap-1 rounded-md border border-dashed border-slate bg-slate-tint px-3.5 py-3 text-ink";

function Card({ way, role, href }: { way: WayCard; role: Role; href: string }) {
  return (
    <Link
      to={href}
      data-testid={`way-card-${way.slug}`}
      className={cx(CARD, "no-underline hover:border-solid")}
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

/** One of the main workflow's own starts (a trigger with no steps of its own). */
export interface StartCard {
  id: string;
  /** "When a document has been read". */
  title: string;
}

function Start({
  start,
  selected,
  onOpen,
  onAddSteps,
}: {
  start: StartCard;
  selected: boolean;
  onOpen(): void;
  onAddSteps(): void;
}) {
  return (
    <div data-testid={`way-start-${start.id}`} className={cx(CARD, selected && "border-solid")}>
      <RoleChip role={TRIGGER} />
      <button
        type="button"
        aria-pressed={selected}
        data-testid={`way-start-${start.id}-open`}
        onClick={onOpen}
        className="text-left font-medium text-ink"
      >
        {start.title}
      </button>
      <span className="text-sm text-ink-muted">Starts this workflow · no steps of its own</span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium text-slate">
        <button type="button" onClick={onOpen} data-testid={`way-start-${start.id}-settings`}>
          Its settings ›
        </button>
        <button type="button" onClick={onAddSteps} data-testid={`way-start-${start.id}-steps`}>
          Add steps ›
        </button>
      </span>
    </div>
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
  /** The main workflow's own starts, on its tab, before its trigger workflows. */
  starts?: readonly StartCard[];
  /** The start open in the side panel. */
  selectedStart?: string | null;
  onStart?(id: string): void;
  onAddSteps?(id: string): void;
  /** Adds a start to the main workflow; absent at the schema's limit of 10. */
  onAddTrigger?: (() => void) | undefined;
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
    const starts = p.place === "top" ? (p.starts ?? []) : [];
    if (ways.length === 0 && starts.length === 0) return null;
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
        {starts.map((s) => (
          <Start
            key={s.id}
            start={s}
            selected={p.selectedStart === s.id}
            onOpen={() => p.onStart?.(s.id)}
            onAddSteps={() => p.onAddSteps?.(s.id)}
          />
        ))}
        {ways.map((w) => (
          <Card key={w.slug} way={w} role={kind} href={p.href(w.slug)} />
        ))}
        {kind === "trigger" && p.onAddTrigger ? (
          <button
            type="button"
            data-testid="ways-add-trigger"
            onClick={p.onAddTrigger}
            className="flex min-w-[160px] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-line px-3.5 py-3 text-sm font-medium text-slate hover:border-slate"
          >
            <RoleIcon role={TRIGGER} />
            Add a trigger
          </button>
        ) : null}
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
