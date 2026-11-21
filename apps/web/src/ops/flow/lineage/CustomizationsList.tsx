// A client agent's steps against its template (docs/builder-plan.md §12.1): the ones it changed
// or added, each opening that step on the chart, a changed one with what differs in plain words
// and "Put back the template's step", an added one with Remove. Both are ordinary edits of the
// client's draft: the host applies them and saves them as the client agent's own new version
// (invariant 11). Ids are kept (invariant 3). StepDiff is the same lines for the step's side panel.
import { processes } from "@countersign/core";
import { useMemo } from "react";
import { Badge, Button } from "../../../ui/primitives";
import {
  customizedSteps,
  findTemplateStep,
  type Process,
  removeStep,
  type Step,
} from "../../builder/model";
import { defaultLabel } from "../Chart";
import { plural } from "../status";
import { putBackStep, stepDiff } from "./stepDiff";

type Labeller = (step: Step) => { title: string; kind: string; detail: string | null };

/** "2 steps changed, 1 added"; "1 step added"; "" when nothing differs. */
export function customizedLine(customized: ReadonlyMap<string, "changed" | "added">): string {
  let changed = 0;
  let added = 0;
  for (const mark of customized.values()) {
    if (mark === "changed") changed += 1;
    else added += 1;
  }
  if (changed === 0 && added === 0) return "";
  if (changed === 0) return `${plural(added, "step")} added`;
  return `${plural(changed, "step")} changed${added > 0 ? `, ${added} added` : ""}`;
}

export interface CustomizationsListProps {
  /** The client agent's draft process. */
  process: Process;
  /** The same workflow in the template version the agent is based on. */
  template: Process | undefined;
  /** Open the step on the chart. */
  onSelect(stepId: string): void;
  /** An edit of the draft (a step put back, or an added one removed). Absent: read only. */
  onChange?: ((next: Process) => void) | undefined;
  /** The chart's `label`, so names read the same. */
  label?: Labeller | undefined;
  /** The step open now, marked in the list. */
  selected?: string | null | undefined;
}

export function CustomizationsList(props: CustomizationsListProps) {
  const { process, template } = props;
  const label = props.label ?? defaultLabel;
  const customized = useMemo(() => customizedSteps(process, template), [process, template]);
  const rows = useMemo(
    () => processes.allSteps(process).filter((l) => customized.has(l.step.id)),
    [process, customized],
  );

  if (!template) {
    return (
      <p className="text-sm text-ink-muted" data-testid="flow-customizations-none">
        This workflow is not in the template: all of it is this client's own.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-testid="flow-customizations-none">
        Nothing changed: the steps are the template's.
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-line" data-testid="flow-customizations">
      {rows.map(({ step }) => {
        const mark = customized.get(step.id);
        const words = label(step);
        const was = findTemplateStep(template, step.id);
        const lines = mark === "changed" ? stepDiff(step, was) : [];
        const back =
          mark === "changed" && props.onChange ? putBackStep(process, template, step.id) : null;
        return (
          <li
            key={step.id}
            className="flow-custom-row"
            data-testid={`flow-customization-${step.id}`}
            data-selected={props.selected === step.id || undefined}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="flow-custom-row__name"
                  data-testid={`flow-customization-${step.id}-open`}
                  onClick={() => props.onSelect(step.id)}
                >
                  {words.title}
                </button>
                <Badge tone="neutral">{mark === "added" ? "Added" : "Customized"}</Badge>
                <span className="text-sm text-ink-muted">{words.kind}</span>
              </span>
              {mark === "added" ? (
                <span className="text-sm text-ink-muted">Not in the template.</span>
              ) : (
                <DiffLines stepId={step.id} lines={lines} />
              )}
            </div>
            {props.onChange ? (
              mark === "added" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`flow-customization-${step.id}-remove`}
                  onClick={() => props.onChange?.(removeStep(process, step.id))}
                >
                  Remove
                </Button>
              ) : back ? (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid={`flow-customization-${step.id}-put-back`}
                  onClick={() => props.onChange?.(back)}
                >
                  Put back the template's step
                </Button>
              ) : null
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DiffLines({
  stepId,
  lines,
}: {
  stepId: string;
  lines: { field: string; text: string }[];
}) {
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col text-sm text-ink-muted" data-testid={`flow-diff-${stepId}`}>
      {lines.map((line) => (
        <li key={line.field}>{line.text}</li>
      ))}
    </ul>
  );
}

export interface StepDiffProps {
  /** The client agent's step, as the draft has it. */
  step: Step;
  /** The client agent's draft process and the template's, for "Put back the template's step". */
  process: Process;
  template: Process | undefined;
  /** An edit of the draft. Absent: the lines only. */
  onChange?: ((next: Process) => void) | undefined;
}

/**
 * For the step's side panel on a client's agent: how this step differs from the template's, and
 * the way back. Nothing when the step is the template's as it is, or the agent has no template.
 */
export function StepDiff({ step, process, template, onChange }: StepDiffProps) {
  if (!template) return null;
  const was = findTemplateStep(template, step.id);
  if (!was) {
    return (
      <section className="flow-step-diff" data-testid="flow-step-diff">
        <span className="eyebrow text-ink-muted">Against the template</span>
        <p className="text-sm text-ink">Added for this client. It is not in the template.</p>
      </section>
    );
  }
  const lines = stepDiff(step, was);
  if (lines.length === 0) return null;
  const back = onChange ? putBackStep(process, template, step.id) : null;
  return (
    <section className="flow-step-diff" data-testid="flow-step-diff">
      <span className="eyebrow text-ink-muted">Changed from the template</span>
      <ul className="flex flex-col gap-0.5 text-sm text-ink">
        {lines.map((line) => (
          <li key={line.field}>{line.text}</li>
        ))}
      </ul>
      {back ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            data-testid="flow-step-diff-put-back"
            onClick={() => onChange?.(back)}
          >
            Put back the template's step
          </Button>
        </div>
      ) : null}
    </section>
  );
}
