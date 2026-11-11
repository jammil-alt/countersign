// The one seam between this package and the network. Everything above it (record/replay, cost,
// callTool) works the same whether the answer came from the API, a fixture or a FakeModel.

import type { EmbedFn } from "./embeddings";
import type { Message, MessageCreateParams } from "./messages";

export type LlmRequest = MessageCreateParams;
export type LlmMessage = Message;

export interface LlmTransport {
  create(request: LlmRequest, options?: { signal?: AbortSignal }): Promise<LlmMessage>;
  /**
   * §1.88: embeddings, where the provider offers them (OpenAI's); absent elsewhere. Every wrapper
   * of a transport (routing, record/replay, HIPAA's guard) passes it on.
   */
  embed?: EmbedFn;
}
