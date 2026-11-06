// Default models (ARCHITECTURE §2). Agent versions and skills can name another model; these are
// what a definition that names none gets.

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
  /** OpenAI's flagship. The `openai:` prefix routes the call to OpenAI (./route.ts). */
  gpt: "openai:gpt-5.5",
  /** xAI's flagship. The `xai:` prefix routes the call to xAI (./xai.ts). */
  grok: "xai:grok-4.7",
  /** Google's flagship. The `gemini:` prefix routes the call to Google (./gemini.ts). */
  gemini: "gemini:gemini-3.1-pro",
  /** Google's fast model. */
  geminiFlash: "gemini:gemini-3.5-flash",
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
} as const;

export type ModelPurpose = keyof typeof DEFAULT_MODELS;

export const DEFAULT_MODEL: ModelId = DEFAULT_MODELS.reasoning;
