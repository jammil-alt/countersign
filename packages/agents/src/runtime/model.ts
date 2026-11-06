// v0.13 W2-H: which model a skill step runs on (ARCHITECTURE §9.2, §10.11; docs/plan.md §1.53).
//
// A `task` skill runs on its own model, the same in any agent; an `agent` skill runs on the
// agent's. A step may override either. `maxTokens` falls back along the same order.

import type { AgentDefinition, ModelChoice, SkillDefinition } from "@countersign/core";

export interface ResolvedModel {
  id: string;
  maxTokens: number;
}

export function resolveModel(
  agentModel: AgentDefinition["model"],
  skill: Pick<SkillDefinition, "mode" | "model">,
  step?: ModelChoice,
): ResolvedModel {
  const own = skill.mode === "task" ? skill.model : undefined;
  return {
    id: step?.id ?? own?.id ?? agentModel.id,
    maxTokens: step?.maxTokens ?? own?.maxTokens ?? agentModel.maxTokens,
  };
}
