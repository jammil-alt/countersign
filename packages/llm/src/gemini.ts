// Google's Gemini models behind the same seam (owner, 2026-11-10: "lets integrate both model").
// This transport translates the platform's one request shape, the Anthropic Messages format, to
// the Gemini API's native generateContent, and the answer back into an Anthropic-shaped message, so
// nothing above the transport knows Google answered. The HTTP side (retries, time limits, errors)
// is ./provider.ts. What is unchecked is in ../NOTES.md.
//
// DECISION (Models: xAI and Gemini): the native generateContent API, not Google's
// OpenAI-compatible endpoint. That endpoint is Chat Completions, not the Responses API our OpenAI
// translation speaks, so it would be a third translation either way; and the native API carries
// what the runtime relies on without an extension field: function calls with their ids and
// thought signatures (which Gemini 3 requires back on the next request of a tool loop), function
// responses, a system instruction, structured output by JSON Schema (`responseJsonSchema`), every
// finish reason (safety and recitation stops become refusals, a prompt block too) and usage with
// cached and thinking tokens apart.

import type Anthropic from "@anthropic-ai/sdk";
import { MODEL_PREFIXES, providerModelName } from "@countersign/core";
import {
  type HttpTransportOptions,
  httpTransport,
  ProviderError,
  type ProviderErrorKind,
  ProviderRequestError,
} from "./provider";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** Model ids that start with this go to Google's Gemini API: `google:gemini-3.1-pro`. */
export const GOOGLE_PREFIX = MODEL_PREFIXES.google;

export function isGoogleModel(model: string): boolean {
  return model.startsWith(GOOGLE_PREFIX);
}

// ---------------------------------------------------------------------------------------------
// generateContent, as much of it as the platform uses.

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  /** A thought summary; only sent when asked for, which we don't. */
  thought?: boolean;
  /** Opaque; Gemini 3 needs it back on the part it came on. */
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  toolConfig?: {
    functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] };
  };
  generationConfig: {
    maxOutputTokens: number;
    thinkingConfig?: { thinkingLevel: "low" | "high" };
    responseMimeType?: "application/json";
    responseJsonSchema?: Record<string, unknown>;
  };
}

export interface GeminiResponse {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
    finishMessage?: string;
    index?: number;
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string } | null;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
    totalTokenCount?: number;
  } | null;
  modelVersion?: string;
  responseId?: string;
}

/** A request the translation can't express for Gemini. */
export class GeminiRequestError extends ProviderRequestError {
  override name = "GeminiRequestError";
}

/** Google answered with an error. */
export class GeminiError extends ProviderError {
  override name = "GeminiError";
  constructor(
    message: string,
    status: number | null,
    code: string | null = null,
    kind?: ProviderErrorKind,
  ) {
    super(message, status, code, kind);
  }
}

const refuse = (what: string) => new GeminiRequestError(`${what} can't go to Gemini`);

// ---------------------------------------------------------------------------------------------
// Thought signatures and call ids.

/**
 * A Gemini thought signature rides in the transcript as an Anthropic thinking block with no text,
 * just before the block it came on, its signature marked with this so only Gemini's go back to
 * Gemini (an Anthropic signature means nothing there).
 */
export const GEMINI_SIGNATURE_PREFIX = "gemini:";

// DECISION (Models: xAI and Gemini): a function call in a transcript that has no signature of
// Gemini's (one the platform wrote itself, as confer, converse and oversight start their loops,
// or a turn from before) carries the value Google documents for calls it did not make, so
// Gemini 3's check on the current turn's calls passes. Unchecked: ../NOTES.md.
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

/** The start of ids we make for calls Gemini gave none; they are never sent back. */
export const GEMINI_CALL_ID_PREFIX = "gemini_call_";

// ---------------------------------------------------------------------------------------------
// Request: Anthropic Messages → generateContent.

