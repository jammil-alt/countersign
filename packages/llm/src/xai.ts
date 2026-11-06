// xAI's Grok models behind the same seam as Anthropic's and OpenAI's (owner, 2026-11-06: "build
// Grok as well as Gemini so users can select any model they want"). xAI serves the Responses API,
// so this is OpenAI's translation (./openai.ts) pointed at api.x.ai, with one difference: Grok's
// models reason on their own and refuse a `reasoning.effort`, so effort is not sent.

import type { HttpTransportOptions } from "./http";
import { type ResponsesDialect, responsesTransport } from "./openai";
import type { LlmTransport } from "./transport";

/** Model ids that start with this go to xAI: `xai:grok-4.7`. */
export const XAI_PREFIX = "xai:";

export function isXaiModel(model: string): boolean {
  return model.startsWith(XAI_PREFIX);
}

/** The id xAI knows the model by: the platform id without its prefix. */
export function xaiModelName(model: string): string {
  return isXaiModel(model) ? model.slice(XAI_PREFIX.length) : model;
}

// DECISION: no reasoning effort for Grok. xAI's current models choose their own reasoning and
// answer 400 to `reasoning.effort`; a step's effort setting is ignored for them.
export const XAI_DIALECT: ResponsesDialect = { modelName: xaiModelName, reasoningEffort: false };

export type XaiTransportOptions = HttpTransportOptions;

export function xaiTransport(options: XaiTransportOptions): LlmTransport {
  return responsesTransport(
    { vendor: "xAI", defaultBaseURL: "https://api.x.ai/v1", dialect: XAI_DIALECT },
    options,
  );
}
