// The skill model (owner, 2026-11-10): a skill version declares parameters (named, typed values:
// a number, text, a date, an amount, or a list of buckets); the agent sets them for its use of the
// skill (`definition.skills[].parameters`), and a step may set its own (its customization). Prefer
// a parameter to a near-duplicate skill: one "Age receivables" with the agent's buckets, not one
// skill per set of buckets.

import type { AgentDefinition } from "../schemas/agent";
import { parseSkillRef } from "../schemas/common";
import type { SkillDefinition } from "../schemas/skill";
import { parameterValueProblem } from "../schemas/skill-model";

/** One problem with an agent's or a step's parameter values. */
export interface ParameterProblem {
  /** The parameter's name, or null for the whole set. */
  name: string | null;
  message: string;
}

/**
 * Why these values don't fit the skill's parameters: an unknown name or a value of the wrong
 * type. With `complete`, every parameter without a default must have a value here.
 */
export function parameterValueProblems(
  def: Pick<SkillDefinition, "parameters">,
  values: Readonly<Record<string, unknown>> | undefined,
  options: { complete?: boolean } = {},
): ParameterProblem[] {
  const out: ParameterProblem[] = [];
  const declared = new Map((def.parameters ?? []).map((p) => [p.name, p]));
  for (const [name, value] of Object.entries(values ?? {})) {
    const param = declared.get(name);
    if (!param) {
      out.push({ name, message: `the skill has no parameter ${name}` });
      continue;
    }
    const problem = parameterValueProblem(param, value);
    if (problem) out.push({ name, message: problem });
  }
  if (options.complete) {
    for (const p of def.parameters ?? []) {
      if (p.default === undefined && values?.[p.name] === undefined) {
        out.push({ name: p.name, message: `set ${p.label} (${p.name}): the skill has no default` });
      }
    }
  }
  return out;
}

/**
 * The parameter values a use of the skill runs with: the skill's defaults, under the agent's,
 * under the step's (most specific wins). Names the skill doesn't declare are left out.
 */
export function resolveSkillParameters(
  def: Pick<SkillDefinition, "parameters">,
  layers: {
    agent?: Readonly<Record<string, unknown>> | undefined;
    step?: Readonly<Record<string, unknown>> | undefined;
  } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.parameters ?? []) {
    const v = layers.step?.[p.name] ?? layers.agent?.[p.name] ?? p.default;
    if (v !== undefined) out[p.name] = v;
  }
  return out;
}

/** The agent's entry for a skill (by id, whatever version it pins). */
export function agentSkillEntry(
  definition: Pick<AgentDefinition, "skills">,
  skillId: string,
): AgentDefinition["skills"][number] | undefined {
  return definition.skills.find((s) => parseSkillRef(s.skill).id === skillId);
}
