// The step model's builder model (docs/step-model-plan.md §4, §9, §13a; stream B): pure functions
// over a v5 workflow (`steps.Workflow`), the same shape the v4 builder's `../model` has over a
// process. A step lives in a container: the main line (`root`), a fork's path (`path:<id>`) or its
// otherwise (`otherwise:<id>`), or a for-each's or repeat's block (`loop:<step id>`). New step and
// path ids are generated once and never regenerated, so merges can line them up (invariant 3).
//
// DECISION: a parallel tree to `../model`, not a rewrite of it: v3 and v4 are read until wave 4
// deletes them, so the v4 builder keeps working and nothing here depends on it.

import { steps, uuidv7 } from "@countersign/core";

export type Step = steps.Step;
export type Workflow = steps.Workflow;
export type DoStep = steps.DoStep;
export type EndStep = steps.EndStep;
export type WorkflowOutput = steps.WorkflowOutput;
export type StepKind = steps.StepKind;

/** `root`, `path:<path id>`, `otherwise:<otherwise id>` or `loop:<for-each or repeat step id>`. */
export type ContainerId = string;
export const ROOT: ContainerId = "root";
export type NewId = () => string;

// ── Containers ───────────────────────────────────────────────────────────────────────────────────

/** The containers directly inside a step (a fork's paths and otherwise, a loop's block). */
export function childContainers(step: Step): { id: ContainerId; steps: Step[] }[] {
  if (step.kind === "fork") {
    return [
      ...step.paths.map((p) => ({ id: `path:${p.id}`, steps: p.steps })),
      { id: `otherwise:${step.otherwise.id}`, steps: step.otherwise.steps },
    ];
  }
  if (step.kind === "for_each" || step.kind === "repeat") {
    return [{ id: `loop:${step.id}`, steps: step.steps }];
  }
  return [];
}

/** Every container inside a step, at any depth: where the step itself can't be moved to. */
export function containersWithin(step: Step): Set<ContainerId> {
  const out = new Set<ContainerId>();
  const visit = (s: Step) => {
    for (const c of childContainers(s)) {
      out.add(c.id);
      for (const inner of c.steps) visit(inner);
    }
  };
  visit(step);
  return out;
}

export interface Located {
  step: Step;
  container: ContainerId;
  index: number;
}

/** Every step in reading order, with the container it is in and its place there. */
export function walk(workflow: Pick<Workflow, "steps">): Located[] {
  const out: Located[] = [];
  const visit = (list: readonly Step[], container: ContainerId) => {
    list.forEach((step, index) => {
      out.push({ step, container, index });
      for (const c of childContainers(step)) visit(c.steps, c.id);
    });
  };
  visit(workflow.steps, ROOT);
  return out;
}

export function findStep(workflow: Pick<Workflow, "steps">, id: string): Located | null {
  return walk(workflow).find((l) => l.step.id === id) ?? null;
}

export function getContainer(workflow: Pick<Workflow, "steps">, id: ContainerId): Step[] | null {
  if (id === ROOT) return workflow.steps;
  for (const { step } of walk(workflow)) {
    for (const c of childContainers(step)) if (c.id === id) return c.steps;
  }
  return null;
}

function withChildren(step: Step, map: (id: ContainerId, list: Step[]) => Step[]): Step {
  if (step.kind === "fork") {
    return {
      ...step,
      paths: step.paths.map((p) => ({ ...p, steps: map(`path:${p.id}`, p.steps) })),
      otherwise: {
        ...step.otherwise,
        steps: map(`otherwise:${step.otherwise.id}`, step.otherwise.steps),
      },
    };
  }
  if (step.kind === "for_each" || step.kind === "repeat") {
    return { ...step, steps: map(`loop:${step.id}`, step.steps) };
  }
  return step;
}

/** Applies `edit` to the list a container holds, copying only what changes shape. */
function editContainer(
  list: Step[],
  at: ContainerId,
  here: ContainerId,
  edit: (list: Step[]) => Step[],
): Step[] {
  if (at === here) return edit(list);
  return list.map((s) => withChildren(s, (id, inner) => editContainer(inner, at, id, edit)));
}

function editSteps(workflow: Workflow, at: ContainerId, edit: (list: Step[]) => Step[]): Workflow {
  return { ...workflow, steps: editContainer(workflow.steps, at, ROOT, edit) };
}

// ── New steps ────────────────────────────────────────────────────────────────────────────────────

