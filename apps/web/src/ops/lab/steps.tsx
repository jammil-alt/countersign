// A workflow as the lab and the agent page read it (docs/design/prototype.html `#O2-Lab`,
// "Workflow"): the trigger, then each top-level step with its kind. Person steps in copper;
// a step that changes the client's tools and needs approval says so in signal, with words. Skill
// and tool ids never show: a step reads by its name, an action by its tool in words.
import type { Workflow } from "@countersign/core";
import type { ReactNode } from "react";
import { Tag } from "../../ui/primitives";
import type { StepItem } from "../../ui/steps";
import { toolTitle } from "../builder/model";
import { KIND_LABEL, stepDetail, triggerDetail, triggerTitle } from "../workflow/describe";

function title(name: ReactNode, kind: string): ReactNode {
  return (
    <span className="flex items-start justify-between gap-3">
      <span className="min-w-0">{name}</span>
      <Tag tone={kind === "person" ? "person" : "neutral"}>{KIND_LABEL[kind as "trigger"]}</Tag>
    </span>
  );
}

export function workflowStepItems(workflow: Workflow): StepItem[] {
  const items: StepItem[] = [
    {
      key: "trigger",
      title: title(triggerTitle(workflow.trigger), "trigger"),
      detail: triggerDetail(workflow.trigger) ?? undefined,
      state: "todo",
    },
  ];
  for (const step of workflow.steps) {
    const approves = step.kind === "action" && step.approval.required === "required";
    items.push({
      key: step.id,
      title: title(step.name, step.kind),
      detail: approves ? (
        <span className="text-signal-ink">Needs approval · {toolTitle({ id: step.tool })}</span>
      ) : step.kind === "action" ? (
        `${toolTitle({ id: step.tool })} · on its own`
      ) : step.kind === "skill" ? undefined : (
        (stepDetail(step) ?? undefined)
      ),
      state: step.kind === "person" ? "person" : "todo",
    });
  }
  return items;
}
