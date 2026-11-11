// The Anthropic Messages API, as much of it as the platform uses: the request we send, the message
// we get back, and the Zod schema that checks that message at the boundary (invariant 5). Every
// provider's transport speaks this shape (./openai.ts, ./gemini.ts and ./xai.ts translate to and
// from it), so nothing above the transport knows which provider answered.
//
// Written from `@anthropic-ai/sdk` 1.4.0's types, which this package used before it had its own
// transport (./anthropic.ts). Import it as a namespace: `import type * as Anthropic from
// "./messages"`, so `Anthropic.ToolUseBlock` reads as it did with the SDK.

import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// What we send.

export interface CacheControlEphemeral {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral | null;
  citations?: unknown[] | null;
}

export interface Base64ImageSource {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
}

export interface URLImageSource {
  type: "url";
  url: string;
}

export interface ImageBlockParam {
  type: "image";
  source: Base64ImageSource | URLImageSource;
  cache_control?: CacheControlEphemeral | null;
}

export interface Base64PDFSource {
  type: "base64";
  media_type: "application/pdf";
  data: string;
}

export interface PlainTextSource {
  type: "text";
  media_type: "text/plain";
  data: string;
}

export interface URLPDFSource {
  type: "url";
  url: string;
}

export interface DocumentBlockParam {
  type: "document";
  source: Base64PDFSource | PlainTextSource | URLPDFSource;
  cache_control?: CacheControlEphemeral | null;
  citations?: { enabled?: boolean } | null;
  context?: string | null;
  title?: string | null;
}

export interface ToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControlEphemeral | null;
  caller?: ToolCaller;
}

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content?: string | (TextBlockParam | ImageBlockParam | DocumentBlockParam)[];
  is_error?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

export interface ThinkingBlockParam {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlockParam {
  type: "redacted_thinking";
  data: string;
}

/** A search result given to the model as content. No caller sends one; the translations refuse it. */
export interface SearchResultBlockParam {
  type: "search_result";
  source: string;
  title: string;
  content: TextBlockParam[];
  cache_control?: CacheControlEphemeral | null;
  citations?: { enabled?: boolean } | null;
}

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | DocumentBlockParam
  | SearchResultBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam;

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlockParam[];
}

export interface ToolInputSchema {
  type: "object";
  properties?: unknown | null;
  required?: string[] | null;
  [k: string]: unknown;
}

export interface Tool {
  type?: "custom" | null;
  name: string;
  description?: string;
  input_schema: ToolInputSchema;
  /** Ask the API to keep arguments schema-valid. */
  strict?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

/**
 * One of Anthropic's server tools (`web_search_20250305` and the like). No caller sends one; the
 * other providers' translations refuse it.
 */
export interface ServerTool {
  type:
    | `web_search_${string}`
    | `web_fetch_${string}`
    | `code_execution_${string}`
    | `bash_${string}`
    | `text_editor_${string}`
    | `memory_${string}`
    | `computer_${string}`
    | `tool_search_tool_${string}`;
  name: string;
  cache_control?: CacheControlEphemeral | null;
}

export type ToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface JSONOutputFormat {
  type: "json_schema";
  schema: { [key: string]: unknown };
}

export interface OutputConfig {
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  format?: JSONOutputFormat | null;
}

export type ThinkingConfig =
  | { type: "enabled"; budget_tokens: number }
  | { type: "adaptive" }
  | { type: "disabled" };

/** One call to `POST /v1/messages`. The transport adds `stream: true`. */
export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: string | TextBlockParam[];
  tools?: (Tool | ServerTool)[];
  tool_choice?: ToolChoice;
  output_config?: OutputConfig;
  thinking?: ThinkingConfig;
  temperature?: number;
  stop_sequences?: string[];
  metadata?: { user_id?: string | null };
}

// ---------------------------------------------------------------------------------------------
// What comes back, checked with Zod. Objects are loose: a field the API adds is kept (a recorded
// fixture keeps the whole answer) and only the fields we read are required.

export const STOP_REASONS = [
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

const toolCallerSchema = z.looseObject({ type: z.string() });
/** Who made a tool call: `{type: "direct"}` for the model itself. */
export interface ToolCaller {
  type: string;
  [k: string]: unknown;
}

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  citations: z.array(z.unknown()).nullable(),
});

const thinkingBlockSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string(),
});

const redactedThinkingBlockSchema = z.looseObject({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  caller: toolCallerSchema.optional(),
});

const KNOWN_BLOCKS = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);

/**
 * A block of a type we never ask for (server tools and the like). Kept as it came, so a
 * transcript sent back is the one the API gave; nothing above the transport reads one.
 */
const otherBlockSchema = z.looseObject({
  type: z.string().refine((t) => !KNOWN_BLOCKS.has(t), "a known block type with the wrong shape"),
});

export const contentBlockSchema = z.union([
  z.discriminatedUnion("type", [
    textBlockSchema,
    thinkingBlockSchema,
    redactedThinkingBlockSchema,
    toolUseBlockSchema,
  ]),
  otherBlockSchema,
]);

const count = z.number().int().nonnegative();

export const usageSchema = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_creation_input_tokens: count.nullable().optional(),
  cache_read_input_tokens: count.nullable().optional(),
  cache_creation: z
    .looseObject({
      ephemeral_5m_input_tokens: count.optional(),
      ephemeral_1h_input_tokens: count.optional(),
    })
    .nullable()
    .optional(),
});

export const messageSchema = z.looseObject({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(contentBlockSchema),
  stop_reason: z.enum(STOP_REASONS).nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: usageSchema,
});

export interface TextBlock {
  type: "text";
  text: string;
  citations: unknown[] | null;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  caller?: ToolCaller;
}

export type ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  [k: string]: unknown;
}

/**
 * The answer: an assistant message, whichever provider gave it. Fields the API adds beyond these
 * (`stop_details`, `container`, …) are kept as they came.
 */
export interface Message {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence?: string | null;
  usage: Usage;
  [k: string]: unknown;
}
