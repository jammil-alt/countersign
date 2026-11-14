// R1 (docs/plan.md §1.86, §9): walking a v4 process's steps, the counterpart of
// `workflow/walk.ts` for v3. Validation, template typing and the builder share it.

import type { ForEachStep, IfStep, Process, RepeatStep, Step, SubProcessStep } from "./schema";

/** Where a step sits in a process's tree, and what runs before it on its own path. */
export interface StepLocation {
  step: Step;
  /** Segments from the process root, e.g. ["steps", 2, "paths", 0, "steps", 1]. */
  pointer: (string | number)[];
  /** Ids of steps that run before this one on its path (enclosing `if` and `for_each` excluded). */
  before: string[];
  /** Enclosing for_each steps, outermost first. */
  loops: ForEachStep[];
  /** v0.17: enclosing repeat steps, outermost first. */
  repeats: RepeatStep[];
  /** Enclosing ifs, with the path (or otherwise) id the step is on, outermost first. */
  ifs: { step: IfStep; branchId: string }[];
  /** How many `if`, `for_each` and `repeat` steps enclose this one (0 at the top level). */
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
    repeats: RepeatStep[],
  ) => {
    const before = [...outerBefore];
    steps.forEach((step, i) => {
      const here = [...pointer, i];
      visit({ step, pointer: here, before: [...before], loops, repeats, ifs, depth });
      if (step.kind === "if") {
        step.paths.forEach((p, pi) => {
          walkList(
            p.steps,
            [...here, "paths", pi, "steps"],
            before,
            loops,
            [...ifs, { step, branchId: p.id }],
            depth + 1,
            repeats,
          );
        });
        walkList(
          step.otherwise.steps,
          [...here, "otherwise", "steps"],
          before,
          loops,
          [...ifs, { step, branchId: step.otherwise.id }],
          depth + 1,
          repeats,
        );
      } else if (step.kind === "for_each") {
        walkList(step.steps, [...here, "steps"], before, [...loops, step], ifs, depth + 1, repeats);
      } else if (step.kind === "repeat") {
        walkList(step.steps, [...here, "steps"], before, loops, ifs, depth + 1, [...repeats, step]);
      }
      // An if, for_each or repeat is visible after it (its own output), never the steps inside it.
      before.push(step.id);
    });
  };
  walkList(process.steps, ["steps"], [], [], [], 0, []);
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

/** Whether a step holds other steps: an `if`, a `for_each` or (v0.17) a `repeat`. */
export function isLogic(step: Step): step is IfStep | ForEachStep | RepeatStep {
  return step.kind === "if" || step.kind === "for_each" || step.kind === "repeat";
}

/** The deepest nesting of logic: 0 with no if, for_each or repeat, 1 with one not inside another, … */
export function logicDepth(process: Walkable): number {
  let max = 0;
  walkSteps(process, ({ step, depth }) => {
    if (isLogic(step)) max = Math.max(max, depth + 1);
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

/**
 * Skill model (2026-11-10): a step list with some steps replaced, for a template's next version
 * built from its last. `replace` answers the steps a step becomes (none: `[]`), or undefined to
 * keep it; a kept if or for_each has its own steps replaced too. Ids are the caller's to keep.
 */
export function replaceSteps(
  steps: readonly Step[],
  replace: (step: Step) => Step[] | undefined,
): Step[] {
  return steps.flatMap((step): Step[] => {
    const out = replace(step);
    if (out !== undefined) return out;
    if (step.kind === "if") {
      return [
        {
          ...step,
          paths: step.paths.map((p) => ({ ...p, steps: replaceSteps(p.steps, replace) })),
          otherwise: { ...step.otherwise, steps: replaceSteps(step.otherwise.steps, replace) },
        },
      ];
    }
    if (step.kind === "for_each" || step.kind === "repeat") {
      return [{ ...step, steps: replaceSteps(step.steps, replace) }];
    }
    return [step];
  });
}

/** Skill model (2026-11-10): the tools the processes' read and write steps call, each once. */
export function processTools(processes: readonly Walkable[]): string[] {
  const out = new Set<string>();
  for (const p of processes) {
    walkSteps(p, ({ step }) => {
      if ((step.kind === "read" || step.kind === "write") && step.tool !== undefined) {
        out.add(step.tool);
      }
    });
  }
  return [...out];
}
