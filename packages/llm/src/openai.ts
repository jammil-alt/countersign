// OpenAI models behind the same seam as Anthropic's (ARCHITECTURE §2; owner, 2026-11-04: "use both
// models"). The platform speaks one request shape, the Anthropic Messages format; this transport
// translates it to OpenAI's Responses API and translates the answer back into an Anthropic-shaped
// message. So the client, `callTool`, the agent runtime, cost tracking and record/replay work the
// same whichever provider answers, and nothing above the transport knows which one did.
//
// Plain fetch, no SDK: the Worker stays light and a test can pass its own fetch.

import type Anthropic from "@anthropic-ai/sdk";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** Model ids that start with this go to OpenAI: `openai:gpt-5.5`. */
export const OPENAI_PREFIX = "openai:";

export function isOpenAIModel(model: string): boolean {
  return model.startsWith(OPENAI_PREFIX);
}

/** The id OpenAI knows the model by: the platform id without its prefix. */
export function openAIModelName(model: string): string {
  return isOpenAIModel(model) ? model.slice(OPENAI_PREFIX.length) : model;
}

// ---------------------------------------------------------------------------------------------
// The Responses API, as much of it as the platform uses.

type OAInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
  | { type: "input_file"; filename: string; file_data: string };

export type OAInputItem =
  | { type: "message"; role: "user"; content: OAInputContent[] }
  | { type: "message"; role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface OAFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export type OAToolChoice = "auto" | "required" | "none" | { type: "function"; name: string };

export interface OAResponsesRequest {
  model: string;
  instructions?: string;
  input: OAInputItem[];
  tools?: OAFunctionTool[];
  tool_choice?: OAToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens: number;
  reasoning?: { effort: "low" | "medium" | "high" };
  text?: {
    format: { type: "json_schema"; name: string; schema: Record<string, unknown>; strict: boolean };
  };
  store: false;
}

export interface OAOutputItem {
  type: string;
  id?: string;
  // message
  role?: string;
  content?: { type: string; text?: string; refusal?: string }[];
  // function_call
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface OAResponse {
  id: string;
  model?: string;
  status?: "completed" | "incomplete" | "failed" | "in_progress" | "cancelled" | "queued";
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  output: OAOutputItem[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number } | null;
  } | null;
}

/** A request the translation can't express. A programming error, not a model failure. */
export class OpenAIRequestError extends Error {
  override name = "OpenAIRequestError";
}

/** OpenAI answered with an error, or the answer was a failed response. */
export class OpenAIError extends Error {
  override name = "OpenAIError";
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, status: number | null, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Request: Anthropic Messages → Responses.

function systemText(system: LlmRequest["system"]): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n\n");
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const { content } = block;
  let text: string;
  if (content === undefined) text = "";
  else if (typeof content === "string") text = content;
  else {
    text = content
      .map((c) => {
        if (c.type === "text") return c.text;
        throw new OpenAIRequestError(`a tool result with ${c.type} content can't go to OpenAI`);
      })
      .join("\n");
  }
  // DECISION: the Responses API has no is_error flag on a function output; an error result is
  // marked in its text so the model still reads it as a failure.
  return block.is_error ? `Error: ${text}` : text;
}

function userContent(block: Anthropic.ContentBlockParam): OAInputContent {
  switch (block.type) {
    case "text":
      return { type: "input_text", text: block.text };
    case "image": {
      const s = block.source;
      if (s.type === "base64") {
        return {
          type: "input_image",
          image_url: `data:${s.media_type};base64,${s.data}`,
          detail: "auto",
        };
      }
      if (s.type === "url") return { type: "input_image", image_url: s.url, detail: "auto" };
      break;
    }
    case "document": {
      const s = block.source;
      if (s.type === "base64") {
        return {
          type: "input_file",
          filename: block.title ? `${block.title}.pdf` : "document.pdf",
          file_data: `data:${s.media_type};base64,${s.data}`,
        };
      }
      if (s.type === "text") return { type: "input_text", text: s.data };
      break;
    }
  }
  throw new OpenAIRequestError(`a ${block.type} block can't go to OpenAI`);
}

/** The Responses `input` for a list of Anthropic messages, in order. */
export function toOpenAIInput(messages: readonly Anthropic.MessageParam[]): OAInputItem[] {
  const items: OAInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      items.push(
        m.role === "user"
          ? { type: "message", role: "user", content: [{ type: "input_text", text: m.content }] }
          : { type: "message", role: "assistant", content: m.content },
      );
      continue;
    }
    if (m.role === "user") {
      // Tool results become their own items; other blocks are gathered into user messages,
      // keeping their order relative to the results.
      let pending: OAInputContent[] = [];
      const flush = () => {
        if (pending.length) items.push({ type: "message", role: "user", content: pending });
        pending = [];
      };
      for (const block of m.content) {
        if (block.type === "tool_result") {
          flush();
          items.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: toolResultText(block),
          });
        } else {
          pending.push(userContent(block));
        }
      }
      flush();
      continue;
    }
    let text: string[] = [];
    const flush = () => {
      if (text.length)
        items.push({ type: "message", role: "assistant", content: text.join("\n\n") });
      text = [];
    };
    for (const block of m.content) {
      if (block.type === "text") text.push(block.text);
      else if (block.type === "tool_use") {
        flush();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
      // DECISION: thinking is not carried between turns. Reasoning items are not echoed back
      // (store is off and their ids would point at nothing), so each turn reasons afresh from the
      // transcript; Anthropic thinking blocks, if a transcript has any, are dropped the same way.
      else if (block.type === "thinking" || block.type === "redacted_thinking") continue;
      else throw new OpenAIRequestError(`an assistant ${block.type} block can't go to OpenAI`);
    }
    flush();
  }
  return items;
}

