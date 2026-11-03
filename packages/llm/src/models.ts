// Default models (ARCHITECTURE §2). Agent versions and skills can name another model; these are
// what a definition that names none gets.

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
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
