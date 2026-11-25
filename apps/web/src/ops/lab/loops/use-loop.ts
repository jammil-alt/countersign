// Picking a saved Loop in a Loop step (docs/step-model-plan.md §8): the step takes the Loop's goal,
// reads, turns, output and checks, and keeps its address so the runtime holds the skill's own reads
// and turns as the ceiling. The step may then read fewer actions or run fewer turns; it can't ask
// for more (the runtime narrows to the skill's reads, whatever the step lists).
import type { steps } from "@countersign/core";
import type { LoopChoice } from "../../builder/steps/options";

type LoopStep = Extract<steps.Step, { kind: "loop" }>;

/** The step with the saved Loop's settings in. Its own name and input stay as they were. */
export function fromSavedLoop(step: LoopStep, loop: LoopChoice): LoopStep {
  return {
    ...step,
    skill: loop.ref,
    goal: loop.goal,
    reads: [...loop.reads],
    maxTurns: loop.maxTurns,
    atLimit: loop.atLimit,
    output: loop.output as LoopStep["output"],
    // Its instructions are the skill's own, read when it runs; the step adds none.
    instructions: "",
    ...(loop.review && loop.review !== "auto" ? { review: loop.review } : {}),
    ...(loop.conferFocus
      ? {
          checks: {
            ...step.checks,
            confer: { with: [{ ai: { focus: loop.conferFocus } }] },
          },
        }
      : {}),
  };
}

/** The step written in the step again: it keeps what it has and no longer names a skill. */
export function writeInStep(step: LoopStep): LoopStep {
  const { skill: _skill, ...rest } = step;
  return rest;
}

/** The actions a step may pick from: all its Gets, or, with a saved Loop, only that Loop's. */
export function readableFor(
  loop: Pick<LoopChoice, "reads"> | undefined,
): ((id: string) => boolean) | null {
  if (!loop) return null;
  const own = new Set(loop.reads);
  return (id) => own.has(id);
}
