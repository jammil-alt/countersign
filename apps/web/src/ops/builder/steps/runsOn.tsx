// Which model an AI step runs on, and the field that picks one (owner, 2026-11-26: "the design
// before these changes had the model show up in the cards for AI steps… we should be able to select
// a model per step as well"). The v4 builder showed it on every AI box and let each step pick one;
// the step model kept a picker only under More, for AI written in the step, and the box showed a
// model only when one was set. Most specific wins, as at run time (core's `effectiveModel`): the
// step's own, then the agent's setting for that skill, then the skill's recommended model, then the
// agent's own model.
import {
  effectiveModel,
  MODEL_SOURCE_WORDS,
  type ModelSource,
  parseSkillRef,
} from "@countersign/core";
import { SmallSelect } from "../fields";
import type { StepFormEnv } from "./form-kit";
import type { UsesContext } from "./options";
import type { Step } from "./types";

type ModelChoice = { id: string; maxTokens?: number | undefined };

/** The agent's own model and its per-skill settings (`definition.model`, `definition.skills`). */
export interface AgentModels {
  model: ModelChoice;
  skills?: readonly { id: string; model?: ModelChoice | undefined }[] | undefined;
}

/** Reads them from a stored bundle's definition; null where it names no model. */
export function agentModelsOf(bundle: unknown): AgentModels | null {
  const def = (bundle as { definition?: { model?: ModelChoice; skills?: unknown } } | null)
    ?.definition;
  if (!def?.model?.id) return null;
  const skills = Array.isArray(def.skills)
    ? (def.skills as { id?: unknown; model?: ModelChoice }[])
        .filter((s): s is { id: string; model?: ModelChoice } => typeof s.id === "string")
        .map((s) => ({ id: s.id, ...(s.model ? { model: s.model } : {}) }))
    : [];
  return { model: def.model, skills };
}

/** Whether a step runs on a model it picks: an AI Do (written in the step or an AI skill), a Loop. */
export function picksModel(step: Step): boolean {
  if (step.kind === "loop") return true;
  return (
    step.kind === "do" &&
    step.doneBy === "ai" &&
    (step.uses === undefined || step.uses.type === "skill")
  );
}

/** The model a step runs on and where that came from; null for a step no model it picks runs. */
export function runsOn(
  step: Step,
  ctx: UsesContext,
  agent: AgentModels | null | undefined,
): { id: string; from: ModelSource } | null {
  if (!agent || !picksModel(step)) return null;
  if (step.kind === "loop") {
    return step.model
      ? { id: step.model.id, from: "step" }
      : { id: agent.model.id, from: "default" };
  }
  if (step.kind !== "do") return null;
  const ref = step.uses?.type === "skill" ? step.uses.skill : null;
  const skill = ref ? ctx.skills.find((s) => s.ref === ref) : undefined;
  const id = ref ? parseSkillRef(ref).id : null;
  const out = effectiveModel({
    // Written in the step: an AI skill of the agent's own, with no recommended model.
    skill: {
      mode: (skill?.mode ?? "task") as never,
      ...(skill?.model ? { model: skill.model } : {}),
    },
    agentModel: agent.model,
    agentSkill: id ? agent.skills?.find((s) => s.id === id)?.model : undefined,
    step: step.ai?.model,
  });
  return out ? { id: out.model.id, from: out.from } : null;
}

/** "Runs on": the model picked here, or the default it falls back to, named with where it is from. */
export function ModelField({
  step,
  env,
  value,
  onPick,
}: {
  step: Step;
  env: StepFormEnv;
  /** The model set on this step, if any. */
  value: string | undefined;
  onPick(id: string | null): void;
}) {
  const label = (id: string) => env.models.find((m) => m.id === id)?.label ?? id;
  // What runs when this step sets none: worked out as if it named no model.
  const fallback = runsOn(
    step.kind === "loop"
      ? (() => {
          const { model: _m, ...rest } = step;
          return rest as Step;
        })()
      : step.kind === "do"
        ? ({ ...step, ai: { ...step.ai, model: undefined } } as Step)
        : step,
    env.uses,
    env.agentModels,
  );
  return (
    <div className="flex flex-col gap-1 text-sm text-ink" data-testid="step-model">
      <span>Runs on</span>
      <SmallSelect
        aria-label="Runs on"
        data-testid="step-model-select"
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
      >
        <option value="">
          {fallback
            ? `${label(fallback.id)} (${MODEL_SOURCE_WORDS[fallback.from]})`
            : "The default model"}
        </option>
        {env.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </SmallSelect>
      <span className="text-xs text-ink-muted">
        {value
          ? "Set on this step: it runs on this model whatever the skill or the agent says."
          : "Pick one to run this step on another model, for cost or for quality."}
      </span>
    </div>
  );
}
