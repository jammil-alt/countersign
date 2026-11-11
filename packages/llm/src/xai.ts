// xAI's models (Grok) behind the same seam (owner, 2026-11-10: "lets integrate both model"). xAI's
// API is OpenAI-compatible: its Responses API at https://api.x.ai/v1/responses takes the requests
// and gives the answers ./openai.ts translates, so this is that translation with xAI's address,
// key and error class, and two differences (`XAI_DIALECT`). What is unchecked is in ../NOTES.md.

import { MODEL_PREFIXES } from "@countersign/core";
import type * as Anthropic from "./messages";
import {
  fromResponsesAnswer,
  type OAResponse,
  type OAResponsesRequest,
  type ResponsesDialect,
  responsesTransport,
  toResponsesInput,
  toResponsesRequest,
} from "./openai";
import {
  type HttpTransportOptions,
  ProviderError,
  type ProviderErrorKind,
  ProviderRequestError,
} from "./provider";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** Model ids that start with this go to xAI: `xai:grok-4.7`. */
export const XAI_PREFIX = MODEL_PREFIXES.xai;

export function isXAIModel(model: string): boolean {
  return model.startsWith(XAI_PREFIX);
}

/** A request the translation can't express for xAI. */
export class XAIRequestError extends ProviderRequestError {
  override name = "XAIRequestError";
}

/** xAI answered with an error, or the answer was a failed response. */
export class XAIError extends ProviderError {
  override name = "XAIError";
  constructor(
    message: string,
    status: number | null,
    code: string | null = null,
    kind?: ProviderErrorKind,
  ) {
    super(message, status, code, kind);
  }
}

// DECISION (Models: xAI and Gemini): xAI on the shared Responses translation, with two
// differences. The system prompt goes first in `input` as a system message, since xAI's
// Responses API documents `instructions` as unsupported; and no `reasoning.effort` is sent, since
// xAI's Grok 4 models reject it (they always reason). Everything else (function calls by
// `call_id`, `function_call_output`, `text.format` json_schema, `store: false`, usage with cached
// input, `incomplete_details`) is OpenAI's shape. Unchecked against xAI's pages: ../NOTES.md.
export const XAI_DIALECT: ResponsesDialect = {
  vendor: "xAI",
  defaultBaseURL: "https://api.x.ai/v1",
  system: "message",
  reasoning: false,
  errorClass: XAIError,
  requestError: XAIRequestError,
};

export function toXAIInput(messages: readonly Anthropic.MessageParam[]) {
  return toResponsesInput(messages, XAI_DIALECT);
}

export function toXAIRequest(request: LlmRequest): OAResponsesRequest {
  return toResponsesRequest(request, XAI_DIALECT);
}

export function fromXAIResponse(response: OAResponse, request: LlmRequest): LlmMessage {
  return fromResponsesAnswer(response, request, XAI_DIALECT);
}

/** xAI's transport: `XAI_API_KEY`, https://api.x.ai/v1 unless `baseURL` says otherwise. */
export function xaiTransport(options: HttpTransportOptions): LlmTransport {
  return responsesTransport(XAI_DIALECT, options);
}
