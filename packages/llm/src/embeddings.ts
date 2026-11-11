// Embeddings (docs/plan.md §1.88): vectors for short product text, so the vendor catalog can be
// searched by meaning. One request shape for every provider that offers them (OpenAI's today),
// carried by the same transport as model calls (`LlmTransport.embed`), so routing by model id,
// record/replay, HIPAA's guard and cost work the same way. Plain fetch, no SDK.
//
// DECISION (owner left it to us, 2026-11-11): OpenAI's text-embedding-3-large at 1,024
// dimensions, the size of `catalog_item.embedding` and `vendor_item.embedding`; the model and its
// price are unchecked (../NOTES.md).

import { Decimal } from "@countersign/core";
import type { ModelId } from "./models";

/** The embedding models we may call, by platform id (`openai:` routes to OpenAI). */
export const EMBEDDING_MODELS = {
  large: "openai:text-embedding-3-large",
  small: "openai:text-embedding-3-small",
} as const;

/** What the vendor catalog embeds with, and the size of its vector columns. */
export const DEFAULT_EMBEDDING_MODEL: ModelId = EMBEDDING_MODELS.large;
export const EMBEDDING_DIMENSIONS = 1024;

/** At most this many texts in one call (OpenAI takes 2,048; we keep calls small). */
export const EMBED_BATCH_MAX = 100;

/** USD per million input tokens, as decimal strings (embeddings have no output tokens). */
// DECISION: OpenAI's list prices as we knew them ($0.13 per 1M tokens for -3-large, $0.02 for
// -3-small), unverified like every price in ./pricing.ts.
export const EMBEDDING_PRICES: Readonly<Record<ModelId, string>> = {
  [EMBEDDING_MODELS.large]: "0.13",
  [EMBEDDING_MODELS.small]: "0.02",
};

export interface EmbedRequest {
  readonly model: ModelId;
  readonly input: readonly string[];
  readonly dimensions: number;
}

export interface EmbedResponse {
  /** The model that answered, as the provider names it. */
  readonly model: string;
  /** One vector per input, in the input's order. */
  readonly embeddings: number[][];
  readonly usage: { readonly inputTokens: number };
}

export type EmbedFn = (
  request: EmbedRequest,
  options?: { signal?: AbortSignal },
) => Promise<EmbedResponse>;

/** USD with 6 places for one embedding call, or null when the model has no price. */
export function embeddingCostOf(
  model: ModelId,
  inputTokens: number,
  prices: Readonly<Record<ModelId, string>> = EMBEDDING_PRICES,
): string | null {
  const price = prices[model];
  if (price === undefined) return null;
  return new Decimal(String(Math.max(0, Math.round(inputTokens))))
    .mul(price)
    .div(1_000_000)
    .toDecimalPlaces(6)
    .toFixed(6);
}

/** A transport (or a provider) that offers no embeddings. */
export class EmbeddingsNotSupportedError extends Error {
  override name = "EmbeddingsNotSupportedError";
}

/** The answer doesn't fit the request: a vector missing, or of another size. */
export class EmbeddingShapeError extends Error {
  override name = "EmbeddingShapeError";
}

/** Checks an answer against its request; vectors must be finite numbers of the asked size. */
export function checkEmbeddings(request: EmbedRequest, response: EmbedResponse): EmbedResponse {
  if (response.embeddings.length !== request.input.length) {
    throw new EmbeddingShapeError(
      `asked for ${request.input.length} embeddings, got ${response.embeddings.length}`,
    );
  }
  for (const v of response.embeddings) {
    if (v.length !== request.dimensions || v.some((x) => !Number.isFinite(x))) {
      throw new EmbeddingShapeError(
        `an embedding is not ${request.dimensions} finite numbers (got ${v.length})`,
      );
    }
  }
  return response;
}

// ── OpenAI's wire (POST /v1/embeddings) ──────────────────────────────────────────────────────────

export interface OAEmbeddingsRequest {
  model: string;
  input: string[];
  dimensions: number;
  encoding_format: "float";
}

export interface OAEmbeddingsResponse {
  object?: string;
  data: { object?: string; index: number; embedding: number[] }[];
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number } | null;
}

export function toOpenAIEmbeddingsRequest(
  request: EmbedRequest,
  modelName: string,
): OAEmbeddingsRequest {
  return {
    model: modelName,
    input: [...request.input],
    dimensions: request.dimensions,
    encoding_format: "float",
  };
}

export function fromOpenAIEmbeddings(
  json: OAEmbeddingsResponse,
  request: EmbedRequest,
): EmbedResponse {
  const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
  return checkEmbeddings(request, {
    model: json.model ?? request.model,
    embeddings: data.map((d) => d.embedding),
    usage: { inputTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0 },
  });
}
