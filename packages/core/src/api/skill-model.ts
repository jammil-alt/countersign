// The skill model (owner, 2026-11-10; ARCHITECTURE §10.14, docs/plan.md §1.86 "Skill model"): what
// the back office reads about a skill's kind, parameters and model, and the builder's question
// "what moves if this step goes to vN". Operator only (invariant 11): no portal route returns a
// skill's definition, model or prompt.

import { z } from "zod";
import { ModelChoice } from "../schemas/skill";
import { SkillParameter } from "../schemas/skill-model";
import { SKILL_KINDS } from "../skills/kind";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

export const SkillKindSchema = z.enum(SKILL_KINDS);

/** A skill's kind and the facts that go with it, wherever a skill is listed. */
export const SkillModelFacts = z.object({
  /** Deterministic (rules or built-in code) or AI (instructions and a model). */
  kind: SkillKindSchema,
  /** "Deterministic" or "AI": the label shown everywhere. */
  kindLabel: z.string(),
  /** The tools it calls that call a model inside (why built-in code is labelled AI). */
  modelTools: z.array(z.string()),
  /** The version's parameters, values set per agent and per step. */
  parameters: z.array(SkillParameter),
  /** An AI skill's recommended model; null for a deterministic one or one on the agent's model. */
  recommendedModel: ModelChoice.nullable(),
});
export type SkillModelFacts = z.infer<typeof SkillModelFacts>;

export const SkillBreakView = z.object({
  kind: z.enum([
    "removed",
    "type_changed",
    "now_optional",
    "required_added",
    "parameter_removed",
    "parameter_type_changed",
    "parameter_required_added",
  ]),
  side: z.enum(["input", "output", "parameter"]),
  field: z.string(),
  renamedTo: z.string().optional(),
  message: z.string(),
});

export const SkillStepReferenceView = z.object({
  stepId: z.string(),
  at: z.string(),
  expr: z.string(),
  field: z.string(),
});

/** What moving one skill step to another version of its skill does to the process. */
export const SkillMoveView = z.object({
  from: z.string(),
  to: z.string(),
  /** True: it moves in one click. False: remap `references` (and fix `errors`) first. */
  compatible: z.boolean(),
  breaks: z.array(SkillBreakView),
  references: z.array(SkillStepReferenceView),
  /** Validation errors the move would add, as the builder and publish report them. */
  errors: z.array(
    z.object({
      stepId: z.string().nullable(),
      field: z.string(),
      message: z.string(),
      code: z.string(),
    }),
  ),
  /** The definition the step would run (instructions left out), for the builder to type with. */
  definition: z.unknown(),
  facts: SkillModelFacts,
});
export type SkillMoveView = z.infer<typeof SkillMoveView>;

export const skillModelRoutes = {
  opsSkillStepMove: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/skill-move",
    auth: "session",
    roles: OPS,
    summary: "What moves if a skill step goes to another version of its skill (the builder asks)",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      /** The process being edited (a v4 process; the builder's draft, unsaved). */
      process: z.unknown(),
      /** The skill step to move. */
      stepId: z.string().min(1).max(64),
      /** The reference to move it to: `custom:x@2`, or `custom:x` to follow the live version. */
      to: z.string().min(1).max(200),
    }),
    response: SkillMoveView,
  }),
};
