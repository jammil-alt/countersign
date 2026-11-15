// The agent page's Steps tab (docs/plan.md §1.108): the workflow's steps as a list, each with its
// number as the canvas gives it (3, 3 A1, 5.1), its kind, and its status from the same checks the
// canvas shows: missing, invalid, needs a connection or a pack, or ready. A click selects the step,
// and the builder's side panel opens on it, as a click on the canvas does.
import { processes } from "@countersign/core";
import { useState } from "react";
import { Badge, cx, type Tone } from "../../ui/primitives";
import { processKindLabel, type StepLabels } from "../workflow/describe";
import { pathLetter } from "./Canvas";
import type { BuilderProblem } from "./catalog";
import type { LeftItem } from "./data-use";

type Process = processes.Process;

export interface StepRow {
  id: string;
  number: string;
  name: string;
  kind: string;
  status: string;
  tone: Tone;
  /** What's wrong, in words, when it isn't ready. */
  detail: string | null;
  depth: number;
}

/**
 * Each step's number as the canvas shows it: the top level counts 1, 2, 3; a fork's paths by their
 * letter (3 A1, 3 B1; otherwise after the last path); a loop's steps under it (5.1).
 */
export function stepNumbers(workflow: Process): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (steps: readonly processes.Step[], prefix: string, sep: string) => {
    steps.forEach((step, i) => {
      const n = `${prefix}${prefix ? sep : ""}${i + 1}`;
      out.set(step.id, n);
      if (step.kind === "if") {
        step.paths.forEach((p, k) => {
          walk(p.steps, `${n} ${pathLetter(k)}`, "");
        });
        if (step.otherwise) walk(step.otherwise.steps, `${n} ${pathLetter(step.paths.length)}`, "");
      } else if ("steps" in step && Array.isArray(step.steps)) {
        walk(step.steps as processes.Step[], n, ".");
      }
    });
  };
  walk(workflow.steps, "", "");
  return out;
}

/** The rows of the list: every step, in order, with its status. */
export function stepRows(input: {
  workflow: Process;
  errors: readonly BuilderProblem[];
  left: readonly LeftItem[];
  labels: StepLabels;
}): StepRow[] {
  const numbers = stepNumbers(input.workflow);
  const setup = new Map<string, string>();
  for (const item of input.left) {
    if ((item.kind === "connection" || item.kind === "pack") && !setup.has(item.stepId)) {
      setup.set(item.stepId, item.text);
    }
  }
  return processes.allSteps(input.workflow).map(({ step, depth }) => {
    const errors = input.errors.filter((e) => e.stepId === step.id);
    const base = {
      id: step.id,
      number: numbers.get(step.id) ?? "",
      name: step.name,
      kind: processKindLabel(step, input.labels),
      depth,
    };
    if (step.kind === "missing") {
      return { ...base, status: "Missing", tone: "warning" as const, detail: step.need };
    }
    if (errors.length > 0) {
      return {
        ...base,
        status: errors.length === 1 ? "Invalid" : `${errors.length} problems`,
        tone: "risk" as const,
        detail: errors[0]?.message ?? null,
      };
    }
    const need = setup.get(step.id);
    if (need) return { ...base, status: "Needs setup", tone: "warning" as const, detail: need };
    return { ...base, status: "Ready", tone: "positive" as const, detail: null };
  });
}

const FILTERS = [
  ["all", "All"],
  ["work", "Needs work"],
  ["ready", "Ready"],
] as const;

export function StepsList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: readonly StepRow[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const work = rows.filter((r) => r.tone !== "positive").length;
  const shown = rows.filter(
    (r) => filter === "all" || (filter === "work" ? r.tone !== "positive" : r.tone === "positive"),
  );
  const count = (k: string) =>
    k === "all" ? rows.length : k === "work" ? work : rows.length - work;
  return (
    <section className="flex flex-col gap-3" data-testid="builder-steps-list" aria-label="Steps">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="type-subheading text-ink">
          Steps <span className="text-ink-muted">· {rows.length}</span>
        </h2>
        <fieldset className="ds-seg" aria-label="Show">
          {FILTERS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              data-testid={`builder-steps-filter-${key}`}
              onClick={() => setFilter(key)}
            >
              {label} {count(key)}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="ds-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-subtle text-left text-xs text-ink-muted">
              <th className="px-4 py-2.5 font-medium">#</th>
              <th className="px-4 py-2.5 font-medium">Step</th>
              <th className="px-4 py-2.5 font-medium">Kind</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.id}
                data-testid={`builder-steps-row-${r.id}`}
                className={cx(
                  "border-b border-line last:border-b-0 align-top",
                  selectedId === r.id && "bg-slate-tint",
                )}
              >
                <td className="figures whitespace-nowrap px-4 py-3 text-ink-muted">{r.number}</td>
                <td className="px-4 py-3" style={{ paddingLeft: `${16 + r.depth * 16}px` }}>
                  <button
                    type="button"
                    className="text-left font-medium text-ink hover:text-slate hover:underline"
                    data-testid={`builder-steps-open-${r.id}`}
                    onClick={() => onSelect(r.id)}
                  >
                    {r.name}
                  </button>
                  {r.detail ? <p className="mt-0.5 text-xs text-ink-muted">{r.detail}</p> : null}
                </td>
                <td className="px-4 py-3 text-ink-muted">{r.kind}</td>
                <td className="px-4 py-3">
                  <Badge tone={r.tone}>{r.status}</Badge>
                </td>
              </tr>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-ink-muted">
                  {filter === "work" ? "Every step is ready." : "No steps here."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