/**
 * A new step of a kind, as the palette adds it. A Do starts with nothing chosen (Done by is the
 * first thing to say); nothing that writes starts without its approver (invariant 8: a new step's
 * checks start on, and the form switches an approver on for every Change it uses).
 */
export function newStep(kind: StepKind, newId: NewId = uuidv7): Step {
  const id = newId();
  switch (kind) {
    case "do":
      return { kind, id, name: "", input: {} };
    case "loop":
      return {
        kind,
        id,
        name: "",
        goal: "",
        input: {},
        output: [],
        reads: [],
        instructions: "",
        maxTurns: 10,
        atLimit: "stop",
      };
    case "fork":
      return {
        kind,
        id,
        name: "",
        paths: [{ id: newId(), name: "", when: { match: "all", rules: [] }, steps: [] }],
        otherwise: { id: newId(), steps: [] },
      };
    case "for_each":
      return { kind, id, name: "", over: "", concurrency: 10, steps: [] };
    case "repeat":
      return {
        kind,
        id,
        name: "",
        steps: [],
        until: { agent: { goal: "" } },
        maxTimes: 3,
        onLimit: "stop",
      };
    case "wait":
      return { kind, id, name: "", for: "5 minutes" };
    case "handoff":
      return { kind, id, name: "", to: { agent: "", step: "" }, input: {} };
    case "end":
      return { kind, id, name: "", outputs: [], status: "succeeded" };
  }
}

/** The kinds the palette offers, in its order, with the words on them (§4). */
export const PALETTE: readonly { kind: StepKind; label: string; does: string }[] = [
  { kind: "do", label: "Do", does: "One piece of work, done by rules, AI or a person." },
  { kind: "loop", label: "Loop", does: "A model works toward a goal with read actions." },
  { kind: "fork", label: "Fork", does: "Take one of several paths." },
  { kind: "for_each", label: "For each", does: "Run the steps inside once per item of a list." },
  { kind: "repeat", label: "Repeat", does: "Run the steps inside again until it is done." },
  { kind: "wait", label: "Wait", does: "Pause the run." },
  { kind: "handoff", label: "Hand off", does: "Start another agent's run, or another workflow." },
  { kind: "end", label: "End", does: "Where a path finishes, and what it delivers." },
];

export function kindLabel(kind: StepKind): string {
  return PALETTE.find((p) => p.kind === kind)?.label ?? kind;
}

// ── Edits ────────────────────────────────────────────────────────────────────────────────────────

/** Puts a step into a container before `index` (the end when beyond it). */
export function insertStep(
  workflow: Workflow,
  at: { container: ContainerId; index: number },
  step: Step,
): Workflow {
  return ensureEnd(
    editSteps(workflow, at.container, (list) => {
      const i = Math.max(0, Math.min(at.index, list.length));
      return [...list.slice(0, i), step, ...list.slice(i)];
    }),
  );
}

/** Replaces a step by its id with `next`; the rest of the workflow is untouched. */
export function updateStep(workflow: Workflow, id: string, edit: (step: Step) => Step): Workflow {
  const map = (list: Step[]): Step[] =>
    list.map((s) => {
      const inner = withChildren(s, (_c, l) => map(l));
      return inner.id === id ? edit(inner) : inner;
    });
  return { ...workflow, steps: map(workflow.steps) };
}

/**
 * Whether a step can be taken out. An End stays where taking it out would let a path finish
 * without one (§9: it can be filled, not deleted); the trigger-side never comes into it.
 */
export function canRemove(workflow: Workflow, id: string): boolean {
  const at = findStep(workflow, id);
  if (!at) return false;
  if (at.step.kind !== "end") return true;
  return steps.endsAlways(removeRaw(workflow, id).steps);
}

function removeRaw(workflow: Workflow, id: string): Workflow {
  const at = findStep(workflow, id);
  if (!at) return workflow;
  return editSteps(workflow, at.container, (list) => list.filter((s) => s.id !== id));
}

/** Takes a step out (and what is inside it); an End that must stay is left in place. */
export function removeStep(workflow: Workflow, id: string): Workflow {
  if (!canRemove(workflow, id)) return workflow;
  return ensureEnd(removeRaw(workflow, id));
}

