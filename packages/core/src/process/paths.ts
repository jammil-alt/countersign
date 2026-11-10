// R8 (docs/plan.md §1.86, §9): what the builder's field picker offers at a v4 step, the
// counterpart of `pathsAt` (template/typer.ts) for v3. The same scopes the validator types with
// (`processScopes`), so a picked reference is one the validator accepts. A step's checks read more
// than the step itself: its own output (after a read or a skill that writes nothing, and always in
// a notify) and the verdicts of its confer reviewers.

import type { JsonSchema } from "../schemas/common";
import { type PathOption, pathOptions } from "../template/typer";
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
  for (const [id, { output }] of Object.entries(scope.steps)) {
    out.push(...pathOptions(output, `steps.${id}.output`, depth, id));
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
  for (let n = 0; n < (options.confer ?? 0); n += 1) {
    out.push(...pathOptions(CONFER_RESULT as JsonSchema, `confer.${n}`, 1));
  }
  return out;
}