function systemText(system: LlmRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

function toolResultValue(block: Anthropic.ToolResultBlockParam): Record<string, unknown> {
  const { content } = block;
  let text: string;
  if (content === undefined) text = "";
  else if (typeof content === "string") text = content;
  else {
    text = content
      .map((c) => {
        if (c.type === "text") return c.text;
        throw refuse(`a tool result with ${c.type} content`);
      })
      .join("\n");
  }
  // A function response is an object; Google's examples put the result under `output` and a
  // failure under `error`, which is how the model tells them apart.
  return block.is_error ? { error: text } : { output: text };
}

function userPart(block: Anthropic.ContentBlockParam): GeminiPart {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image": {
      const s = block.source;
      if (s.type === "base64") return { inlineData: { mimeType: s.media_type, data: s.data } };
      break;
    }
    case "document": {
      const s = block.source;
      if (s.type === "base64") return { inlineData: { mimeType: s.media_type, data: s.data } };
      if (s.type === "text") return { text: s.data };
      break;
    }
  }
  throw refuse(`a ${block.type} block`);
}

function argsOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** The `contents` for a list of Anthropic messages, in order. */
export function toGeminiContents(messages: readonly Anthropic.MessageParam[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  // A function response names its function; a tool_result has only the call's id.
  const names = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      contents.push({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] });
      continue;
    }
    const parts: GeminiPart[] = [];
    if (m.role === "user") {
      for (const block of m.content) {
        if (block.type === "tool_result") {
          const name = names.get(block.tool_use_id);
          if (!name) throw refuse(`a tool result for a call not in the transcript`);
          const id = block.tool_use_id.startsWith(GEMINI_CALL_ID_PREFIX)
            ? {}
            : { id: block.tool_use_id };
          parts.push({ functionResponse: { ...id, name, response: toolResultValue(block) } });
        } else {
          parts.push(userPart(block));
        }
      }
    } else {
      let signature: string | undefined;
      const signed = () => {
        const s = signature ? { thoughtSignature: signature } : {};
        signature = undefined;
        return s;
      };
      for (const block of m.content) {
        if (block.type === "thinking") {
          // Only Gemini's own signatures go back; Anthropic thinking is dropped, as for OpenAI.
          if (block.signature.startsWith(GEMINI_SIGNATURE_PREFIX)) {
            signature = block.signature.slice(GEMINI_SIGNATURE_PREFIX.length);
          }
        } else if (block.type === "redacted_thinking") {
          // Dropped.
        } else if (block.type === "text") {
          parts.push({ text: block.text, ...signed() });
        } else if (block.type === "tool_use") {
          names.set(block.id, block.name);
          const id = block.id.startsWith(GEMINI_CALL_ID_PREFIX) ? {} : { id: block.id };
          parts.push({
            functionCall: { ...id, name: block.name, args: argsOf(block.input) },
            ...signed(),
          });
        } else {
          throw refuse(`an assistant ${block.type} block`);
        }
      }
      const firstCall = parts.find((p) => p.functionCall);
      if (firstCall && !firstCall.thoughtSignature)
        firstCall.thoughtSignature = GEMINI_SKIP_SIGNATURE;
    }
    if (parts.length) contents.push({ role: m.role === "user" ? "user" : "model", parts });
  }
  return contents;
}

function toFunctionDeclaration(
  tool: NonNullable<LlmRequest["tools"]>[number],
): GeminiFunctionDeclaration {
  if (!("input_schema" in tool)) throw refuse(`the server tool ${tool.type}`);
  // DECISION (Models: xAI and Gemini): the tool's JSON Schema goes as `parametersJsonSchema`, not
  // the OpenAPI-subset `parameters`, so the schemas Zod writes (additionalProperties, anyOf, …)
  // go unchanged. Gemini has no strict mode for tools; arguments are checked with Zod as always.
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parametersJsonSchema: tool.input_schema as Record<string, unknown>,
  };
}

function toToolConfig(choice: LlmRequest["tool_choice"]): GeminiRequest["toolConfig"] {
  if (!choice) return undefined;
  // DECISION (Models: xAI and Gemini): Gemini has no switch for parallel calls, so
  // `disable_parallel_tool_use` is dropped; `callTool` takes the first call to its tool and the
  // runtime answers every call, as with any model.
  switch (choice.type) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "any":
      return { functionCallingConfig: { mode: "ANY" } };
    case "tool":
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
  }
}

// DECISION (Models: xAI and Gemini): Gemini 3's thinking levels are low and high; Anthropic's low
// is low and every higher effort is high.
const THINKING: Record<string, "low" | "high"> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "high",
};

