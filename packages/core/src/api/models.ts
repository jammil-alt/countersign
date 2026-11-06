import { z } from "zod";
import { defineRoute } from "./contract";

// v0.13 W2-H: the models a task skill or a skill step may name (ARCHITECTURE §10.11, docs/plan.md
// §1.53). Operator only: prices are cost, which no portal route returns (invariant 11).

export const ModelOption = z.object({
  id: z.string(),
  /** The builder's label: Fast (Haiku), Standard (Sonnet), Strong (Opus), OpenAI. */
  label: z.string(),
  /** USD per million tokens, as decimal strings. */
  inputPerMtok: z.string(),
  outputPerMtok: z.string(),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const modelRoutes = {
  opsModels: defineRoute({
    method: "GET",
    path: "/api/ops/models",
    auth: "session",
    roles: ["operator"],
    summary: "Models a task skill or a skill step may run on, cheapest first, with prices",
    response: z.object({ models: z.array(ModelOption) }),
  }),
} as const;
