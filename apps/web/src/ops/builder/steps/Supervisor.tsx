// The supervisor on the step builder (owner, 2026-11-27: "add basic UI to the steps to show the
// supervisor agent"). The supervisor is the agent's owner: the business area's owner agent that
// watches each step and decides what happens when one fails or looks off (ARCHITECTURE §10.11,
// §10.15). Here: its level on the bar (`definition.oversight.review`, core's words and costs), a
// quiet mark on each step it checks after the step succeeds, the step's own setting in its panel,
// and what it checked and decided on each step of a try.
// DECISION: called "Supervisor" in the builder, with a hint that it is the area's owner; a try's
// results show the run page's own lines (`../../run/Supervision`).
import {
  type OversightReview,
  OWNER_REVIEW_CHOICES,
  type OwnerReviewDue,
  processes,
  type StepReview,
} from "@countersign/core";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../ui/icons";
import { cx } from "../../../ui/primitives";
import { parseNodeId } from "../../run/checklist";
import { type StepSupervision, SupervisionLines, stepSupervision } from "../../run/Supervision";
import { SmallSelect } from "../fields";
import type { UsesContext } from "./options";
import type { TryRun } from "./TryPanel";
import type { Step, Workflow } from "./types";

// ── The level, on the bar ──

export const SUPERVISOR_HINT =
  "The supervisor is this area's owner agent. It watches the steps and decides what happens when one fails or looks off.";

/** The bar's control: the level in core's words, opening the four choices with what each costs. */
export function SupervisorControl({
  review,
  set,
  verifies,
  onChange,
}: {
  review: OversightReview;
  /** False when the agent has no `oversight` saved: the new-agent default applies. */
  set: boolean;
  /** Writes are checked against the run's sources (`oversight.verify: writes`), kept as it is. */
  verifies: boolean;
  onChange(review: OversightReview): void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = OWNER_REVIEW_CHOICES.find((c) => c.value === review);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="ds-btn ds-btn--secondary ds-btn--sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menu : undefined}
        title={SUPERVISOR_HINT}
        data-testid="steps-supervisor"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-ink-muted">Supervisor:</span>
        <span data-testid="steps-supervisor-level">{current?.label ?? review}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div
          id={menu}
          role="dialog"
          aria-label="Supervisor"
          data-testid="steps-supervisor-menu"
          className="absolute top-full right-0 z-30 mt-2 flex w-96 max-w-[calc(100vw-32px)] flex-col gap-2 rounded-md border border-line bg-surface p-3"
        >
          <p className="text-xs text-ink-muted">
            {SUPERVISOR_HINT}
            {set ? "" : " Not set for this agent yet: it reviews failures, as a new agent does."}
          </p>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="sr-only">What the supervisor reviews</legend>
            {OWNER_REVIEW_CHOICES.map((c) => {
              const on = c.value === review;
              return (
                <label
                  key={c.value}
                  className={cx(
                    "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2",
                    on ? "border-slate bg-slate-tint" : "border-line hover:bg-surface-subtle",
                  )}
                >
                  <input
                    type="radio"
                    name={`${menu}-review`}
                    className="mt-0.5 size-4 accent-slate"
                    data-testid={`steps-supervisor-${c.value}`}
                    checked={on}
                    onChange={() => {
                      onChange(c.value);
                      setOpen(false);
                    }}
                  />
                  <span className="flex flex-col">
                    <span className="text-sm text-ink">{c.label}</span>
                    <span className="text-xs text-ink-muted">{c.description}</span>
                    <span className="text-xs text-ink-muted">
                      {c.cost ? `Cost: ${c.cost}` : "Cost: none."}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-ink-muted">
            Saved with the draft.
            {verifies
              ? " Whatever the level, every write is checked against the run's sources first."
              : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ── The mark on each step ──

const DUE_WORDS: Record<OwnerReviewDue, string> = {
  checkpoint: "Supervisor checks this step: its result feeds a write or reaches a person",
  all: "Supervisor checks this step: it checks every step",
  always: "Supervisor always checks this step",
};

/**
 * The steps the supervisor reviews after they succeed, with the words their mark says on hover:
 * every watched step under `all`, the checkpoints under `checkpoints`, and a step set to always.
 */
export function supervisorMarks(
  workflow: Pick<Workflow, "steps">,
  review: OversightReview,
  uses: UsesContext,
): Map<string, string> {
  const due = processes.supervisedSteps(workflow, review, { kindOf: kindOfFrom(uses) });
  return new Map([...due].map(([id, why]) => [id, DUE_WORDS[why]]));
}

function kindOfFrom(uses: UsesContext) {
  return (action: string) => uses.actions.get(action)?.kind;
}

/** The mark: a small icon in ink, its words on hover and for a screen reader. */
export function SupervisorMark({ words, testId }: { words: string; testId?: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center text-ink-muted"
      title={words}
      role="img"
      aria-label={words}
      data-testid={testId}
    >
      <Icon name="search" size={14} />
    </span>
  );
}

// ── The step's own setting ──

const STEP_CHOICES: readonly { value: StepReview; label: string }[] = [
  { value: "auto", label: "Follow the agent" },
  { value: "always", label: "Always check this step" },
  { value: "off", label: "Never check this step" },
];

/** A Do step's or a Loop's `review`, for the step panel; null on a step the supervisor doesn't watch. */
export function SupervisorField({
  step,
  uses,
  review,
  onChange,
}: {
  step: Step;
  uses: UsesContext;
  /** The agent's level, to say what "Follow the agent" means. */
  review: OversightReview;
  onChange(next: Step): void;
}) {
  const id = useId();
  if (!processes.stepModelWatched(step, { kindOf: kindOfFrom(uses) })) return null;
  const value = step.review ?? "auto";
  const level = OWNER_REVIEW_CHOICES.find((c) => c.value === review)?.label ?? review;
  return (
    <div className="flex flex-col gap-1 border-t border-line pt-3 text-sm text-ink">
      <label htmlFor={id}>Supervisor</label>
      <SmallSelect
        id={id}
        data-testid="step-supervisor"
        value={value}
        onChange={(e) => {
          const { review: _r, ...rest } = step;
          const next = e.target.value as StepReview;
          // "Follow the agent" is the stored default: left out, as a new step has it.
          onChange((next === "auto" ? rest : { ...rest, review: next }) as Step);
        }}
      >
        {STEP_CHOICES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </SmallSelect>
      <span className="text-xs text-ink-muted">
        {value === "off"
          ? "The supervisor doesn't look at this step, even when it fails."
          : value === "always"
            ? "The supervisor reviews this step's result every time, before the run goes on."
            : `The agent's setting: ${level}.`}
      </span>
    </div>
  );
}

// ── What it checked and decided, in a try ──

/** What the supervisor verified and decided on one step of a try: the run page's, for its rows. */
export function trySupervision(run: TryRun, stepId: string): StepSupervision | null {
  const rows = run.steps.filter((r) => parseNodeId(r.nodeId).stepId === stepId);
  return stepSupervision(
    run,
    rows.map((r) => r.id),
  );
}

/** The run page's two lines (Verified, Decided), under a step of Try it's results. */
export function TrySupervisorLines({
  supervision,
  run,
  testId,
}: {
  supervision: StepSupervision;
  run: TryRun;
  testId: string;
}) {
  return (
    <div className="px-3 pb-2">
      <SupervisionLines supervision={supervision} run={run} testId={testId} />
    </div>
  );
}
