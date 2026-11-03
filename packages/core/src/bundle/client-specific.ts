import { cloneJson } from "../json";
import type { AgentBundle } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import type { Step } from "../schemas/workflow";
import { walkSteps } from "../workflow/walk";

/**
 * Removes settings marked `clientSpecific` in their skill's definition (e.g. a vendor list) from a
 * bundle's agent skills and skill steps, so promoting a client's agent into a template never
 * carries that client's values (ARCHITECTURE §9.3 "Promoting"). Skills it can't find are left alone.
 */
export function stripClientSpecificSettings(
  bundle: AgentBundle,
  skills: Record<string, Pick<SkillDefinition, "settings">>,
): AgentBundle {
  const out = cloneJson(bundle);
  const keysFor = (ref: string) => {
    const def = skills[ref] ?? skills[parseSkillRef(ref).id];
    return new Set(def?.settings.filter((s) => s.clientSpecific).map((s) => s.key) ?? []);
  };
  for (const s of out.definition.skills) {
    for (const k of keysFor(s.skill)) delete s.settings[k];
  }
  for (const w of out.workflows) {
    walkSteps(w.workflow, ({ step }: { step: Step }) => {
      if (step.kind === "skill" && step.settings) {
        for (const k of keysFor(step.skill)) delete step.settings[k];
      }
    });
  }
  return out;
}
