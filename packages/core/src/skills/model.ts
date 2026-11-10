// The skill model (owner, 2026-11-10): which model an AI skill runs on. An AI skill version names
// a recommended model; a client agent may set its own per skill (one setting in its definition,
// `skills[].model`, for every use of that skill in that agent); a step may still override it for
// the rare double use. Most specific wins: step, then agent × skill, then the skill's recommended,
// then the agent's own model. The builder shows the model that will run and where it came from.
// Pricing (cost caps) and HIPAA (processors) apply to the model resolved here: the validator holds
// every model it names to the priced list (`definitionModelErrors`, `checkStepModel`) and the run's
// transport refuses a provider a HIPAA client has no agreement with (apps/api `guardModels`).

import type { AgentDefinition } from "../schemas/agent";
import type { ModelChoice, SkillDefinition } from "../schemas/skill";

/** Where the model that runs came from. */
export type ModelSource = "step" | "agent" | "skill" | "default";

export const MODEL_SOURCE_WORDS: Record<ModelSource, string> = {
  step: "set on this step",
  agent: "set for this skill in the agent",
  skill: "the skill's recommended model",
  default: "the agent's model",
};

export interface EffectiveModel {
  /** The model id that runs, and its output limit. */
  model: { id: string; maxTokens: number | undefined };
  from: ModelSource;
}

/**
 * The model a use of a skill runs on, and where that came from. Null for a code skill (`tool`
 * mode), which runs no model a step picks (a tool that calls one inside picks its own).
 */
// DECISION: an agent-mode skill (stored, retiring) runs on the agent's model as before, and the
// agent × skill setting and a step's model still override it; only a `task` skill has a
// recommended model of its own. `maxTokens` falls back along the same order as the id.
export function effectiveModel(input: {
  skill: Pick<SkillDefinition, "mode" | "model">;
  /** The agent's own model (its definition's `model`). */
  agentModel: Pick<AgentDefinition["model"], "id"> & { maxTokens?: number | undefined };
  /** The agent's setting for this skill (`definition.skills[].model`). */
  agentSkill?: ModelChoice | undefined;
  /** The step's own model (a step `model`, or its customization's). */
  step?: ModelChoice | undefined;
}): EffectiveModel | null {
  const { skill, agentModel, agentSkill, step } = input;
  if (skill.mode === "tool") return null;
  const recommended = skill.mode === "task" ? skill.model : undefined;
  const from: ModelSource = step
    ? "step"
    : agentSkill
      ? "agent"
      : recommended
        ? "skill"
        : "default";
  const id = step?.id ?? agentSkill?.id ?? recommended?.id ?? agentModel.id;
  const maxTokens =
    step?.maxTokens ?? agentSkill?.maxTokens ?? recommended?.maxTokens ?? agentModel.maxTokens;
  return { model: { id, maxTokens }, from };
}

/** The model a skill version recommends (an AI skill's own); null for one that names none. */
export function recommendedModel(
  skill: Pick<SkillDefinition, "mode" | "model">,
): ModelChoice | null {
  return skill.mode === "task" ? (skill.model ?? null) : null;
}
