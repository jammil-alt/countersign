// What the Builder answers in the step model (docs/step-model-plan.md §10, build item 9): an agent
// bundle whose workflows are all v5 workflows, with the draft's summary, gaps and decisions. The
// shapes around the bundle are the v4 Builder's (`../builder`), so the build flow, the gap steps and
// the decisions read a v5 draft the same way.

import { AgentBundle, BundleWorkflow, DecisionAnswer, steps } from "@countersign/core";
import { z } from "zod";

/**
 * A bundle whose every workflow is in the step model (`schemaVersion: 5`): what the Builder drafts
 * and answers. Its value is an `AgentBundle`, so it is saved, hashed and validated as any other.
 */
// DECISION: defined here, not in core's `schemas/agent.ts` (stream A's): it is the Builder's answer
// shape, as `ProcessAgentBundle` was for v4, and it goes with v4 in wave 4 when this is the only one.
export const StepAgentBundle = AgentBundle.extend({
  workflows: z.array(BundleWorkflow.extend({ workflow: steps.Workflow })),
}).meta({ id: "StepAgentBundle" });
export type StepAgentBundle = z.infer<typeof StepAgentBundle>;
export type StepAgentBundleInput = z.input<typeof StepAgentBundle>;

const Summary = z
  .string()
  .min(1)
  .max(2000)
  .describe("What the agent does and how its workflow runs, in a few plain sentences");
const Gaps = z
  .array(z.string().min(1).max(500))
  .max(30)
  .describe("Capabilities it needs that are not in the catalog, one plain sentence each");

export const StepDraftAnswer = z.object({
  summary: Summary,
  gaps: Gaps,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64)
    .optional()
    .describe("A short address for the agent, lowercase words and dashes"),
  startFromTemplate: z
    .string()
    .nullable()
    .optional()
    .describe("The slug of an existing template that already does most of this, else null"),
  serviceName: z
    .string()
    .max(200)
    .optional()
    .describe("Client agents: what the client sees the service called"),
  serviceDescription: z
    .string()
    .max(2000)
    .optional()
    .describe("Client agents: one or two sentences the client sees"),
  bundle: StepAgentBundle,
  decisions: z
    .array(DecisionAnswer)
    .max(30)
    .optional()
    .describe(
      "The decisions you made to draft the normal case, one row each (what, why, value, kind, risk, the step it shapes)",
    ),
  gapSteps: z
    .array(
      z.object({
        gap: z.number().int().min(0).max(29).describe("The gap's place in gaps, from 0"),
        stepId: z.string().min(1).max(200).describe("The id of the step that stands for it"),
      }),
    )
    .max(30)
    .optional()
    .describe(
      "For each gap a step of the draft stands for (a person step that does it for now, or a \"Not built yet\" step): the gap's place in gaps and that step's id",
    ),
});
export type StepDraftAnswer = z.infer<typeof StepDraftAnswer>;

export const StepReviseAnswer = z.object({
  summary: z.string().min(1).max(2000).describe("What changed and why, in a few plain sentences"),
  gaps: Gaps,
  changeNote: z.string().min(1).max(300).describe("One line for the version history"),
  bundle: StepAgentBundle,
});
export type StepReviseAnswer = z.infer<typeof StepReviseAnswer>;
