// Reading a bundle's steps (docs/step-model-plan.md §13a): shared by the readers that only need each
// step (the tools, skills and automations a bundle uses, the values promotion strips).

import type { AgentBundle, BundleWorkflow } from "../schemas/agent";
import type { Step, Workflow } from "../steps/schema";
import { eachStep, findStep } from "../steps/walk";

/**
 * Visits every step of a bundle's workflows, depth first in run order, with the workflow entry that
 * holds it. `enabledOnly` skips disabled workflows.
 */
export function eachBundleStep(
  bundle: Pick<AgentBundle, "workflows">,
  visit: (step: Step, workflow: BundleWorkflow) => void,
  options: { enabledOnly?: boolean } = {},
): void {
  for (const w of bundle.workflows) {
    if (options.enabledOnly && !w.enabled) continue;
    eachStep(w.workflow.steps, ({ step }) => visit(step, w));
  }
}

/**
 * The step a `step_run`'s node id names: the id, or the last part of `${loop}:${index}:${childId}`
 * inside a loop.
 */
export function findNodeStep(workflow: Pick<Workflow, "steps">, nodeId: string): Step | undefined {
  return findAnyStep(workflow, nodeId) ?? findAnyStep(workflow, nodeId.split(":").at(-1) ?? nodeId);
}

/** A step of a bundle's workflow. */
export type AnyStep = Step;

/** A step of a workflow by id, nested ones included. */
export function findAnyStep(workflow: Pick<Workflow, "steps">, id: string): Step | undefined {
  return findStep(workflow.steps, id);
}
