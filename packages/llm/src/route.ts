// One transport for every model: each request goes to the provider its model id names. Ids that
// start with `openai:` go to OpenAI, `xai:` to xAI (Grok), `gemini:` to Google (Gemini); every
// other id is an Anthropic model, as before.

import { isGeminiModel } from "./gemini";
import { isOpenAIModel } from "./openai";
import type { LlmTransport } from "./transport";
import { isXaiModel } from "./xai";

export const LLM_PROVIDERS = ["anthropic", "openai", "xai", "google"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const PROVIDER_KEYS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  google: "GEMINI_API_KEY",
};

export function providerOf(model: string): LlmProvider {
  if (isOpenAIModel(model)) return "openai";
  if (isXaiModel(model)) return "xai";
  if (isGeminiModel(model)) return "google";
  return "anthropic";
}

/** A model whose provider has no key configured. The run fails with this message. */
export class ProviderNotConfiguredError extends Error {
  override name = "ProviderNotConfiguredError";
  readonly provider: LlmProvider;
  constructor(provider: LlmProvider, model: string) {
    super(`no ${provider} model is configured for ${model}: set ${PROVIDER_KEYS[provider]}`);
    this.provider = provider;
  }
}

export function routingTransport(
  providers: Partial<Record<LlmProvider, LlmTransport>>,
): LlmTransport {
  return {
    create(request, options) {
      const provider = providerOf(request.model);
      const transport = providers[provider];
      if (!transport)
        return Promise.reject(new ProviderNotConfiguredError(provider, request.model));
      return transport.create(request, options);
    },
  };
}
