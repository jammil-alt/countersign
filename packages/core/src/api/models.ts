import { z } from "zod";
import { defineRoute } from "./contract";

// v0.13 W2-H: the models a task skill or a skill step may name (ARCHITECTURE §10.11, docs/plan.md
// §1.53). Operator only: prices are cost, which no portal route returns (invariant 11).

// ── Providers ───────────────────────────────────────────────────────────────────────────────────

/**
 * Who answers a model id. A prefix names the provider (`openai:gpt-5.5`, `xai:grok-4.7`,
 * `google:gemini-3.1-pro`); an id with none is Anthropic's. packages/llm routes calls by it,
 * compliance names the vendor by it, and the back office shows its name.
 */
export const MODEL_PROVIDERS = ["anthropic", "openai", "xai", "google"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The prefix of each provider's ids; Anthropic's ids have none. */
export const MODEL_PREFIXES: Readonly<Record<Exclude<ModelProvider, "anthropic">, string>> = {
  openai: "openai:",
  xai: "xai:",
  google: "google:",
};

/** How people see each provider. */
export const MODEL_PROVIDER_NAMES: Readonly<Record<ModelProvider, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  google: "Google",
};

const PREFIXED = Object.entries(MODEL_PREFIXES) as [Exclude<ModelProvider, "anthropic">, string][];

/** A model id's provider: the one its prefix names, else Anthropic. */
export function modelProvider(modelId: string): ModelProvider {
  return PREFIXED.find(([, prefix]) => modelId.startsWith(prefix))?.[0] ?? "anthropic";
}

/** The id the provider knows the model by: the platform id without its prefix. */
export function providerModelName(modelId: string): string {
  const provider = modelProvider(modelId);
  return provider === "anthropic" ? modelId : modelId.slice(MODEL_PREFIXES[provider].length);
}

export const ModelOption = z.object({
  id: z.string(),
  /**
   * The builder's label: Fast (Haiku), Standard (Sonnet), Strong (Opus), and the other providers'
   * models by provider and name (OpenAI (GPT), xAI (Grok 4.7), Google (Gemini 3.1 Pro)).
   */
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