/** Moves a step to another place; never into itself or something inside it. */
export function moveStep(
  workflow: Workflow,
  id: string,
  to: { container: ContainerId; index: number },
): Workflow {
  const at = findStep(workflow, id);
  if (!at) return workflow;
  if (to.container === ROOT ? false : containersWithin(at.step).has(to.container)) return workflow;
  if (at.step.kind === "end" && !canRemove(workflow, id)) {
    // An End that holds a path closed moves only within its own list.
    if (to.container !== at.container) return workflow;
  }
  const without = removeRaw(workflow, id);
  // The place counts the list without the step, so moving down one in the same list lands right.
  const index = to.container === at.container && to.index > at.index ? to.index - 1 : to.index;
  return ensureEnd(
    editSteps(without, to.container, (list) => {
      const i = Math.max(0, Math.min(index, list.length));
      return [...list.slice(0, i), at.step, ...list.slice(i)];
    }),
  );
}

// ── Ends and outputs ─────────────────────────────────────────────────────────────────────────────

/**
 * The builder adds an End at the end of the main line when it would run past its last step, as the
 * trigger is always first (§9). A fork whose every path ends already ends the line.
 */
export function ensureEnd(workflow: Workflow, newId: NewId = uuidv7): Workflow {
  if (steps.endsAlways(workflow.steps)) return workflow;
  return { ...workflow, steps: [...workflow.steps, newStep("end", newId)] };
}

/** A fork gets its paths' ends worked out in the same way: a path that ends on an End stays one. */
export function endSteps(workflow: Pick<Workflow, "steps">): EndStep[] {
  return walk(workflow)
    .map((l) => l.step)
    .filter((s): s is EndStep => s.kind === "end");
}

export const NOTHING_TO_DO_DEFAULT = "";

/** What an End delivers: outputs by id, or nothing to do with its reason (never both, §9). */
export function setEndOutputs(
  workflow: Workflow,
  id: string,
  pick: { outputs: string[] } | { nothingToDo: string },
): Workflow {
  return updateStep(workflow, id, (s) => {
    if (s.kind !== "end") return s;
    const { nothingToDo: _drop, ...rest } = s;
    return "outputs" in pick
      ? { ...rest, outputs: pick.outputs }
      : { ...rest, outputs: [], nothingToDo: pick.nothingToDo };
  });
}

/** A new declared output, named, as a report to the client's team by default. */
export function newOutput(name: string, newId: NewId = uuidv7): WorkflowOutput {
  return { id: newId(), name, kind: "nothing", fields: [] } as WorkflowOutput;
}

export function addOutput(workflow: Workflow, output: WorkflowOutput): Workflow {
  return { ...workflow, outputs: [...workflow.outputs, output] };
}

export function updateOutput(
  workflow: Workflow,
  id: string,
  edit: (o: WorkflowOutput) => WorkflowOutput,
): Workflow {
  return { ...workflow, outputs: workflow.outputs.map((o) => (o.id === id ? edit(o) : o)) };
}

/** Takes an output off the list and out of every End that picked it. */
export function removeOutput(workflow: Workflow, id: string): Workflow {
  const cleaned = (list: Step[]): Step[] =>
    list.map((s) => {
      const inner = withChildren(s, (_c, l) => cleaned(l));
      return inner.kind === "end" && inner.outputs.includes(id)
        ? { ...inner, outputs: inner.outputs.filter((o) => o !== id) }
        : inner;
    });
  return {
    ...workflow,
    outputs: workflow.outputs.filter((o) => o.id !== id),
    steps: cleaned(workflow.steps),
  };
}

// ── Reading order and numbers ────────────────────────────────────────────────────────────────────

/** Each container's parent: the container the step that holds it sits in (`root` has none). */
function parents(workflow: Pick<Workflow, "steps">): Map<ContainerId, ContainerId> {
  const out = new Map<ContainerId, ContainerId>();
  for (const l of walk(workflow)) {
    for (const c of childContainers(l.step)) out.set(c.id, l.container);
  }
  return out;
}

/**
 * The steps before one on its way in, in reading order: what its Input may pick from. These are the
 * steps in its own list and in the lists around it; another path of a fork never ran on the way to
 * it, and a loop's inside is not there for what follows the loop.
 */
export function stepsBefore(workflow: Pick<Workflow, "steps">, id: string): Step[] {
  const all = walk(workflow);
  const at = all.findIndex((l) => l.step.id === id);
  const mine = all[at];
  if (!mine) return [];
  const up = parents(workflow);
  const around = new Set<ContainerId>();
  for (let c: ContainerId | undefined = mine.container; c !== undefined; c = up.get(c)) {
    around.add(c);
  }
  return all
    .slice(0, at)
    .filter((l) => around.has(l.container))
    .map((l) => l.step);
}
