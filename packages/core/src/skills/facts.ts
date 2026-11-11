// The skill model (owner, 2026-11-10): the facts shown wherever a skill is listed (the Library,
// the builder's palette, a step): its kind and label, the tools that make code AI, its parameters
// and its recommended model. One function, so every screen says the same.

import type { SkillDefinition } from "../schemas/skill";
import { modelTools, SKILL_KIND_LABEL, type SkillToolLookup, skillKind } from "./kind";
import { recommendedModel } from "./model";

export function skillModelFacts(
  def: Pick<
    SkillDefinition,
    "mode" | "method" | "handler" | "tools" | "reads" | "model" | "parameters"
  >,
  tools?: SkillToolLookup,
) {
  const kind = skillKind(def, tools);
  return {
    kind,
    kindLabel: SKILL_KIND_LABEL[kind],
    modelTools: modelTools(def, tools),
    parameters: def.parameters ?? [],
    recommendedModel: recommendedModel(def),
  };
}
