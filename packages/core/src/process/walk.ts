// R1 (docs/plan.md §1.86, §9): walking a v4 process's steps, the counterpart of
// `workflow/walk.ts` for v3. Validation, template typing and the builder share it.

import type { ForEachStep, IfStep, Process, Step, SubProcessStep } from "./schema";

/** Where a step sits in a process's tree, and what runs before it on its own path. */
export interface StepLocation {
  step: Step;
  /** Segments from the process root, e.g. ["steps", 2, "paths", 0, "steps", 1]. */
  pointer: (string | number)[];
  /** Ids of steps that run before this one on its path (enclosing `if` and `for_each` excluded). */
  before: string[];
  /** Enclosing for_each steps, outermost first. */
  loops: ForEachStep[];
  /** Enclosing ifs, with the path (or otherwise) id the step is on, outermost first. */
  ifs: { step: IfStep; branchId: string }[];
  /** How many `if` and `for_each` steps enclose this one (0 at the top level). */
  depth: number;
}

type Walkable = Pick<Process, "steps">;

/** Visits every step depth-first, in run order. */
export function walkSteps(process: Walkable, visit: (loc: StepLocation) => void): void {
  const walkList = (
    steps: readonly Step[],
    pointer: (string | number)[],
    outerBefore: readonly string[],
    loops: ForEachStep[],
    ifs: { step: IfStep; branchId: string }[],
    depth: number,
  ) => {
    const before = [...outerBefore];
    steps.forEach((step, i) => {
      const here = [...pointer, i];
      visit({ step, pointer: here, before: [...before], loops, ifs, depth });
      if (step.kind === "if") {
        step.paths.forEach((p, pi) => {
          walkList(
            p.steps,
            [...here, "paths", pi, "steps"],
            before,
            loops,
            [...ifs, { step, branchId: p.id }],
            depth + 1,
          );
        });
        walkList(
          step.otherwise.steps,
          [...here, "otherwise", "steps"],
          before,
          loops,
          [...ifs, { step, branchId: step.otherwise.id }],
          depth + 1,
        );
      } else if (step.kind === "for_each") {
        walkList(step.steps, [...here, "steps"], before, [...loops, step], ifs, depth + 1);
      }
      // An if or a for_each is visible after it (its own output), never the steps inside it.
      before.push(step.id);
    });
  };
  walkList(process.steps, ["steps"], [], [], [], 0);
}

/** Every step with its location, in run order. */
export function allSteps(process: Walkable): StepLocation[] {
  const out: StepLocation[] = [];
  walkSteps(process, (l) => out.push(l));
  return out;
}

export function findStep(process: Walkable, id: string): StepLocation | undefined {
  return allSteps(process).find((l) => l.step.id === id);
}

/**
 * The steps whose outputs a step can read: those that run before it on its own path, outermost
 * first. A step inside an if path or a for_each sees what ran before its container too; nothing
 * inside an earlier path or loop is visible after it. Undefined when the step isn't in the process.
 */
export function visibleBefore(process: Walkable, id: string): Step[] | undefined {
  const all = allSteps(process);
  const loc = all.find((l) => l.step.id === id);
  if (!loc) return undefined;
  const byId = new Map(all.map((l) => [l.step.id, l.step]));
  return loc.before.map((b) => byId.get(b)).filter((s): s is Step => s !== undefined);
}

/** Every id a merge lines up by: the triggers, steps, if paths and otherwise branches. */
export function nodeIds(process: Pick<Process, "triggers" | "steps">): string[] {
  const ids = process.triggers.map((t) => t.id);
  walkSteps(process, ({ step }) => {
    ids.push(step.id);
    if (step.kind === "if") {
      for (const p of step.paths) ids.push(p.id);
      ids.push(step.otherwise.id);
    }
  });
  return ids;
}

/** How many steps the process has, nested ones included. */
export function stepCount(process: Walkable): number {
  let n = 0;
  walkSteps(process, () => {
    n += 1;
  });
  return n;
}

/** The deepest nesting of logic: 0 with no if or for_each, 1 with one not inside another, … */
export function logicDepth(process: Walkable): number {
  let max = 0;
  walkSteps(process, ({ step, depth }) => {
    if (step.kind === "if" || step.kind === "for_each") max = Math.max(max, depth + 1);
  });
  return max;
}

/** Every sub-process step of the processes, nested ones included, in run order. */
export function subProcessSteps(processes: readonly Walkable[]): SubProcessStep[] {
  const out: SubProcessStep[] = [];
  for (const p of processes) {
    walkSteps(p, ({ step }) => {
      if (step.kind === "process") out.push(step);
    });
  }
  return out;
}

/** The pinned process references (`slug@version`) the processes use, each once. */
export function subProcessRefs(processes: readonly Walkable[]): string[] {
  return [...new Set(subProcessSteps(processes).map((s) => s.process))];
}
