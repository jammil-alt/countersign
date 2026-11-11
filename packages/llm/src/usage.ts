import type * as Anthropic from "./messages";

/** Token counts for one call, normalised from the API's usage block. */
export interface LlmUsage {
  /** Uncached input tokens. */
  readonly inputTokens: number;
  /** Output tokens, thinking included (the API's billing total). */
  readonly outputTokens: number;
  /** Input tokens written to the cache (5-minute and 1-hour together). */
  readonly cacheWriteTokens: number;
  /** The part of `cacheWriteTokens` written with a 1-hour TTL. */
  readonly cacheWrite1hTokens: number;
  readonly cacheReadTokens: number;
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};

export function usageOf(message: Pick<Anthropic.Message, "usage">): LlmUsage {
  const u = message.usage;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}
