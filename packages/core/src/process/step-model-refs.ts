// A v5 workflow's references to other steps (`{{steps.<id>.output…}}`): each names a step that
// exists and runs before the step that reads it, on its own path (earlier steps of the same list,
// and of the lists around it). What a field holds is left to the step's own checks.

import type { Step } from "../steps/schema";
import { stepModelIds } from "../steps/walk";
import { collectRefs } from "../template/template";

export interface StepRefError {
  stepId: string;
  field: string;
  code: "template_scope" | "template_syntax";
  message: string;
}

/** What a step itself reads: its settings without the steps it holds. */
function ownConfig(step: Step): unknown {
  switch (step.kind) {
    case "fork": {
      const { paths, otherwise: _o, ...rest } = step;
      return { ...rest, paths: paths.map(({ steps: _s, ...p }) => p) };
    }
    case "for_each": {
      const { steps: _s, ...rest } = step;
      return rest;
    }
    // Its stop test and wait read what the body did, so they are checked after it.
    case "repeat": {
      const { steps: _s, until: _u, between: _b, ...rest } = step;
      return rest;
    }
    default:
      return step;
  }
}

export function stepModelRefErrors(workflow: { steps: Step[] }): StepRefError[] {
  const known = new Set(stepModelIds({ triggers: [], outputs: [], steps: workflow.steps }));
  const errors: StepRefError[] = [];
  const check = (step: Step, config: unknown, ran: ReadonlySet<string>) => {
    const { refs, errors: syntax } = collectRefs(config);
    for (const e of syntax) {
      errors.push({
        stepId: step.id,
        field: e.at.join("."),
        code: "template_syntax",
        message: e.message,
      });
    }
    for (const ref of refs) {
      const [head, id] = ref.path;
      if (head !== "steps" || id === undefined || ran.has(id)) continue;
      errors.push({
        stepId: step.id,
        field: ref.at.join("."),
        code: "template_scope",
        message: known.has(id)
          ? `{{${ref.expr}}}: step "${id}" does not run before this one on its path`
          : `{{${ref.expr}}}: unknown reference`,
      });
    }
  };
  const visit = (list: readonly Step[], before: ReadonlySet<string>) => {
    const ran = new Set(before);
    for (const step of list) {
      check(step, ownConfig(step), ran);
      if (step.kind === "fork") {
        for (const p of step.paths) visit(p.steps, ran);
        visit(step.otherwise.steps, ran);
      } else if (step.kind === "for_each") {
        visit(step.steps, ran);
      } else if (step.kind === "repeat") {
        visit(step.steps, ran);
        const inside = new Set(ran);
        for (const s of step.steps) inside.add(s.id);
        check(step, { until: step.until, between: step.between }, inside);
      }
      ran.add(step.id);
    }
  };
  visit(workflow.steps, new Set());
  return errors;
}