function toOpenAITool(tool: NonNullable<LlmRequest["tools"]>[number]): OAFunctionTool {
  if (!("input_schema" in tool)) {
    throw new OpenAIRequestError(`the server tool ${tool.type} can't go to OpenAI`);
  }
  return {
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.input_schema as Record<string, unknown>,
    // Strict mode needs every property required and no extra ones; only callers that know their
    // schema fits ask for it, as with Anthropic.
    strict: tool.strict === true,
  };
}

function toOpenAIToolChoice(choice: LlmRequest["tool_choice"]): {
  tool_choice?: OAToolChoice;
  parallel_tool_calls?: boolean;
} {
  if (!choice) return {};
  const parallel =
    "disable_parallel_tool_use" in choice && choice.disable_parallel_tool_use
      ? { parallel_tool_calls: false }
      : {};
  switch (choice.type) {
    case "auto":
      return { tool_choice: "auto", ...parallel };
    case "any":
      return { tool_choice: "required", ...parallel };
    case "tool":
      return { tool_choice: { type: "function", name: choice.name }, ...parallel };
    case "none":
      return { tool_choice: "none" };
  }
}

// DECISION: Anthropic's effort levels map onto OpenAI's three; xhigh and max become high, the
// highest every OpenAI reasoning model accepts.
const EFFORT: Record<string, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

export function toOpenAIRequest(request: LlmRequest): OAResponsesRequest {
  const instructions = systemText(request.system);
  const effort = request.output_config?.effort;
  const format = request.output_config?.format;
  return {
    model: openAIModelName(request.model),
    ...(instructions ? { instructions } : {}),
    input: toOpenAIInput(request.messages),
    ...(request.tools?.length ? { tools: request.tools.map(toOpenAITool) } : {}),
    ...toOpenAIToolChoice(request.tool_choice),
    max_output_tokens: request.max_tokens,
    ...(effort ? { reasoning: { effort: EFFORT[effort] ?? "medium" } } : {}),
    ...(format
      ? {
          text: {
            format: { type: "json_schema", name: "output", schema: format.schema, strict: true },
          },
        }
      : {}),
    // Nothing is kept at OpenAI: every request carries its whole transcript, as with Anthropic.
    store: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Response: Responses → an Anthropic-shaped message.

function parseArguments(args: string | undefined): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    // Kept as the raw string so schema validation fails with the model's own text to read.
    return args;
  }
}

/**
 * The answer as an Anthropic message. `model` is the platform id that was asked for (with its
 * prefix), so pricing and logs name the model the way definitions do.
 */
export function fromOpenAIResponse(response: OAResponse, request: LlmRequest): LlmMessage {
  if (response.status === "failed" || response.status === "cancelled") {
    throw new OpenAIError(
      `OpenAI response ${response.status}: ${response.error?.message ?? "no detail"}`,
      null,
      response.error?.code ?? null,
    );
  }
  const content: Anthropic.ContentBlock[] = [];
  let refused = false;
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) {
          content.push({ type: "text", text: part.text, citations: null });
        } else if (part.type === "refusal") {
          refused = true;
          if (part.refusal) content.push({ type: "text", text: part.refusal, citations: null });
        }
      }
    } else if (item.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        input: parseArguments(item.arguments),
        caller: { type: "direct" },
      } as Anthropic.ToolUseBlock);
    }
    // Reasoning items are not kept (see toOpenAIInput); their tokens are in usage.
  }
  const incomplete =
    response.status === "incomplete" ? response.incomplete_details?.reason : undefined;
  const stopReason: Anthropic.StopReason = refused
    ? "refusal"
    : incomplete === "max_output_tokens"
      ? "max_tokens"
      : incomplete === "content_filter"
        ? "refusal"
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn";
  const u = response.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    id: response.id,
    type: "message",
    role: "assistant",
    model: request.model,
    content,
    container: null,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      // Anthropic counts cached input apart from fresh input; OpenAI's input total includes it.
      input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
      output_tokens: u.output_tokens ?? 0,
      // OpenAI caches automatically and does not charge for writing.
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

export interface OpenAITransportOptions {
  readonly apiKey: string;
  /** Injected so a Worker, a test or a proxy decides how requests leave. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** Defaults to https://api.openai.com/v1. */
  readonly baseURL?: string;
  /** Per attempt. Defaults to 10 minutes: agent calls with reasoning can run long. */
  readonly timeoutMs?: number;
  /** Retries after a rate limit, overload, server error or dropped connection. Defaults to 2. */
  readonly maxRetries?: number;
  /** Waits between retries; tests pass one that doesn't. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(500 * 2 ** attempt, 8_000);
}

export function openaiTransport(options: OpenAITransportOptions): LlmTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const url = `${(options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async create(request, opts) {
      const body = JSON.stringify(toOpenAIRequest(request));
      for (let attempt = 0; ; attempt += 1) {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (opts?.signal) signals.push(opts.signal);
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body,
            signal: AbortSignal.any(signals),
          });
        } catch (error) {
          if (opts?.signal?.aborted || attempt >= maxRetries) throw error;
          await sleep(retryDelayMs(attempt, null));
          continue;
        }
        if (res.ok) return fromOpenAIResponse((await res.json()) as OAResponse, request);
        if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
          await sleep(retryDelayMs(attempt, res.headers.get("retry-after")));
          continue;
        }
        const text = await res.text();
        let message = text.slice(0, 500);
        let code: string | null = null;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
          message = parsed.error?.message ?? message;
          code = parsed.error?.code ?? null;
        } catch {
          // Not JSON; keep the start of the body.
        }
        throw new OpenAIError(`OpenAI ${res.status}: ${message}`, res.status, code);
      }
    },
  };
}
