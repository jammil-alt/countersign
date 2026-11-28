// An End's form (docs/step-model-plan.md §9): where a path finishes and what it delivers. It picks
// one or more of the workflow's declared outputs, or "Nothing to do" with a reason, never both. An
// End can be filled, not removed: the host offers no Remove here.

import { useState } from "react";
import { Badge } from "../../../ui/primitives";
import { SmallInput, SmallSelect } from "../fields";
import { personName } from "../people";
import type { StepFormProps } from "./form-kit";
import { actionPath, type UsesContext } from "./options";
import { SuggestButton } from "./SuggestButton";
import type { EndStep, WorkflowOutput } from "./types";

export const OUTPUT_KIND_WORDS: Record<WorkflowOutput["kind"], string> = {
  report: "Report",
  write: "Write to a tool",
  save: "Save to our records",
  handoff: "Hand off",
  pass_on: "Pass on",
  nothing: "Nothing to do",
};

/** Where an output goes, in words: "Report to Client admin by inbox", "QuickBooks › Create bill". */
export function whereItGoes(
  o: WorkflowOutput,
  uses: UsesContext,
  people: StepFormProps["env"]["people"],
): string {
  switch (o.kind) {
    case "report": {
      const to = (o.report?.to ?? []).map((w) => personName(people, w) ?? w).join(", ");
      return `Report to ${to || "nobody yet"} by ${o.report?.channel ?? "inbox"}`;
    }
    case "write":
    case "save": {
      const a = o.action ? uses.actions.get(o.action.action) : undefined;
      const name = a ? actionPath(a) : (o.action?.action ?? "no action yet");
      return o.kind === "write" ? `${name}, needs approval` : name;
    }
    case "handoff":
      return `Hand off to ${o.handoff?.agent === "@self" ? "this agent" : (o.handoff?.agent ?? "no one yet")}`;
    case "pass_on":
      return "Passed on to other agents' hand-off triggers";
    case "nothing":
      return "Nothing leaves";
  }
}

export function EndCard({ step, env, issues, onChange }: StepFormProps<EndStep>) {
  const outputs = env.workflow.outputs;
  const nothing = step.nothingToDo !== undefined;
  const [more, setMore] = useState(false);
  const pick = (id: string, on: boolean) => {
    const next = on ? [...step.outputs, id] : step.outputs.filter((x) => x !== id);
    const { nothingToDo: _drop, ...rest } = step;
    onChange({ ...rest, outputs: next });
  };
  const setNothing = (on: boolean) => {
    const { nothingToDo: _drop, ...rest } = step;
    onChange(on ? { ...rest, outputs: [], nothingToDo: "" } : { ...rest, outputs: [] });
  };
  return (
    <section className="flex flex-col gap-4" data-testid="end-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow text-ink-muted">End</h3>
        <SuggestButton
          step={step}
          label="this End"
          suggest={env.suggest}
          onApply={(s) => onChange(s as EndStep)}
        />
      </div>
      <p className="text-xs text-ink-muted">
        Where this path finishes. An End can be filled in, but not removed: every path ends on one.
      </p>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-ink">Name</span>
        <SmallInput
          aria-label="End name"
          value={step.name}
          onChange={(e) => onChange({ ...step, name: e.target.value })}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="flex w-full items-center justify-between text-sm text-ink">
          <span>What it delivers</span>
          <SuggestButton
            step={step}
            field="outputs"
            label="what this End delivers"
            suggest={env.suggest}
            onApply={(s) => onChange(s as EndStep)}
          />
        </legend>
        {outputs.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No outputs are declared yet. Declare them next to the triggers.
          </p>
        ) : null}
        {outputs.map((o) => {
          const on = step.outputs.includes(o.id);
          return (
            <div key={o.id} className="flex flex-col gap-0.5 border border-line px-3 py-2">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => pick(o.id, e.target.checked)}
                  aria-label={o.name}
                />
                <span>{o.name}</span>
                <Badge>{OUTPUT_KIND_WORDS[o.kind]}</Badge>
              </label>
              {on ? (
                <p className="pl-6 text-xs text-ink-muted">
                  {whereItGoes(o, env.uses, env.people)}
                </p>
              ) : null}
            </div>
          );
        })}
        <label className="flex items-center gap-2 border border-line px-3 py-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={nothing}
            onChange={(e) => setNothing(e.target.checked)}
            aria-label="Nothing to do"
          />
          Nothing to do
        </label>
        {nothing ? (
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-ink">Why there is nothing to do</span>
            <SmallInput
              aria-label="Why there is nothing to do"
              value={step.nothingToDo ?? ""}
              placeholder="The bill was already entered"
              onChange={(e) => onChange({ ...step, outputs: [], nothingToDo: e.target.value })}
            />
          </div>
        ) : null}
      </fieldset>
      <div>
        <button
          type="button"
          className="ds-btn ds-btn--link text-sm"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          More
        </button>
        {more ? (
          <div className="mt-2 flex flex-col gap-1 text-sm">
            <span className="text-ink">A path that ends in failure on purpose</span>
            <SmallSelect
              aria-label="How this path ends"
              value={step.status}
              onChange={(e) => onChange({ ...step, status: e.target.value as EndStep["status"] })}
            >
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed, on purpose</option>
              <option value="cancelled">Cancelled</option>
            </SmallSelect>
          </div>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="end-issues">
          {issues.map((i) => (
            <li key={`${i.code}-${i.message}`} className="text-sm text-risk-ink">
              Needs fixing: {i.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
