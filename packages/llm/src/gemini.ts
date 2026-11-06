// Google's Gemini models behind the same seam as Anthropic's and OpenAI's (owner, 2026-11-06:
// "build Grok as well as Gemini so users can select any model they want"). The platform speaks the
// Anthropic Messages format; this transport translates it to the Gemini API's `generateContent`
// and the answer back into an Anthropic-shaped message, so the client, `callTool`, the agent
// runtime, cost and record/replay stay provider-blind (as ./openai.ts does for OpenAI).
//
// Plain fetch, no SDK: the Worker stays light and a test can pass its own fetch.

import type Anthropic from "@anthropic-ai/sdk";
import { apiRoot, errorDetail, type HttpTransportOptions, postJson } from "./http";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** Model ids that start with this go to Google: `gemini:gemini-3.1-pro`. */
export const GEMINI_PREFIX = "gemini:";

export function isGeminiModel(model: string): boolean {
  return model.startsWith(GEMINI_PREFIX);
}

/** The id Google knows the model by: the platform id without its prefix. */
export function geminiModelName(model: string): string {
  return isGeminiModel(model) ? model.slice(GEMINI_PREFIX.length) : model;
}

// ---------------------------------------------------------------------------------------------
// The Gemini API, as much of it as the platform uses.

export type GPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string }; thoughtSignature?: string }
  | {
      functionCall: { id?: string; name: string; args?: Record<string, unknown> };
      thoughtSignature?: string;
    }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } };

export interface GContent {
  role: "user" | "model";
  parts: GPart[];
}

export interface GFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface GRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GContent[];
  tools?: { functionDeclarations: GFunctionDeclaration[] }[];
  toolConfig?: {
    functionCallingConfig: { mode: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] };
  };
  generationConfig: {
    maxOutputTokens: number;
    responseMimeType?: "application/json";
    responseJsonSchema?: Record<string, unknown>;
    thinkingConfig?: { thinkingLevel: "low" | "high" };
  };
}

export interface GResponse {
  responseId?: string;
  modelVersion?: string;
  candidates?: {
    content?: { role?: string; parts?: GPart[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string } | null;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  } | null;
}

/** A request the translation can't express. A programming error, not a model failure. */
export class GeminiRequestError extends Error {
  override name = "GeminiRequestError";
}

/** Google answered with an error, or blocked the prompt. */
export class GeminiError extends Error {
  override name = "GeminiError";
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Thought signatures.
//
// Gemini's thinking models sign each function call they make, and expect the signature back on
// that call in the next request; a call sent back unsigned is refused. Anthropic's message shape
// already carries opaque signatures between turns, on `thinking` blocks, and the runtime echoes
// an answer's blocks back as they came. So a signature comes back as an empty thinking block just
// before the block it signs, marked as Gemini's so no other provider's signature is mistaken for
// one.

const SIGNATURE_MARK = "gemini:";

// DECISION: a function call with no signature of ours (a transcript started on another model,
// or a scripted turn like the oversight review's first read) is sent with the bypass value
// Google documents for that case, rather than refused.
export const UNSIGNED_CALL = "skip_thought_signature_validator";

function signatureBlock(signature: string): Anthropic.ThinkingBlock {
  return { type: "thinking", thinking: "", signature: `${SIGNATURE_MARK}${signature}` };
}

function ownSignature(block: { signature?: string }): string | undefined {
  const s = block.signature;
  return s?.startsWith(SIGNATURE_MARK) ? s.slice(SIGNATURE_MARK.length) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Request: Anthropic Messages → generateContent.

function systemText(system: LlmRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system || undefined;
  return system.map((b) => b.text).join("\n\n") || undefined;
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const { content } = block;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if (c.type === "text") return c.text;
      throw new GeminiRequestError(`a tool result with ${c.type} content can't go to Gemini`);
    })
    .join("\n");
}

function userPart(block: Anthropic.ContentBlockParam): GPart {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image":
      if (block.source.type === "base64") {
        return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
      }
      break;
    case "document":
      if (block.source.type === "base64") {
        return { inlineData: { mimeType: block.source.media_type, data: block.source.data } };
      }
      if (block.source.type === "text") return { text: block.source.data };
      break;
  }
  const source = "source" in block ? ` (${(block.source as { type: string }).type} source)` : "";
  throw new GeminiRequestError(`a ${block.type} block${source} can't go to Gemini`);
}

