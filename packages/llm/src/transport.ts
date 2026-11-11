// The one seam between this package and the network. Everything above it (record/replay, cost,
// callTool) works the same whether the answer came from the API, a fixture or a FakeModel.

import Anthropic from "@anthropic-ai/sdk";
import type { EmbedFn } from "./embeddings";

export type LlmRequest = Anthropic.MessageCreateParamsNonStreaming;
export type LlmMessage = Anthropic.Message;

export interface LlmTransport {
  create(request: LlmRequest, options?: { signal?: AbortSignal }): Promise<LlmMessage>;
  /**
   * §1.88: embeddings, where the provider offers them (OpenAI's); absent elsewhere. Every wrapper
   * of a transport (routing, record/replay, HIPAA's guard) passes it on.
   */
  embed?: EmbedFn;
}

export interface AnthropicTransportOptions {
  readonly apiKey: string;
  /** Injected so a Worker, a test or a proxy decides how requests leave. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/**
 * The live transport: `@anthropic-ai/sdk` over fetch, so it runs in Workers with no Node APIs.
 *
 * Requests are streamed and collected with `finalMessage()`: agent and extraction calls can run for
 * a minute or more, and a streamed request is not cut off by the SDK's non-streaming time limit.
 */
export function anthropicTransport(options: AnthropicTransportOptions): LlmTransport {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 2,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    // DECISION: no OpenTelemetry from the SDK. Since 0.134 it makes spans with, and sends trace
    // headers from, any tracer or propagator registered globally; we keep what 0.125 did (none),
    // as model calls stay out of traces (apps/api/src/observability/sentry.ts).
    openTelemetry: { traces: false, propagation: false },
  });
  return {
    async create(request, opts) {
      const stream = client.messages.stream(request, opts?.signal ? { signal: opts.signal } : {});
      return stream.finalMessage();
    },
  };
}
