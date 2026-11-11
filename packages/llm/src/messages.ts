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

export interface UserLocation {
  type: "approximate";
  city?: string | null;
  region?: string | null;
  country?: string | null;
  timezone?: string | null;
}

/** Anthropic's server-side web search (packages/agents' `web.search`, §1.77). */
export interface WebSearchTool20250305 {
  type: "web_search_20250305";
  name: "web_search";
  max_uses?: number | null;
  allowed_domains?: string[] | null;
  blocked_domains?: string[] | null;
  user_location?: UserLocation | null;
  cache_control?: CacheControlEphemeral | null;
}

/** Anthropic's server-side page fetch (packages/agents' `web.fetch`, §1.77). */
export interface WebFetchTool20250910 {
  type: "web_fetch_20250910";
  name: "web_fetch";
  max_uses?: number | null;
  max_content_tokens?: number | null;
  allowed_domains?: string[] | null;
  blocked_domains?: string[] | null;
  citations?: { enabled?: boolean } | null;
  cache_control?: CacheControlEphemeral | null;
}

/** The server tools the platform uses. The other providers' translations refuse them. */
export type ServerTool = WebSearchTool20250305 | WebFetchTool20250910;

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
  citations: z.array(z.unknown()).nullable().optional(),
});

const thinkingBlockSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
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

const serverToolUseBlockSchema = z.looseObject({
  type: z.literal("server_tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  caller: toolCallerSchema.optional(),
});

const webSearchResultSchema = z.looseObject({
  type: z.literal("web_search_result"),
  url: z.string(),
  title: z.string(),
  page_age: z.string().nullable().optional(),
  encrypted_content: z.string().optional(),
});

const webSearchToolResultBlockSchema = z.looseObject({
  type: z.literal("web_search_tool_result"),
  tool_use_id: z.string(),
  caller: toolCallerSchema.optional(),
  content: z.union([
    z.array(webSearchResultSchema),
    z.looseObject({ type: z.literal("web_search_tool_result_error"), error_code: z.string() }),
  ]),
});

const documentBlockSchema = z.looseObject({
  type: z.literal("document"),
  source: z.union([
    z.looseObject({
      type: z.literal("base64"),
      media_type: z.literal("application/pdf"),
      data: z.string(),
    }),
    z.looseObject({
      type: z.literal("text"),
      media_type: z.literal("text/plain"),
      data: z.string(),
    }),
  ]),
  title: z.string().nullable().optional(),
  citations: z.looseObject({ enabled: z.boolean() }).nullable().optional(),
});

const webFetchToolResultBlockSchema = z.looseObject({
  type: z.literal("web_fetch_tool_result"),
  tool_use_id: z.string(),
  caller: toolCallerSchema.optional(),
  content: z.union([
    z.looseObject({
      type: z.literal("web_fetch_result"),
      url: z.string(),
      retrieved_at: z.string().nullable().optional(),
      content: documentBlockSchema,
    }),
    z.looseObject({ type: z.literal("web_fetch_tool_result_error"), error_code: z.string() }),
  ]),
});

const KNOWN_BLOCKS = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
]);

/**
 * A block of a type we never ask for (other server tools and the like). Kept as it came, so a
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
    serverToolUseBlockSchema,
    webSearchToolResultBlockSchema,
    webFetchToolResultBlockSchema,
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
  server_tool_use: z
    .looseObject({
      web_search_requests: count.nullable().optional(),
      web_fetch_requests: count.nullable().optional(),
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
  // A stop reason the API adds later is kept, not refused: callers compare with the ones they know.
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable().optional(),
  usage: usageSchema,
});

/** Where a sentence of a search answer came from (the search's own results). */
export interface CitationsWebSearchResultLocation {
  type: "web_search_result_location";
  url: string;
  title: string | null;
  cited_text: string;
  encrypted_index: string;
}

/** Where a sentence came from in a document or search result we sent. */
export interface CitationOtherLocation {
  type: "char_location" | "page_location" | "content_block_location" | "search_result_location";
  cited_text: string;
  [k: string]: unknown;
}

export type TextCitation = CitationsWebSearchResultLocation | CitationOtherLocation;

export interface TextBlock {
  type: "text";
  text: string;
  /** Absent at a streamed block's start when it has none. */
  citations?: TextCitation[] | null;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  /** Arrives in its own delta after the thinking; sent back unchanged. */
  signature?: string;
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

export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: unknown;
  caller?: ToolCaller;
}

export interface WebSearchResultBlock {
  type: "web_search_result";
  url: string;
  title: string;
  page_age?: string | null;
  encrypted_content?: string;
}

export interface WebSearchToolResultBlock {
  type: "web_search_tool_result";
  tool_use_id: string;
  caller?: ToolCaller;
  content: WebSearchResultBlock[] | { type: "web_search_tool_result_error"; error_code: string };
}

export interface DocumentBlock {
  type: "document";
  source: Base64PDFSource | PlainTextSource;
  title?: string | null;
  citations?: { enabled: boolean } | null;
}

export interface WebFetchToolResultBlock {
  type: "web_fetch_tool_result";
  tool_use_id: string;
  caller?: ToolCaller;
  content:
    | { type: "web_fetch_result"; url: string; retrieved_at: string | null; content: DocumentBlock }
    | { type: "web_fetch_tool_result_error"; error_code: string };
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | WebFetchToolResultBlock;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  /** The server tools' requests in this call, priced on top of the tokens. */
  server_tool_use?: {
    web_search_requests?: number | null;
    web_fetch_requests?: number | null;
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
  /** One of `STOP_REASONS`, or one the API added since (kept as it came). */
  stop_reason: StopReason | (string & {}) | null;
  stop_sequence?: string | null;
  usage: Usage;
  [k: string]: unknown;
}
