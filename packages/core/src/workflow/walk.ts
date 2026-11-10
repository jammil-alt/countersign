import type { ForEachStep, ForkStep, Step, UseAutomationStep, Workflow } from "../schemas/workflow";

/** Where a step sits in a workflow's tree, and what runs before it on its own path. */
export interface StepLocation {
  step: Step;
  /** Segments from the workflow root, e.g. ["steps", 2, "paths", 0, "steps", 1]. */
  pointer: (string | number)[];
  /** Ids of steps that run before this one on its path (enclosing containers excluded). */
  before: string[];
  /** Enclosing for_each steps, outermost first. */
  loops: ForEachStep[];
  /** Enclosing forks (with the path or otherwise id), outermost first. */
  forks: { fork: ForkStep; branchId: string }[];
}

/** Visits every step depth-first, in run order. */
export function walkSteps(workflow: Pick<Workflow, "steps">, visit: (loc: StepLocation) => void) {
  const walkList = (
    steps: Step[],
    pointer: (string | number)[],
    outerBefore: string[],
    loops: ForEachStep[],
    forks: { fork: ForkStep; branchId: string }[],
  ) => {
    const before = [...outerBefore];
    steps.forEach((step, i) => {
      const here = [...pointer, i];
      visit({ step, pointer: here, before: [...before], loops, forks });
      // R9: a v4 `if` (the same shape as a fork) in a bundle typed v3, a template's v4 version or
      // its fork, is walked into too, so no reader of such a bundle misses its nested steps.
      if (step.kind === "fork" || (step as { kind: string }).kind === "if") {
        const fork = step as ForkStep;
        fork.paths.forEach((p, pi) => {
          walkList(p.steps, [...here, "paths", pi, "steps"], before, loops, [
            ...forks,
            { fork, branchId: p.id },
          ]);
        });
        walkList(fork.otherwise.steps, [...here, "otherwise", "steps"], before, loops, [
          ...forks,
          { fork, branchId: fork.otherwise.id },
        ]);
      } else if (step.kind === "for_each") {
        walkList(step.steps, [...here, "steps"], before, [...loops, step], forks);
      }
      before.push(step.id);
    });
  };
  walkList(workflow.steps, ["steps"], [], [], []);
}

export function allSteps(workflow: Pick<Workflow, "steps">): StepLocation[] {
  const out: StepLocation[] = [];
  walkSteps(workflow, (l) => out.push(l));
  return out;
}

export function findStep(workflow: Pick<Workflow, "steps">, id: string): StepLocation | undefined {
  return allSteps(workflow).find((l) => l.step.id === id);
}

/** Every id a merge lines up by: the trigger, steps, fork paths and otherwise branches. */
export function nodeIds(workflow: Workflow): string[] {
  // v0.12 W2-E: every trigger's id, so merges line `moreTriggers` up too.
  const ids = [workflow.trigger.id, ...(workflow.moreTriggers ?? []).map((t) => t.id)];
  walkSteps(workflow, ({ step }) => {
    ids.push(step.id);
    if (step.kind === "fork") {
      for (const p of step.paths) ids.push(p.id);
      ids.push(step.otherwise.id);
    }
  });
  return ids;
}

// v0.12 W2-B: the automations a workflow uses (ARCHITECTURE §10.7).
/** Every use step of the workflows, nested ones included, in run order. */
export function useSteps(workflows: readonly Pick<Workflow, "steps">[]): UseAutomationStep[] {
  const out: UseAutomationStep[] = [];
  for (const w of workflows) {
    walkSteps(w, ({ step }) => {
      if (step.kind === "use_automation") out.push(step);
    });
  }
  return out;
}

/** The pinned automation references (`slug@version`) the workflows use, each once. */
export function automationRefs(workflows: readonly Pick<Workflow, "steps">[]): string[] {
  return [...new Set(useSteps(workflows).map((s) => s.automation))];
}
