// One transport for every model: each request goes to the provider its model id names. Ids that
// start with `openai:` go to OpenAI, `xai:` to xAI, `google:` to Google's Gemini API; every other
// id is an Anthropic model, as before. The prefixes are core's (`modelProvider`), so compliance
// and the back office read a model's provider the same way.

import { type ModelProvider, modelProvider } from "@countersign/core";
import { EmbeddingsNotSupportedError } from "./embeddings";
import type { LlmTransport } from "./transport";

export type LlmProvider = ModelProvider;

/** The Worker secret each provider's key is in. */
export const PROVIDER_KEYS: Readonly<Record<LlmProvider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  google: "GEMINI_API_KEY",
};

export function providerOf(model: string): LlmProvider {
  return modelProvider(model);
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
    // §1.88: embeddings go where their model id says, like any call.
    embed(request, options) {
      const provider = providerOf(request.model);
      const transport = providers[provider];
      if (!transport)
        return Promise.reject(new ProviderNotConfiguredError(provider, request.model));
      if (!transport.embed) {
        return Promise.reject(
          new EmbeddingsNotSupportedError(`${provider} offers no embeddings (${request.model})`),
        );
      }
      return transport.embed(request, options);
    },
  };
}
