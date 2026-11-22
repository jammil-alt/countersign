// v0.13 W2-H: which model a skill step runs on (ARCHITECTURE §9.2, §10.11; docs/plan.md §1.53).
//
// Skill model (2026-11-10): core's `effectiveModel` is the one rule. Most specific wins: the
// step's model, then the agent's setting for the skill (`definition.skills[].model`), then the
// skill's recommended model (a `task` skill's own), then the agent's model. `maxTokens` falls
// back along the same order.

import {
  type AgentDefinition,
  type ModelChoice,
  runModel,
  type SkillDefinition,
} from "@countersign/core";

export interface ResolvedModel {
  id: string;
  maxTokens: number;
}

export function resolveModel(
  agentModel: AgentDefinition["model"],
  skill: Pick<SkillDefinition, "mode" | "model">,
  step?: ModelChoice,
  agentSkill?: ModelChoice,
): ResolvedModel {
  // A code skill has no model of its own: the agent's, as before (the loop never runs one). Core's
  // `runModel` is the one rule, shared with the agent's SOP (docs/sop-plan.md §3).
  const resolved = runModel({ agentModel, skill, step, agentSkill });
  return { id: resolved.id, maxTokens: resolved.maxTokens ?? agentModel.maxTokens };
}
