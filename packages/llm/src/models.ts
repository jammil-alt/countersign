// Default models (ARCHITECTURE §2). Agent versions and skills can name another model; these are
// what a definition that names none gets.

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
  /** OpenAI's flagship. The `openai:` prefix routes the call to OpenAI (./route.ts). */
  gpt: "openai:gpt-5.5",
} as const;

export type ModelId = string;

/** What each kind of work runs on unless a definition says otherwise. */
export const DEFAULT_MODELS = {
  /** Extraction, agent reasoning, the Builder. */
  reasoning: MODELS.sonnet,
  extraction: MODELS.sonnet,
  builder: MODELS.sonnet,
  /** High-volume classification and adjudication (e.g. item matching). */
  classification: MODELS.haiku,
  /** Optional, for the Builder on complex requests. */
  builderComplex: MODELS.opus,
  /**
   * §1.77: `web.search` and `web.fetch`, one search or fetch through the vendor's server-side
   * tools; the agent that asked reasons over the results on its own model.
   */
  research: MODELS.haiku,
} as const;

export type ModelPurpose = keyof typeof DEFAULT_MODELS;

export const DEFAULT_MODEL: ModelId = DEFAULT_MODELS.reasoning;
