import { cloneJson } from "../json";
import type { AnyAgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import type { Step } from "../schemas/workflow";
import { eachStep } from "../steps/walk";
import { walkSteps } from "../workflow/walk";
import { eachProcessStep } from "./normalize";

/**
 * Removes settings marked `clientSpecific` in their skill's definition (e.g. a vendor list) from a
 * bundle's agent skills and skill steps, so promoting a client's agent into a template never
 * carries that client's values (ARCHITECTURE §9.3 "Promoting"). Skills it can't find are left alone.
 * R1: a v4 process's skill steps are stripped the same way.
 */
export function stripClientSpecificSettings<B extends AnyAgentBundle>(
  bundle: B,
  skills: Record<string, Pick<SkillDefinition, "settings">>,
): B {
  const out = cloneJson(bundle);
  const keysFor = (ref: string) => {
    const def = skills[ref] ?? skills[parseSkillRef(ref).id];
    return new Set(def?.settings.filter((s) => s.clientSpecific).map((s) => s.key) ?? []);
  };
  const strip = (step: {
    kind: string;
    skill?: string | undefined;
    settings?: Record<string, unknown> | undefined;
  }) => {
    if (step.kind === "skill" && step.skill && step.settings) {
      for (const k of keysFor(step.skill)) delete step.settings[k];
    }
  };
  for (const s of out.definition.skills) {
    for (const k of keysFor(s.skill)) delete s.settings[k];
  }
  for (const w of out.workflows) {
    if (w.workflow.schemaVersion === 5) {
      // The step model: a Do's skill values sit in its rules' or its AI's instructions.
      eachStep(w.workflow.steps, ({ step }) => {
        if (step.kind !== "do" || step.uses?.type !== "skill") return;
        for (const k of keysFor(step.uses.skill)) {
          if (step.rules?.values) delete step.rules.values[k];
          if (step.ai?.values) delete step.ai.values[k];
        }
      });
    } else if (w.workflow.schemaVersion === 4) eachProcessStep(w.workflow.steps, strip);
    else walkSteps(w.workflow, ({ step }: { step: Step }) => strip(step));
  }
  return out;
}
