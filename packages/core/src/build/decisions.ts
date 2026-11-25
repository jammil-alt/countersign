// Decisions on a build (docs/builder-plan.md §4): which of the draft's steps make a decision that
// shapes them high risk by code. A step that writes to a client's tool, or contacts people, is on
// the high-risk list (§4.2: writing into a client's tool; contacting people outside the client).
// Read from the draft with the process validator's own helpers, never guessed by a model.

import { stepReaches, stepWrites } from "../process/validate";
import { allSteps } from "../process/walk";
import type { ProcessAgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import { mergedAction } from "../steps/catalog";
import type { Workflow as StepWorkflow } from "../steps/schema";
import { eachStep } from "../steps/walk";
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
  bundle: {
    workflows: readonly {
      workflow: ProcessAgentBundle["workflows"][number]["workflow"] | StepWorkflow;
    }[];
  },
  typing: TypingContext,
): Set<string> {
  const out = new Set<string>();
  for (const w of bundle.workflows) {
    if (w.workflow.schemaVersion === 5) {
      for (const id of stepModelWritingSteps(w.workflow, typing)) out.add(id);
      continue;
    }
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

/**
 * Step model (build item 9): a v5 workflow's steps that write to a client's tool or reach people:
 * a Do on an action that changes or sends (one this context doesn't know counts as writing), a Do
 * done by an outside contact, Collect reports, a skill that reaches people (one not known here
 * counts), and an End that delivers a write output.
 */
function stepModelWritingSteps(workflow: StepWorkflow, typing: TypingContext): Set<string> {
  const out = new Set<string>();
  const sideEffect = (action: string) => {
    const own = typing.tools?.[action];
    if (own) return own.sideEffect;
    const merged = mergedAction(action);
    for (const tool of Object.values(merged?.tools ?? {})) {
      const spec = typing.tools?.[tool];
      if (spec) return spec.sideEffect;
    }
    return undefined;
  };
  const writes = (action: string) => {
    const effect = sideEffect(action);
    return effect === undefined || effect === "external";
  };
  const writeOutputs = new Set(
    workflow.outputs
      .filter((o) => o.kind === "write" && (!o.action || writes(o.action.action)))
      .map((o) => o.id),
  );
  eachStep(workflow.steps, ({ step }) => {
    if (step.kind === "end") {
      if (step.outputs.some((o) => writeOutputs.has(o))) out.add(step.id);
      return;
    }
    if (step.kind !== "do") return;
    const uses = step.uses;
    if (uses?.type === "action" && writes(uses.action)) out.add(step.id);
    if (step.doneBy === "contact" || uses?.type === "collect") out.add(step.id);
    if (uses?.type === "skill") {
      const skills = typing.skills ?? {};
      const def = skills[uses.skill] ?? skills[parseSkillRef(uses.skill).id];
      if (def === undefined || def.reachesPeople === true) out.add(step.id);
    }
  });
  return out;
}
