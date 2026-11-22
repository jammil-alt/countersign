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

const PARTIAL = Symbol.for("countersign.llm.partialUsage");

/**
 * §1.210: a failed call's usage, carried on its error: a stream that broke or was stopped
 * mid-answer was billed for what it used (its input, the cache, the output so far), so the
 * client records that rather than nothing. Returns the error itself (an object), marked.
 */
export function withPartialUsage<E>(error: E, usage: LlmUsage, model: string | null): E {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, PARTIAL, { value: { usage, model }, enumerable: false });
  }
  return error;
}

/** The usage a failed call's error carries, if any. */
export function partialUsageOf(error: unknown): { usage: LlmUsage; model: string | null } | null {
  if (error === null || typeof error !== "object") return null;
  const v = (error as Record<symbol, unknown>)[PARTIAL];
  return v ? (v as { usage: LlmUsage; model: string | null }) : null;
}
