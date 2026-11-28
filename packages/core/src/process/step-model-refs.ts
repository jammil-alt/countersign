// A v5 workflow's references to other steps (`{{steps.<id>.output…}}`): each names a step that
// exists and runs before the step that reads it, on its own path (earlier steps of the same list,
// and of the lists around it), and a field that step hands on (`steps/hands-on.ts`). A For each's
// `{{item.…}}` is checked against the list it goes over. What a field's value is, is left to the
// step's own checks.
// Staging, 2026-11-27: a reference to a field no step hands on published, then ran as nothing.

import type { JsonSchema } from "../schemas/common";
import { handsOn } from "../steps/hands-on";
import type { Step, WorkflowOutput } from "../steps/schema";
import { stepModelIds } from "../steps/walk";
import { collectRefs } from "../template/template";
import { schemaAtPath, type TypingContext } from "../template/typer";

export interface StepRefError {
  stepId: string;
  field: string;
  code: "template_scope" | "template_syntax" | "template_path";
  message: string;
}

/** What `{{item}}` is inside a For each over `over`: an item of that list, when it is known. */
function itemOf(over: string, shapes: ReadonlyMap<string, JsonSchema>, item?: JsonSchema) {
  const ref = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(over)?.[1];
  if (!ref) return undefined;
  const [head, id, out, ...rest] = ref.split(".");
  let list: JsonSchema | undefined;
  if (head === "steps" && id !== undefined && out === "output") {
    const shape = shapes.get(id);
    const at = shape ? schemaAtPath(shape, rest) : undefined;
    list = at?.ok ? at.schema : undefined;
  } else if (head === "item" && item !== undefined) {
    const at = schemaAtPath(item, ref.split(".").slice(1));
    list = at.ok ? at.schema : undefined;
  }
  const items = (list as { items?: unknown } | undefined)?.items;
  return items !== null && typeof items === "object" ? (items as JsonSchema) : undefined;
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

export function stepModelRefErrors(
  workflow: { steps: Step[]; outputs?: readonly WorkflowOutput[] },
  ctx: TypingContext = {},
): StepRefError[] {
  const known = new Set(stepModelIds({ triggers: [], outputs: [], steps: workflow.steps }));
  const errors: StepRefError[] = [];
  // What each step hands on, by id, and its name for the message.
  const shapes = new Map<string, JsonSchema>();
  const names = new Map<string, string>();
  const index = (list: readonly Step[]) => {
    for (const s of list) {
      shapes.set(s.id, handsOn(s, ctx));
      names.set(s.id, s.name);
      if (s.kind === "fork") {
        for (const p of s.paths) index(p.steps);
        index(s.otherwise.steps);
      } else if (s.kind === "for_each" || s.kind === "repeat") {
        index(s.steps);
      }
    }
  };
  index(workflow.steps);
  let item: JsonSchema | undefined;
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
      const [head, id, out, ...rest] = ref.path;
      if (head === "item" && item !== undefined) {
        const at = schemaAtPath(item, ref.path.slice(1));
        if (!at.ok) {
          errors.push({
            stepId: step.id,
            field: ref.at.join("."),
            code: "template_path",
            message: `{{${ref.expr}}}: an item of the list this For each goes over has ${at.message}`,
          });
        }
        continue;
      }
      if (head !== "steps" || id === undefined) continue;
      if (ran.has(id)) {
        const shape = out === "output" ? shapes.get(id) : undefined;
        const at = shape ? schemaAtPath(shape, rest) : undefined;
        if (at && !at.ok) {
          errors.push({
            stepId: step.id,
            field: ref.at.join("."),
            code: "template_path",
            message: `{{${ref.expr}}}: "${names.get(id) ?? id}" hands on ${at.message}`,
          });
        }
        continue;
      }
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
      // A step's notice runs after it, so it may read the step's own output. Its approval and its
      // confer are decided before it runs (a write's approval before the write): they may not, or
      // a condition on an output that isn't there yet could drop the approval (invariant 8).
      const { checks, ...config } = ownConfig(step) as {
        checks?: { notify?: unknown } & Record<string, unknown>;
      };
      check(step, config, ran);
      // An End delivers its outputs (a report's words, a write's input) from what ran before it.
      if (step.kind === "end") {
        for (const id of step.outputs) {
          const output = workflow.outputs?.find((o) => o.id === id);
          if (output) check(step, { outputs: { [id]: output } }, ran);
        }
      }
      if (checks !== undefined) {
        const { notify, ...before } = checks;
        check(step, { checks: before }, ran);
        if (notify !== undefined) check(step, { checks: { notify } }, new Set([...ran, step.id]));
      }
      if (step.kind === "fork") {
        for (const p of step.paths) visit(p.steps, ran);
        visit(step.otherwise.steps, ran);
      } else if (step.kind === "for_each") {
        const outer = item;
        item = itemOf(step.over, shapes, outer);
        visit(step.steps, ran);
        item = outer;
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
