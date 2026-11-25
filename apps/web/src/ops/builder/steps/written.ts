// Rules and AI written in a step (docs/step-model-plan.md §5): what makes a Do step one that is
// stored behind it as a skill when the workflow is saved. The server decides; this is only whether
// there is anything for it to store, so a save with none makes no extra call.

import type { Step, Workflow } from "./types";

/** Whether a Do step is done by rules (with rows) or by AI (with text), using nothing else. */
export function writtenInStep(step: Step): boolean {
  if (step.kind !== "do" || step.uses !== undefined) return false;
  if (step.doneBy === "rules") return (step.rules?.rows?.length ?? 0) > 0;
  if (step.doneBy === "ai") return (step.ai?.text ?? "").trim() !== "";
  return false;
}

/** Whether any step of the workflow writes rules or instructions in itself. */
export function hasWrittenSteps(workflow: Workflow): boolean {
  const any = (list: readonly Step[]): boolean =>
    list.some((s) => {
      if (writtenInStep(s)) return true;
      if (s.kind === "fork") return s.paths.some((p) => any(p.steps)) || any(s.otherwise.steps);
      if (s.kind === "for_each" || s.kind === "repeat") return any(s.steps);
      return false;
    });
  return any(workflow.steps);
}

/**
 * The bundle with the step skills of this agent pinned in its skills (`custom:step-<agent id>-<step
 * id>@N`), the ones saved just now, and the agent's older ones taken out. The version then says
 * which text ran (invariants 3, 10), and publishing it makes exactly those versions live.
 */
export function withStepSkillPins(
  bundle: unknown,
  agentId: string,
  pins: readonly string[],
): unknown {
  const b = bundle as { definition: { skills?: { skill: string; [k: string]: unknown }[] } };
  const own = `custom:step-${agentId.toLowerCase()}-`;
  const kept = (b.definition.skills ?? []).filter((s) => !s.skill.startsWith(own));
  const skills = [...kept, ...pins.map((skill) => ({ skill, settings: {} }))];
  return { ...b, definition: { ...b.definition, skills } };
}
