// What a model step will be sent, before any run (owner, 2026-11-21: "for AI steps… a way to
// look at what the prompt will look like when it comes in"; docs/plan.md §1.180). The back
// office's only: invariant 11 keeps instructions and prompts off every portal route.
import { z } from "zod";
import { defineRoute } from "./contract";

const OPS = ["operator"] as const;
const ApiId = z.string().min(1).max(200);

/** One part of the system prompt, in the order it is sent. */
export const PromptPreviewPart = z.object({
  key: z.enum([
    "governance",
    "finish",
    "identity",
    "agent_instructions",
    "task",
    "settings",
    "parameters",
    "language",
  ]),
  text: z.string(),
});
export type PromptPreviewPart = z.infer<typeof PromptPreviewPart>;

export const StepPromptPreview = z.object({
  /** A model does the step, or it runs by rule rows or as code (then there is no prompt). */
  runs: z.enum(["model", "rules", "code"]),
  skill: z.object({ ref: z.string(), name: z.string(), mode: z.enum(["tool", "task", "agent"]) }),
  /** The model it runs on, as the runtime resolves it; null when no model does it. */
  model: z.object({ id: z.string(), maxTokens: z.number() }).nullable(),
  /** The system prompt's parts, in order: joined with a blank line they are what is sent. */
  system: z.array(PromptPreviewPart),
  /** What the governance part holds: our guardrails, the client's charter, the policies. */
  governance: z.array(
    z.object({ tier: z.string(), source: z.string(), id: z.string(), version: z.string() }),
  ),
  /** The tools the model may call, in the order they are offered. */
  tools: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  /** The words of the first turn; the step's input follows as a tool's result (data). */
  turn: z.string(),
  /** What that result holds beside the input. */
  data: z.object({
    /** Its keys, in order: "input", "memory", "browse", "undiscussed". */
    keys: z.array(z.string()),
    /** The agent's notes: whether this step is given them, and the ones it would get now. */
    memory: z.object({
      /** The agent keeps notes at all (`definition.memory.enabled`). */
      enabled: z.boolean(),
      /** This step is given them (an agent-mode skill of an agent that keeps notes). */
      given: z.boolean(),
      notes: z.array(z.string()),
    }),
  }),
  /** What stops it running as drawn (a parameter with no value, rule rows on a model skill). */
  problems: z.array(z.string()),
});
export type StepPromptPreview = z.infer<typeof StepPromptPreview>;

export const promptPreviewRoutes = {
  opsStepPromptPreview: defineRoute({
    method: "POST",
    path: "/api/ops/agents/:id/prompt-preview",
    auth: "session",
    roles: OPS,
    summary: "What a skill step's model is sent, from the builder's draft, before any run",
    params: z.object({ id: ApiId }),
    body: z.strictObject({
      /** The process being edited (a v4 process; the builder's draft, unsaved). */
      process: z.unknown(),
      stepId: z.string().min(1).max(64),
      /** The agent's definition as drafted; absent: its latest version's. */
      definition: z.unknown().optional(),
    }),
    response: StepPromptPreview,
  }),
};
