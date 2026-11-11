// A workflow as the lab and the agent page read it (docs/design/prototype.html `#O2-Lab`,
// "Workflow"): the trigger, then each top-level step with its kind. Person steps in copper;
// a step that changes the client's tools and needs approval says so in signal, with words. Skill
// and tool ids never show: a step reads by its name, an action by its tool in words.
// R8: a v4 process too (the templates' v4 versions): its first trigger and its steps in the
// builder's words; a write with no approval check needs the default approver (invariant 8).
import { processes, type Workflow } from "@countersign/core";
import type { ReactNode } from "react";
import { Tag } from "../../ui/primitives";
import type { StepItem } from "../../ui/steps";
import { toolTitle } from "../builder/model";

/** Skill model: an action write step's name ("Create bill"); its tool is resolved when it runs. */
function actionLabel(action: processes.WriteAction | undefined): string {
  return action ? processes.ACTION_SPECS[action].label : "A change";
}

import {
  KIND_LABEL,
  PROCESS_KIND_LABEL,
  processStepDetail,
  stepDetail,
  triggerDetail,
  triggerTitle,
} from "../workflow/describe";

function title(name: ReactNode, kind: string, label: string): ReactNode {
  return (
    <span className="flex items-start justify-between gap-3">
      <span className="min-w-0">{name}</span>
      <Tag tone={kind === "person" ? "person" : "neutral"}>{label}</Tag>
    </span>
  );
}

function needsApproval(tool: string): ReactNode {
  return <span className="text-signal-ink">Needs approval · {toolTitle({ id: tool })}</span>;
}

export function workflowStepItems(workflow: Workflow | processes.Process): StepItem[] {
  const first = workflow.schemaVersion === 4 ? workflow.triggers[0] : workflow.trigger;
  const items: StepItem[] = first
    ? [
        {
          key: "trigger",
          title: title(triggerTitle(first), "trigger", KIND_LABEL.trigger),
          detail: triggerDetail(first) ?? undefined,
          state: "todo",
        },
      ]
    : [];
  if (workflow.schemaVersion === 4) {
    for (const step of workflow.steps) {
      const approves = step.kind === "write" && step.checks?.approval?.required !== "not_required";
      items.push({
        key: step.id,
        title: title(step.name, step.kind, PROCESS_KIND_LABEL[step.kind]),
        detail:
          step.kind === "write"
            ? approves
              ? needsApproval(step.tool ?? actionLabel(step.action))
              : `${step.tool ? toolTitle({ id: step.tool }) : actionLabel(step.action)} · on its own`
            : step.kind === "skill"
              ? undefined
              : (processStepDetail(step) ?? undefined),
        state: step.kind === "person" ? "person" : "todo",
      });
    }
    return items;
  }
  for (const step of workflow.steps) {
    const approves = step.kind === "action" && step.approval.required === "required";
    items.push({
      key: step.id,
      title: title(step.name, step.kind, KIND_LABEL[step.kind]),
      detail: approves
        ? needsApproval(step.tool)
        : step.kind === "action"
          ? `${toolTitle({ id: step.tool })} · on its own`
          : step.kind === "skill"
            ? undefined
            : (stepDetail(step) ?? undefined),
      state: step.kind === "person" ? "person" : "todo",
    });
  }
  return items;
}
