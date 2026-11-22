// Default models (ARCHITECTURE §2). Agent versions and skills can name another model; these are
// what a definition that names none gets.

export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
  /** OpenAI's flagship. The `openai:` prefix routes the call to OpenAI (./route.ts). */
  gpt: "openai:gpt-5.5",
  /** xAI's flagship. The `xai:` prefix routes the call to xAI (./xai.ts). Id unchecked: NOTES.md. */
  grok: "xai:grok-4.7",
  /** Google's Gemini Pro. The `google:` prefix routes the call to Gemini (./gemini.ts). Id unchecked. */
  geminiPro: "google:gemini-3.1-pro",
  /** Google's cheap Gemini. Id unchecked: NOTES.md. */
  geminiFlashLite: "google:gemini-3.5-flash-lite",
} as const;

export type ModelId = string;

/** How hard the Builder thinks (`output_config.effort`): Opus 5.5's default is medium. */
export const BUILDER_EFFORT = "high" as const;

/** What each kind of work runs on unless a definition says otherwise. */
export const DEFAULT_MODELS = {
  /** Extraction and agent reasoning. */
  reasoning: MODELS.sonnet,
  extraction: MODELS.sonnet,
  /**
   * The Builder: every step of a build and the workflow's Builder. Opus at high effort
   * (`BUILDER_EFFORT`): a back office's agent is built rarely and has to be right, so a slower,
   * more thorough Builder is worth it (owner, 2026-11-17).
   */
  // DECISION (owner, 2026-11-17): "getting this right upfront is a much better option". Opus 5.5
  // for the Builder everywhere; the test cases (apps/api/src/evals) judge a change of model.
  builder: MODELS.opus,
  /** Reggie, the operator's account agent (docs/plan.md §1.101). */
  reggie: MODELS.sonnet,
  /** High-volume classification and adjudication (e.g. item matching). */
  classification: MODELS.haiku,
  /** The judge of the Builder's test cases (apps/api/src/evals). */
  builderComplex: MODELS.opus,
  /**
   * §1.77: `web.search` and `web.fetch`, one search or fetch through the vendor's server-side
   * tools; the agent that asked reasons over the results on its own model.
   */
  research: MODELS.haiku,
  /**
   * §1.168: Draft, one long text field written from the operator's notes. The Builder's vendor
   * on its faster model: a field is short and the operator reads it before using it.
   */
  // DECISION: Sonnet, not the Builder's Opus: a draft is waited on in a sheet, and is a short
  // rewrite of the operator's own notes rather than a build.
  assist: MODELS.sonnet,
} as const;

export type ModelPurpose = keyof typeof DEFAULT_MODELS;

export const DEFAULT_MODEL: ModelId = DEFAULT_MODELS.reasoning;

/**
 * A model's name as a client reads it in an agent's SOP (docs/sop-plan.md §3): its own name, which
 * says its maker (Claude, GPT, Grok, Gemini). Never its price, effort or id. Null for a model with no
 * client name, which the SOP calls "An AI model".
 */
const CLIENT_MODEL_NAMES: Readonly<Record<string, string>> = {
  [MODELS.gpt]: "GPT-5.5",
  [MODELS.grok]: "Grok 4.7",
  [MODELS.geminiPro]: "Gemini 3.1 Pro",
  [MODELS.geminiFlashLite]: "Gemini 3.5 Flash-Lite",
};

export function clientModelName(id: string): string | null {
  const named = CLIENT_MODEL_NAMES[id];
  if (named) return named;
  // Claude: "claude-sonnet-5-5" → "Claude Sonnet 5.5", any version, so older ids keep a name.
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (claude) {
    const [, family = "", major, minor] = claude;
    return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
  }
  return null;
}