/** The Gemini `contents` for a list of Anthropic messages, in order. */
export function toGeminiContents(messages: readonly Anthropic.MessageParam[]): GContent[] {
  const contents: GContent[] = [];
  // A function response names its function; Anthropic's names only the call's id.
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      contents.push({ role: m.role === "user" ? "user" : "model", parts: [{ text: m.content }] });
      continue;
    }
    const parts: GPart[] = [];
    if (m.role === "user") {
      for (const block of m.content) {
        if (block.type === "tool_result") {
          const name = toolNames.get(block.tool_use_id);
          if (!name) {
            throw new GeminiRequestError(`a tool result for ${block.tool_use_id} has no call`);
          }
          const text = toolResultText(block);
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name,
              // DECISION: an error result is reported under `error`, the key Google's docs use, so
              // the model reads it as a failure (the API has no is_error flag).
              response: block.is_error ? { error: text } : { result: text },
            },
          });
        } else {
          parts.push(userPart(block));
        }
      }
    } else {
      let signature: string | undefined;
      let calls = 0;
      for (const block of m.content) {
        if (block.type === "thinking") {
          signature = ownSignature(block) ?? signature;
          continue;
        }
        // Anthropic's redacted thinking means nothing to Gemini.
        if (block.type === "redacted_thinking") continue;
        const signed = signature ? { thoughtSignature: signature } : {};
        if (block.type === "text") {
          parts.push({ text: block.text, ...signed });
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          parts.push({
            functionCall: {
              id: block.id,
              name: block.name,
              args: (block.input ?? {}) as Record<string, unknown>,
            },
            // Only a turn's first call carries a signature (parallel calls share it).
            ...(signature ? signed : calls === 0 ? { thoughtSignature: UNSIGNED_CALL } : {}),
          });
          calls += 1;
        } else {
          throw new GeminiRequestError(`an assistant ${block.type} block can't go to Gemini`);
        }
        signature = undefined;
      }
    }
    if (parts.length > 0) contents.push({ role: m.role === "user" ? "user" : "model", parts });
  }
  return contents;
}

function toFunctionDeclaration(tool: NonNullable<LlmRequest["tools"]>[number]) {
  if (!("input_schema" in tool)) {
    throw new GeminiRequestError(`the server tool ${tool.type} can't go to Gemini`);
  }
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parametersJsonSchema: tool.input_schema as Record<string, unknown>,
  };
}

function toToolConfig(choice: LlmRequest["tool_choice"]): GRequest["toolConfig"] | undefined {
  if (!choice) return undefined;
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

// DECISION: Gemini's thinking models take two levels; Anthropic's low maps to low and every
// higher effort to high.
const THINKING: Record<string, "low" | "high"> = {
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "high",
};

export function toGeminiRequest(request: LlmRequest): GRequest {
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
      ...(format
        ? { responseMimeType: "application/json", responseJsonSchema: format.schema }
        : {}),
      ...(effort ? { thinkingConfig: { thinkingLevel: THINKING[effort] ?? "high" } } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Response: generateContent → an Anthropic-shaped message.

const REFUSED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "LANGUAGE",
]);

/**
 * The answer as an Anthropic message. `model` is the platform id that was asked for (with its
 * prefix), so pricing and logs name the model the way definitions do.
 */
export function fromGeminiResponse(response: GResponse, request: LlmRequest): LlmMessage {
  const id = response.responseId ?? `gemini_${Date.now().toString(36)}`;
  const candidate = response.candidates?.[0];
  const content: Anthropic.ContentBlock[] = [];
  let calls = 0;
  for (const part of candidate?.content?.parts ?? []) {
    if ("text" in part && part.thought) {
      // Thought summaries are not kept, as with OpenAI's reasoning; their signature is.
      if (part.thoughtSignature) content.push(signatureBlock(part.thoughtSignature));
      continue;
    }
    if ("functionCall" in part) {
      if (part.thoughtSignature) content.push(signatureBlock(part.thoughtSignature));
      content.push({
        type: "tool_use",
        id: part.functionCall.id || `${id}_call_${calls}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
        caller: { type: "direct" },
      } as Anthropic.ToolUseBlock);
      calls += 1;
    } else if ("text" in part) {
      if (part.thoughtSignature) content.push(signatureBlock(part.thoughtSignature));
      if (part.text) content.push({ type: "text", text: part.text, citations: null });
    }
  }
  const blocked = response.promptFeedback?.blockReason;
  const finish = candidate?.finishReason;
  if (blocked && !candidate) {
    // The prompt itself was blocked: no candidate at all. Answered as a refusal, not an error, so
    // the caller handles it as it would any refusal.
    content.push({ type: "text", text: `Blocked: ${blocked}`, citations: null });
  }
  const stopReason: Anthropic.StopReason =
    (blocked && !candidate) || (finish && REFUSED.has(finish))
      ? "refusal"
      : finish === "MAX_TOKENS"
        ? "max_tokens"
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn";
  const u = response.usageMetadata ?? {};
  const cached = u.cachedContentTokenCount ?? 0;
  return {
    id,
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
      input_tokens: Math.max(
        0,
        (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0) - cached,
      ),
      // Thinking is billed as output, as Anthropic's output count includes it.
      output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      // Gemini caches implicitly and does not charge for writing.
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

export type GeminiTransportOptions = HttpTransportOptions;

export function geminiTransport(options: GeminiTransportOptions): LlmTransport {
  const root = apiRoot(options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta");
  return {
    async create(request, opts) {
      const url = `${root}/models/${encodeURIComponent(geminiModelName(request.model))}:generateContent`;
      const body = JSON.stringify(toGeminiRequest(request));
      const res = await postJson(
        options,
        url,
        { "x-goog-api-key": options.apiKey },
        body,
        opts?.signal,
      );
      if (res.ok) return fromGeminiResponse((await res.json()) as GResponse, request);
      const { message, code } = await errorDetail(res);
      throw new GeminiError(`Gemini ${res.status}: ${message}`, res.status, code);
    },
  };
}