export function toGeminiRequest(request: LlmRequest): GeminiRequest {
  const system = systemText(request.system);
  const effort = request.output_config?.effort;
  const format = request.output_config?.format;
  const toolConfig = toToolConfig(request.tool_choice);
  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: toGeminiContents(request.messages),
    ...(request.tools?.length
      ? { tools: [{ functionDeclarations: request.tools.map(toFunctionDeclaration) }] }
      : {}),
    ...(toolConfig ? { toolConfig } : {}),
    generationConfig: {
      maxOutputTokens: request.max_tokens,
      ...(effort ? { thinkingConfig: { thinkingLevel: THINKING[effort] ?? "high" } } : {}),
      ...(format
        ? { responseMimeType: "application/json", responseJsonSchema: format.schema }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Response: generateContent → an Anthropic-shaped message.

// Stops that mean the model or Google's filters would not answer.
const REFUSALS = new Set([
  "SAFETY",
  "RECITATION",
  "LANGUAGE",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
]);

/**
 * The answer as an Anthropic message. `model` is the platform id that was asked for (with its
 * prefix), so pricing and logs name the model the way definitions do.
 */
export function fromGeminiResponse(response: GeminiResponse, request: LlmRequest): LlmMessage {
  const candidate = response.candidates?.[0];
  const blocked = !candidate && Boolean(response.promptFeedback?.blockReason);
  const content: Anthropic.ContentBlock[] = [];
  const callIdBase = `${GEMINI_CALL_ID_PREFIX}${response.responseId ?? crypto.randomUUID()}_`;
  let calls = 0;
  if (blocked) {
    const why = response.promptFeedback?.blockReasonMessage;
    const reason = response.promptFeedback?.blockReason;
    content.push({
      type: "text",
      text: why ?? `Google blocked the request (${reason})`,
      citations: null,
    });
  }
  for (const part of candidate?.content?.parts ?? []) {
    if (part.thought) continue;
    if (part.thoughtSignature) {
      content.push({
        type: "thinking",
        thinking: "",
        signature: `${GEMINI_SIGNATURE_PREFIX}${part.thoughtSignature}`,
      });
    }
    if (part.functionCall) {
      const fc = part.functionCall;
      content.push({
        type: "tool_use",
        id: fc.id || `${callIdBase}${calls}`,
        name: fc.name,
        input: fc.args ?? {},
        caller: { type: "direct" },
      } as Anthropic.ToolUseBlock);
      calls += 1;
    } else if (typeof part.text === "string") {
      const last = content.at(-1);
      // Gemini may split one answer into several text parts; they read as one.
      if (last?.type === "text" && !part.thoughtSignature) last.text += part.text;
      else if (part.text) content.push({ type: "text", text: part.text, citations: null });
    }
  }
  const finish = candidate?.finishReason;
  const stopReason: Anthropic.StopReason =
    blocked || (finish && REFUSALS.has(finish))
      ? "refusal"
      : finish === "MAX_TOKENS"
        ? "max_tokens"
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn";
  const u = response.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  const prompt = (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
  return {
    id: response.responseId ?? "gemini",
    type: "message",
    role: "assistant",
    model: request.model,
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      // Anthropic counts cached input apart from fresh input; Gemini's prompt count includes it.
      input_tokens: Math.max(0, prompt - cached),
      // Billed output is the answer and the thinking together, as Anthropic's output count is.
      output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      // Implicit caching only (no cache is created on purpose), so nothing is written.
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: "standard",
    },
  } as LlmMessage;
}

// ---------------------------------------------------------------------------------------------
// The transport.

/** Google's transport: `GEMINI_API_KEY`, the Gemini API's v1beta unless `baseURL` says otherwise. */
export function geminiTransport(options: HttpTransportOptions): LlmTransport {
  return httpTransport(
    {
      vendor: "Google",
      defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta",
      errorClass: GeminiError,
      url: (base, request) =>
        `${base}/models/${encodeURIComponent(providerModelName(request.model))}:generateContent`,
      headers: (apiKey) => ({ "x-goog-api-key": apiKey }),
      body: toGeminiRequest,
      answer: (json, request) => fromGeminiResponse(json as GeminiResponse, request),
    },
    options,
  );
}
