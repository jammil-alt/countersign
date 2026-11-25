// Visiting a v5 workflow's steps (the step model, docs/step-model-plan.md §13a), depth first in run
// order: a Fork's paths then its otherwise, For each and Repeat bodies. Shared by the executor and
// the bundle's readers (the tools, skills and ids a bundle uses), so they walk it the same way.
// Pure.

import type { Step, Workflow } from "./schema";

export interface StepVisit {
  step: Step;
  /** The container steps it is inside, outermost first. */
  parents: readonly Step[];
}

export function eachStep(
  steps: readonly Step[],
  visit: (v: StepVisit) => void,
  parents: readonly Step[] = [],
): void {
  for (const step of steps) {
    visit({ step, parents });
    const inside = [...parents, step];
    if (step.kind === "fork") {
      for (const p of step.paths) eachStep(p.steps, visit, inside);
      eachStep(step.otherwise.steps, visit, inside);
    } else if (step.kind === "for_each" || step.kind === "repeat") {
      eachStep(step.steps, visit, inside);
    }
  }
}

/** Every step, Fork path and otherwise id in a workflow, with its triggers' and outputs'. */
export function stepModelIds(workflow: Pick<Workflow, "triggers" | "outputs" | "steps">): string[] {
  const ids = [...workflow.triggers.map((t) => t.id), ...workflow.outputs.map((o) => o.id)];
  eachStep(workflow.steps, ({ step }) => {
    ids.push(step.id);
    if (step.kind === "fork") {
      for (const p of step.paths) ids.push(p.id);
      ids.push(step.otherwise.id);
    }
  });
  return ids;
}

/** The step with this id, anywhere in the list. */
export function findStep(steps: readonly Step[], id: string): Step | undefined {
  let found: Step | undefined;
  eachStep(steps, ({ step }) => {
    if (!found && step.id === id) found = step;
  });
  return found;
}

/**
 * The actions a workflow's steps and outputs name (a Do's `uses.action`, a Loop's reads, a write or
 * save output's action), as stored: a merged action stays merged (`email.send`).
 */
export function stepModelActions(workflow: Pick<Workflow, "outputs" | "steps">): Set<string> {
  const out = new Set<string>();
  eachStep(workflow.steps, ({ step }) => {
    if (step.kind === "do" && step.uses?.type === "action") out.add(step.uses.action);
    if (step.kind === "loop") for (const a of step.reads) out.add(a);
  });
  for (const o of workflow.outputs) if (o.action) out.add(o.action.action);
  return out;
}

/** The skills a workflow's steps use (a Do's skill, a saved Loop), as stored refs. */
export function stepModelSkills(workflow: Pick<Workflow, "steps">): string[] {
  const out: string[] = [];
  eachStep(workflow.steps, ({ step }) => {
    if (step.kind === "do" && step.uses?.type === "skill") out.push(step.uses.skill);
    if (step.kind === "loop" && step.skill) out.push(step.skill);
  });
  return out;
}

/** A step and where it sits: its pointer from the workflow root, e.g. ["steps", 2, "paths", 0, "steps", 1]. */
export interface StepAt {
  step: Step;
  pointer: (string | number)[];
}

/** Every step of a workflow with its pointer, depth first in run order. */
export function stepsWithPointers(workflow: Pick<Workflow, "steps">): StepAt[] {
  const out: StepAt[] = [];
  const walk = (list: readonly Step[], pointer: (string | number)[]) => {
    list.forEach((step, i) => {
      const here = [...pointer, i];
      out.push({ step, pointer: here });
      if (step.kind === "fork") {
        step.paths.forEach((p, pi) => walk(p.steps, [...here, "paths", pi, "steps"]));
        walk(step.otherwise.steps, [...here, "otherwise", "steps"]);
      } else if (step.kind === "for_each" || step.kind === "repeat") {
        walk(step.steps, [...here, "steps"]);
      }
    });
  };
  walk(workflow.steps, ["steps"]);
  return out;
}
