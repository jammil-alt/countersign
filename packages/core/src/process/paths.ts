// R8 (docs/plan.md §1.86, §9): what the builder's field picker offers at a v4 step, the
// counterpart of `pathsAt` (template/typer.ts) for v3. The same scopes the validator types with
// (`processScopes`), so a picked reference is one the validator accepts. A step's checks read more
// than the step itself: its own output (after a read or a skill that writes nothing, and always in
// a notify) and the verdicts of its confer reviewers.
// Wave 5 (§1.86 "Forks (wave 5)"): how each earlier step ended (`steps.<id>.outcome`, its
// approval, confer, error, quick answer, a loop's counts: `stepOutcomeFields`), for an `if` to
// route on. Never the step's own: it hasn't ended when its checks run.

import type { JsonSchema } from "../schemas/common";
import { type PathOption, pathOptions } from "../template/typer";
import { stepOutcomeFields } from "./outcomes";
import type { Process } from "./schema";
import {
  CONFER_RESULT,
  type ProcessValidationContext,
  processScopes,
  stepOutputSchema,
} from "./validate";
import { findStep } from "./walk";

export interface ProcessPathsOptions {
  /** Offer the step's own output (`steps.<id>.output…`), as its checks read it. */
  own?: boolean;
  /** Offer the first `confer` reviewers' answers (`confer.<n>.verdict`). */
  confer?: number;
  depth?: number;
}

/** Every reference readable at a step of the process (empty for an unknown step). */
export function processPathsAt(
  process: Pick<Process, "triggers" | "steps">,
  stepId: string,
  ctx: ProcessValidationContext = {},
  options: ProcessPathsOptions = {},
): PathOption[] {
  const depth = options.depth ?? 4;
  const scope = processScopes(process, ctx).get(stepId);
  if (!scope) return [];
  const out: PathOption[] = [...pathOptions(scope.trigger, "trigger", depth)];
  for (const [id, { step, output }] of Object.entries(scope.steps)) {
    out.push(...pathOptions(output, `steps.${id}.output`, depth, id));
    for (const f of stepOutcomeFields(step)) {
      out.push({ path: `steps.${id}.${f.path}`, schema: f.schema, stepId: id });
    }
  }
  if (options.own) {
    const step = findStep(process, stepId)?.step;
    if (step)
      out.push(
        ...pathOptions(stepOutputSchema(step, ctx), `steps.${stepId}.output`, depth, stepId),
      );
  }
  if (scope.loop) {
    out.push(...pathOptions(scope.loop.item, "item", depth));
    out.push({ path: "index", schema: { type: "integer" } });
  }
  if (scope.repeat) {
    out.push(...loopPaths(scope.repeat.previous, depth));
    if ("agent" in scope.repeat.step.until) {
      out.push({ path: "loop.feedback", schema: { type: "string" } });
    }
  }
  for (let n = 0; n < (options.confer ?? 0); n += 1) {
    out.push(...pathOptions(CONFER_RESULT as JsonSchema, `confer.${n}`, 1));
  }
  return out;
}

/** v0.17: `{{loop.pass}}` and the pass before's top-level steps, inside a repeat. */
function loopPaths(previous: Record<string, JsonSchema | undefined>, depth: number): PathOption[] {
  const out: PathOption[] = [{ path: "loop.pass", schema: { type: "integer" } }];
  for (const [id, output] of Object.entries(previous)) {
    out.push(...pathOptions(output, `loop.previous.${id}.output`, depth, id));
  }
  return out;
}

/**
 * v0.17: what a repeat's `until` reads after a pass: what the repeat sees, its own top-level steps
 * (their outputs and how they ended) and `{{loop.pass}}`.
 */
export function repeatUntilPaths(
  process: Pick<Process, "triggers" | "steps">,
  repeatId: string,
  ctx: ProcessValidationContext = {},
): PathOption[] {
  const step = findStep(process, repeatId)?.step;
  if (step?.kind !== "repeat") return [];
  const out = processPathsAt(process, repeatId, ctx);
  for (const inner of step.steps) {
    out.push(...pathOptions(stepOutputSchema(inner, ctx), `steps.${inner.id}.output`, 4, inner.id));
    for (const f of stepOutcomeFields(inner)) {
      out.push({ path: `steps.${inner.id}.${f.path}`, schema: f.schema, stepId: inner.id });
    }
  }
  out.push({ path: "loop.pass", schema: { type: "integer" } });
  return out;
}
