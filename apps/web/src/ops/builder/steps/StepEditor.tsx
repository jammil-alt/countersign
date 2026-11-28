// A step's setup in the side panel: its form by kind, and the Data tab next to it on every step
// (docs/step-model-plan.md §5, "The Data tab"). The host owns the workflow; this edits one step.

import { type ReactNode, useState } from "react";
import { DataTab, type LastRun } from "./DataTab";
import { DoForm } from "./DoForm";
import { EndCard } from "./EndCard";
import type { StepFormEnv, StepFormProps } from "./form-kit";
import { ForEachForm, ForkForm, HandoffForm, LoopForm, RepeatForm, WaitForm } from "./OtherForms";
import type { Step } from "./types";

export interface StepEditorProps extends StepFormProps<Step> {
  /** The step's last test run, and the runs of the steps before it, when there are any. */
  runs?: Readonly<Record<string, LastRun>> | undefined;
  /** Under the step's form on its Settings tab (the step builder's Supervisor field). */
  settingsFooter?: ReactNode;
}

type Tab = "settings" | "data";

/** The form for a step's kind. */
export function StepForm(props: StepFormProps<Step>) {
  const { step } = props;
  switch (step.kind) {
    case "do":
      return <DoForm {...props} step={step} onChange={props.onChange} />;
    case "loop":
      return <LoopForm {...props} step={step} onChange={props.onChange} />;
    case "fork":
      return <ForkForm {...props} step={step} onChange={props.onChange} />;
    case "for_each":
      return <ForEachForm {...props} step={step} onChange={props.onChange} />;
    case "repeat":
      return <RepeatForm {...props} step={step} onChange={props.onChange} />;
    case "wait":
      return <WaitForm {...props} step={step} onChange={props.onChange} />;
    case "handoff":
      return <HandoffForm {...props} step={step} onChange={props.onChange} />;
    case "end":
      return <EndCard {...props} step={step} onChange={props.onChange} />;
  }
}

export function StepEditor(props: StepEditorProps) {
  const [tab, setTab] = useState<Tab>("settings");
  const { step, env } = props;
  return (
    <div className="flex flex-col gap-4" data-testid="step-editor">
      <fieldset className="ds-seg" aria-label="Step tabs">
        {(["settings", "data"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            data-testid={`step-tab-${t}`}
            onClick={() => setTab(t)}
          >
            {t === "settings" ? "Settings" : "Data"}
          </button>
        ))}
      </fieldset>
      {tab === "settings" ? (
        <>
          <StepForm {...props} />
          {props.settingsFooter}
        </>
      ) : (
        <DataTab
          step={step}
          env={env as StepFormEnv}
          lastRun={props.runs?.[step.id]}
          runs={props.runs}
        />
      )}
    </div>
  );
}
