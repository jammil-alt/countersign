// What the step model's forms read from the server (docs/step-model-plan.md §10c): the action
// catalog (connector › action, area › action), the skills and automations an agent may use, the
// models, and the fields the trigger hands on. The pure part (`usesContextFrom`) is tested alone;
// `useStepsCatalog` is the hook that loads the pieces.

import {
  type ActionCatalog,
  type BuilderCatalog,
  parseSkillRef,
  processes,
  steps,
} from "@countersign/core";
import { useMemo } from "react";
import { apiRoutes } from "../../../api/routes";
import { useApi } from "../../../api/useApi";
import { toolLabel } from "../../workflow/labels";
import type { StepFormEnv } from "./form-kit";
import {
  type AutomationChoice,
  indexCatalog,
  type LoopChoice,
  type SkillChoice,
  type UsesContext,
} from "./options";
import type { Field, MatchProfile, Workflow } from "./types";

export function usesContextFrom(input: {
  actions: ActionCatalog["groups"];
  catalog: Pick<BuilderCatalog, "skills" | "automations">;
  profiles?: readonly MatchProfile[];
}): UsesContext {
  const skills: SkillChoice[] = input.catalog.skills
    // The palette's own: no tool wrappers, no agent-mode skills, nothing that writes. Reshape data
    // is the engine behind the automatic translation on a step's incoming side (§6, §10a), not a
    // step to pick; a stored step that uses it still runs.
    .filter((s) => s.palette !== false && parseSkillRef(s.ref).id !== processes.RESHAPE_SKILL)
    .map((s) => ({
      ref: s.ref,
      name: s.definition.name,
      description: s.definition.description,
      kind: s.kind === "ai" ? ("ai" as const) : ("rules" as const),
      input: steps.fieldsFromSchema(s.definition.input),
      output: steps.fieldsFromSchema(s.definition.output),
      mode: s.definition.mode,
      ...(s.definition.model ? { model: s.definition.model } : {}),
    }));
  // Step model §8: the saved Loops (agent-mode skills with a loop block) are picked by a Loop step,
  // never by a Do step, so the palette's list above leaves them out.
  const loops: LoopChoice[] = input.catalog.skills.flatMap((s) => {
    const loop = s.definition.loop;
    if (!loop) return [];
    return [
      {
        ref: s.ref,
        name: s.definition.name,
        description: s.definition.description,
        goal: loop.goal,
        reads: [...(s.definition.reads ?? [])],
        maxTurns: loop.maxTurns,
        atLimit: loop.atLimit,
        output: steps.fieldsFromSchema(s.definition.output),
        conferFocus: loop.confer?.focus,
        review: loop.review,
      },
    ];
  });
  const automations: AutomationChoice[] = input.catalog.automations.map((a) => ({
    ref: a.ref,
    name: a.name,
    input: [],
    output: steps.fieldsFromSchema(a.outputSchema),
  }));
  return {
    // DECISION: the server sends ids and its own words; the label is the builder's one wording
    // for a tool (`toolLabel`) wherever the server only had the id.
    actions: indexCatalog(input.actions, (id, given) => (given === id ? toolLabel(id) : given)),
    skills,
    automations,
    profiles: input.profiles ?? [],
    loops,
  };
}

/** The fields a workflow's first trigger hands on: a manual start's input, an event's payload. */
export function triggerFields(
  workflow: Pick<Workflow, "triggers">,
  events: readonly { type: string; payload: unknown }[],
): Field[] {
  const on = workflow.triggers[0]?.on as
    | { type: string; event?: string; input?: unknown }
    | undefined;
  if (!on) return [];
  if (on.type === "manual") return steps.fieldsFromSchema(on.input as never);
  if (on.type === "event") {
    return steps.fieldsFromSchema(events.find((e) => e.type === on.event)?.payload as never);
  }
  return [];
}

export interface StepsCatalog {
  ready: boolean;
  error: unknown;
  uses: UsesContext;
  models: StepFormEnv["models"];
  /** Event types a trigger can name: the payload's schema and a sample (Try it starts from it). */
  events: readonly { type: string; payload: unknown; sample?: unknown }[];
  reload(): void;
}

/** Loads what the step model's forms read, for one agent. */
export function useStepsCatalog(agentId: string): StepsCatalog {
  const actions = useApi(apiRoutes.opsActionCatalog, { params: { id: agentId }, life: "catalog" });
  const builder = useApi(apiRoutes.opsBuilderCatalog, { params: { id: agentId }, life: "catalog" });
  const models = useApi(apiRoutes.opsModels, { life: "catalog" });
  const events = useApi(apiRoutes.opsEventCatalog, { life: "catalog" });
  const uses = useMemo(
    () =>
      actions.data && builder.data
        ? usesContextFrom({ actions: actions.data.groups, catalog: builder.data })
        : usesContextFrom({ actions: [], catalog: { skills: [], automations: [] } }),
    [actions.data, builder.data],
  );
  return {
    ready: !!actions.data && !!builder.data,
    error: actions.error ?? builder.error,
    uses,
    // A model list that didn't load leaves the choice at "the default": nothing else depends on it.
    models: (models.data?.models ?? []).map((m) => ({ id: m.id, label: m.label })),
    events: events.data?.events ?? [],
    reload() {
      actions.reload();
      builder.reload();
    },
  };
}
