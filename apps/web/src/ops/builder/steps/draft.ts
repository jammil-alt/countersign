// A draft in the stored format (docs/step-model-plan.md §13a). The builder adds cards a person fills
// in afterwards: an End that delivers nothing yet, a step with no goal, an empty For each. The frozen
// schema (`@countersign/core` steps) refuses all of them, and a draft with problems has to be
// saveable (the v4 builder's save is, and only Try it and Publish need a clean one). So a draft is
// stored with a marker where the person has not filled something in, and read back without it.
//
// DECISION: markers in the stored draft, not a looser schema (the format is frozen; a change there is
// the coordinator's). The builder's own issues come from the working copy, where the card is simply
// empty, so Publish stays refused. Stored as such, an End says "Not filled in yet" as its reason: a
// publish made some other way than this builder (the staging MCP's `agent_publish`) would read it as
// a real reason. Needs a core change: a draft-friendly End, or the validator knowing `UNFILLED`.

import type { Step, Workflow, WorkflowOutput } from "./types";

/** What a stored draft says where something is not filled in yet. */
export const UNFILLED = "(not filled in yet)";
/** Who a stored draft's report goes to when nobody is picked. */
export const NOBODY = "(nobody yet)";
/** The id suffix of the step that stands in for an empty For each or Repeat. */
export const EMPTY_SUFFIX = "-empty";

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === "";

function storedOutput(o: WorkflowOutput): WorkflowOutput {
  let out = o;
  if (blank(out.name)) out = { ...out, name: UNFILLED };
  if (out.kind === "report" && out.report && out.report.to.length === 0) {
    out = { ...out, report: { ...out.report, to: [NOBODY] } };
  }
  // A kind that says how it goes only once it does: until then it is stored as nothing leaving.
  if ((out.kind === "write" || out.kind === "save") && !out.action?.action) {
    const { action: _a, ...rest } = out;
    out = { ...rest, kind: "nothing" };
  }
  if (out.kind === "handoff" && !out.handoff?.step) {
    const { handoff: _h, ...rest } = out;
    out = { ...rest, kind: "nothing" };
  }
  if (
    out.kind === "pass_on" &&
    blank(typeof out.passOn?.output === "string" ? out.passOn.output : "x")
  ) {
    const { passOn: _p, ...rest } = out;
    out = { ...rest, kind: "nothing" };
  }
  return out;
}

function stored(step: Step): Step {
  const name = blank(step.name) ? UNFILLED : step.name;
  switch (step.kind) {
    case "end": {
      const filled =
        step.outputs.length > 0 || (step.nothingToDo !== undefined && !blank(step.nothingToDo));
      if (filled) return { ...step, name };
      const { nothingToDo: _n, ...rest } = step;
      return { ...rest, name, outputs: [], nothingToDo: UNFILLED };
    }
    case "loop":
      return { ...step, name, goal: blank(step.goal) ? UNFILLED : step.goal };
    case "repeat": {
      const inner = step.steps.map(stored);
      const until =
        "agent" in step.until && blank(step.until.agent.goal)
          ? { agent: { ...step.until.agent, goal: UNFILLED } }
          : step.until;
      return { ...step, name, until, steps: inner.length > 0 ? inner : [padding(step.id)] };
    }
    case "for_each": {
      const inner = step.steps.map(stored);
      return { ...step, name, steps: inner.length > 0 ? inner : [padding(step.id)] };
    }
    case "fork":
      return {
        ...step,
        name,
        paths: step.paths.map((p) => ({ ...p, steps: p.steps.map(stored) })),
        otherwise: { ...step.otherwise, steps: step.otherwise.steps.map(stored) },
      };
    default:
      return { ...step, name };
  }
}

/** A step that holds an empty For each's or Repeat's place, so the stored list is not empty. */
function padding(owner: string): Step {
  return { kind: "do", id: `${owner}${EMPTY_SUFFIX}`, name: UNFILLED, input: {} };
}

function working(step: Step): Step {
  const name = step.name === UNFILLED ? "" : step.name;
  switch (step.kind) {
    case "end": {
      if (step.nothingToDo === UNFILLED) {
        const { nothingToDo: _n, ...rest } = step;
        return { ...rest, name, outputs: [] };
      }
      return { ...step, name };
    }
    case "loop":
      return { ...step, name, goal: step.goal === UNFILLED ? "" : step.goal };
    case "repeat":
      return {
        ...step,
        name,
        until:
          "agent" in step.until && step.until.agent.goal === UNFILLED
            ? { agent: { ...step.until.agent, goal: "" } }
            : step.until,
        steps: step.steps.filter((s) => !s.id.endsWith(EMPTY_SUFFIX)).map(working),
      };
    case "for_each":
      return {
        ...step,
        name,
        steps: step.steps.filter((s) => !s.id.endsWith(EMPTY_SUFFIX)).map(working),
      };
    case "fork":
      return {
        ...step,
        name,
        paths: step.paths.map((p) => ({ ...p, steps: p.steps.map(working) })),
        otherwise: { ...step.otherwise, steps: step.otherwise.steps.map(working) },
      };
    default:
      return { ...step, name };
  }
}

function workingOutput(o: WorkflowOutput): WorkflowOutput {
  let out = o.name === UNFILLED ? { ...o, name: "" } : o;
  if (out.kind === "report" && out.report?.to.length === 1 && out.report.to[0] === NOBODY) {
    out = { ...out, report: { ...out.report, to: [] } };
  }
  return out;
}

/** The working copy as it is stored: every card the schema would refuse carries a marker. */
export function toStored(workflow: Workflow): Workflow {
  return {
    ...workflow,
    outputs: workflow.outputs.map(storedOutput),
    steps: workflow.steps.map(stored),
  };
}

/** A stored workflow as the builder works on it: the markers are gone, the cards empty. */
export function fromStored(workflow: Workflow): Workflow {
  return {
    ...workflow,
    outputs: workflow.outputs.map(workingOutput),
    steps: workflow.steps.map(working),
  };
}
