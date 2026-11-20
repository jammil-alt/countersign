// Decisions on a build (docs/builder-plan.md §4): which of the draft's steps make a decision that
// shapes them high risk by code. A step that writes to a client's tool, or contacts people, is on
// the high-risk list (§4.2: writing into a client's tool; contacting people outside the client).
// Read from the draft with the process validator's own helpers, never guessed by a model.

import { stepReaches, stepWrites } from "../process/validate";
import { allSteps } from "../process/walk";
import type { ProcessAgentBundle } from "../schemas/agent";
import type { TypingContext } from "../template/typer";

/**
 * The ids of the draft's steps that write to a client's tool or reach people. A write step whose
 * tool isn't known here (an action resolved at run time, a tool from a pack not loaded) counts as
 * writing: never less strict than the draft. So does a skill step whose skill isn't known here.
 */
// DECISION (CONS-4): a skill step the typing context doesn't know (a client's custom skill not
// looked up, or one that no longer exists) counts as writing, as the validator's
// `outputBeforeChecks` counts it and the executor reads its approval: the safe side. Callers pass
// the client's custom skills (apps/api `draftWritingSteps`), so a known skill that writes nothing
// and reaches nobody stays normal risk.
export function writingStepIds(
  bundle: Pick<ProcessAgentBundle, "workflows">,
  typing: TypingContext,
): Set<string> {
  const out = new Set<string>();
  for (const w of bundle.workflows) {
    for (const { step } of allSteps(w.workflow)) {
      const writes = stepWrites(step, typing);
      if (
        ((step.kind === "write" || step.kind === "skill") && writes === undefined) ||
        (writes?.length ?? 0) > 0 ||
        stepReaches(step, typing)
      ) {
        out.add(step.id);
      }
    }
  }
  return out;
}
