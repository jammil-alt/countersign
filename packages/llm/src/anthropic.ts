// Anthropic's Messages API over plain fetch: our own transport in place of `@anthropic-ai/sdk`
// (docs/audit-plan.md 4.7, owner's answer to D3), so the Worker carries no SDK. It keeps what the
// package used of the SDK, read from the SDK's source (1.4.0):
//
// - the request: `POST {base}/v1/messages` with the key as a bearer token, `anthropic-version`,
//   JSON in and out, and the body as given plus `stream: true`;
// - streaming: the answer is read as server-sent events and put together into one message, as
//   the SDK's `messages.stream(...).finalMessage()` did, so a long call is not cut off;
// - retries: up to 2, after a dropped connection, a time-out, or a 408, 409, 429 or 5xx (an
//   `x-should-retry` header overrides), waiting what `retry-after-ms` or `retry-after` says, else
//   0.5 s doubling to 8 s with up to a quarter off;
// - the time limit (10 minutes) covers the wait for the answer to start, not the stream after;
// - errors worded as the SDK worded them (`529 {"type":"error","error":{...}}`, `Connection
//   error.`, `Request timed out.`, `Request was aborted.`), since a run's error key is read from
//   the words (core's `runErrorCode`).
//
// The finished message is checked with Zod (./messages.ts) before it goes up.

import { messageSchema } from "./messages";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";

/** The API version the SDK we replaced sent, unchanged. */
export const ANTHROPIC_VERSION = "2026-10-21";
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_RETRIES = 2;

export interface AnthropicTransportOptions {
  readonly apiKey: string;
  /** Injected so a Worker, a test or a proxy decides how requests leave. Defaults to global fetch. */
  readonly fetch?: typeof fetch;
  readonly baseURL?: string;
  /** Per attempt, until the answer starts. Defaults to 10 minutes. */
  readonly timeoutMs?: number;
  /** Retries after a dropped connection, a time-out, a rate limit or a server error. Defaults to 2. */
  readonly maxRetries?: number;
  /** Waits between retries; tests pass one that doesn't. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** For the jitter on a retry's wait; tests pass a fixed one. */
  readonly random?: () => number;
}

// DECISION: the errors keep the SDK's class name (`Error`, which the SDK never renamed) and its
// words, so `model_call` rows and run error keys read exactly as before the SDK was replaced.
/** The API answered with an error, or the stream carried one (`status` is then null). */
export class AnthropicError extends Error {
  readonly status: number | null;
  /** The error body, parsed when it was JSON. */
  readonly error: unknown;
  /** `error.type` from the body, e.g. `rate_limit_error`, `overloaded_error`. */
  readonly type: string | null;
  readonly requestId: string | null;
  constructor(message: string, status: number | null, error: unknown, requestId: string | null) {
    super(message);
    this.status = status;
    this.error = error;
    const inner = (error as { error?: { type?: unknown } } | null)?.error?.type;
    this.type = typeof inner === "string" ? inner : null;
    this.requestId = requestId;
  }
}

/** No answer: the connection failed or timed out (after the retries), or the caller aborted. */
export class AnthropicConnectionError extends AnthropicError {
  readonly reason: "connection" | "timeout" | "aborted";
  constructor(reason: "connection" | "timeout" | "aborted", cause?: unknown) {
    super(
      reason === "timeout"
        ? "Request timed out."
        : reason === "aborted"
          ? "Request was aborted."
          : "Connection error.",
      null,
      undefined,
      null,
    );
    this.reason = reason;
    if (cause !== undefined) this.cause = cause;
  }
}

/** The SDK's words for an error answer: `<status> <body.message or the body as JSON>`. */
export function statusErrorMessage(status: number | null, body: unknown, text: string): string {
  const b = body as { message?: unknown } | null | undefined;
  const msg =
    b && typeof b === "object"
      ? b.message
        ? typeof b.message === "string"
          ? b.message
          : JSON.stringify(b.message)
        : JSON.stringify(b)
      : text;
  if (status && msg) return `${status} ${msg}`;
  if (status) return `${status} status code (no body)`;
  return msg || "(no status code or body)";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errorFromResponse(status: number, headers: Headers, text: string): AnthropicError {
  const body = safeJson(text);
  return new AnthropicError(
    statusErrorMessage(status, body, text),
    status,
    body ?? text,
    headers.get("request-id"),
  );
}

export function shouldRetry(res: Response): boolean {
  const header = res.headers.get("x-should-retry");
  if (header === "true") return true;
  if (header === "false") return false;
  return res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
}

/**
 * How long to wait before retry number `retry` (0 for the first) of `maxRetries`: what the answer
 * asked for, when it is a positive time one timer can hold, else 0.5 s doubling to 8 s, less up
 * to a quarter.
 */
export function anthropicRetryDelayMs(
  retry: number,
  headers: Headers | null,
  random: () => number = Math.random,
  now: () => number = Date.now,
): number {
  let ms: number | undefined;
  const afterMs = headers?.get("retry-after-ms");
  if (afterMs) {
    const n = Number.parseFloat(afterMs);
    if (!Number.isNaN(n)) ms = n;
  }
  const after = headers?.get("retry-after");
  if (after && !ms) {
    const seconds = Number.parseFloat(after);
    ms = Number.isNaN(seconds) ? Date.parse(after) - now() : seconds * 1000;
  }
  if (ms === undefined || !(ms > 0 && ms <= 2 ** 31 - 1)) {
    const seconds = Math.min(0.5 * 2 ** retry, 8);
    ms = seconds * (1 - random() * 0.25) * 1000;
  }
  return ms;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AnthropicConnectionError("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AnthropicConnectionError("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Server-sent events.

export interface ServerSentEvent {
  readonly event: string | null;
  readonly data: string;
}

/** The events in a `text/event-stream` body, as they arrive. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const line = (raw: string): ServerSentEvent | null => {
    if (raw === "") {
      if (event === null && data.length === 0) return null;
      const out = { event, data: data.join("\n") };
      event = null;
      data = [];
      return out;
    }
    if (raw.startsWith(":")) return null;
    const colon = raw.indexOf(":");
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    return null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        // A lone `\r` at the end may be the first half of `\r\n`: wait for more.
        if (!match || (match[0] === "\r" && match.index === buffer.length - 1 && !done)) break;
        const out = line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (out) yield out;
      }
      if (done) {
        if (buffer !== "") {
          const out = line(buffer);
          buffer = "";
          if (out) yield out;
        }
        const out = line("");
        if (out) yield out;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------------------------
// Putting the message together from its events, as the SDK's MessageStream did.

type Snapshot = {
  usage: Record<string, unknown>;
  content: Record<string, unknown>[];
  [k: string]: unknown;
};

/**
 * A message put together from its stream events. Tool input arrives as pieces of JSON and is
 * parsed when its block ends.
 */
export class MessageAccumulator {
  #snapshot: Snapshot | null = null;
  readonly #json = new Map<number, string>();
  #stopped = false;

  /** Adds one event (`ping` and unknown events are ignored). */
  add(event: { type: string; [k: string]: unknown }): void {
    if (event.type === "message_start") {
      if (this.#snapshot) {
        throw new AnthropicError(
          `Unexpected event order, got ${event.type} before receiving "message_stop"`,
          null,
          undefined,
          null,
        );
      }
      this.#snapshot = structuredClone(event.message) as Snapshot;
      return;
    }
    const snap = this.#snapshot;
    if (!snap) return;
    switch (event.type) {
      case "message_delta": {
        const delta = event.delta as Record<string, unknown>;
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        snap.stop_reason = delta.stop_reason;
        snap.stop_sequence = delta.stop_sequence;
        snap.stop_details = delta.stop_details;
        snap.usage.output_tokens = usage.output_tokens;
        if (delta.container != null) snap.container = delta.container;
        // The other counters are whole-message totals, sent only when they apply: overwrite.
        for (const key of [
          "input_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "server_tool_use",
          "output_tokens_details",
        ]) {
          if (usage[key] != null) snap.usage[key] = usage[key];
        }
        return;
      }
      case "content_block_start":
        snap.content.push({ ...(event.content_block as Record<string, unknown>) });
        return;
      case "content_block_delta": {
        const index = event.index as number;
        const block = snap.content[index];
        const delta = event.delta as Record<string, unknown>;
        if (!block) return;
        if (delta.type === "text_delta" && block.type === "text") {
          block.text = String(block.text ?? "") + String(delta.text);
        } else if (delta.type === "citations_delta" && block.type === "text") {
          block.citations = [...((block.citations as unknown[] | null) ?? []), delta.citation];
        } else if (
          delta.type === "input_json_delta" &&
          (block.type === "tool_use" || block.type === "server_tool_use")
        ) {
          this.#json.set(index, (this.#json.get(index) ?? "") + String(delta.partial_json));
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking = String(block.thinking ?? "") + String(delta.thinking);
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.signature = delta.signature;
        }
        return;
      }
      case "content_block_stop": {
        const index = event.index as number;
        const block = snap.content[index];
        const json = this.#json.get(index);
        if (block && json !== undefined) {
          block.input = parseToolInput(json);
          this.#json.delete(index);
        }
        return;
      }
      case "message_stop":
        this.#stopped = true;
        return;
      default:
        return;
    }
  }

  /**
   * The finished message. As the SDK did, a stream that sent no message at all, or that ended
   * before `message_stop`, is an error (with the SDK's words), not a partial answer.
   */
  message(): unknown {
    if (!this.#snapshot) {
      throw new AnthropicError("request ended without sending any chunks", null, undefined, null);
    }
    if (!this.#stopped) {
      throw new AnthropicError(
        "stream ended without producing a Message with role=assistant",
        null,
        undefined,
        null,
      );
    }
    return this.#snapshot;
  }
}

// DECISION: tool input that does not parse (only possible when the answer was cut off at
// max_tokens mid-call) is read as `{}`. The SDK parsed the partial JSON leniently; either way the
// input is incomplete, and callers validate it (callTool's Zod schema, a tool's input schema).
function parseToolInput(json: string): unknown {
  if (json === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// The transport.

/** The request headers, without `content-type` (added with the body). */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    accept: "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    authorization: `Bearer ${apiKey}`,
  };
}

/**
 * A connection error the runtime itself reports as a time-out (Node's undici: `ConnectTimeoutError`
 * in the cause; Deno: "Operation timed out"). The SDK tested the error and its cause the same way.
 */
export function looksTimedOut(error: unknown): boolean {
  const cause = error instanceof Error && "cause" in error ? String(error.cause) : "";
  return /timed? ?out/i.test(String(error) + cause);
}

/** Throws a caller's abort as the SDK did. */
function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AnthropicConnectionError("aborted");
}

/**
 * The live transport. Requests are streamed and put together into one message: agent and
 * extraction calls can run for a minute or more, and a stream is not cut off on the way.
 */
export function anthropicTransport(options: AnthropicTransportOptions): LlmTransport {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  let base = options.baseURL ?? ANTHROPIC_BASE_URL;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const url = `${base}/v1/messages`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  /** One attempt's response, with the time limit on the wait for it to start. */
  async function attempt(body: string, signal: AbortSignal | undefined) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { ...anthropicHeaders(options.apiKey), "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      return {
        ok: true as const,
        res,
        controller,
        release: () => signal?.removeEventListener("abort", onAbort),
      };
    } catch (error) {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) throw new AnthropicConnectionError("aborted", error);
      return { ok: false as const, timedOut: timedOut || looksTimedOut(error), error };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async create(request: LlmRequest, opts?: { signal?: AbortSignal }): Promise<LlmMessage> {
      const signal = opts?.signal;
      checkAborted(signal);
      const body = JSON.stringify({ ...request, stream: true });
      for (let retry = 0; ; retry += 1) {
        const tried = await attempt(body, signal);
        if (!tried.ok) {
          if (retry < maxRetries) {
            await sleep(anthropicRetryDelayMs(retry, null, random), signal);
            continue;
          }
          throw new AnthropicConnectionError(
            tried.timedOut ? "timeout" : "connection",
            tried.error,
          );
        }
        const { res, release } = tried;
        try {
          if (!res.ok) {
            if (retry < maxRetries && shouldRetry(res)) {
              await res.body?.cancel().catch(() => {});
              await sleep(anthropicRetryDelayMs(retry, res.headers, random), signal);
              continue;
            }
            throw errorFromResponse(res.status, res.headers, await res.text().catch(String));
          }
          return await readMessage(res, signal);
        } finally {
          release();
        }
      }
    },
  };
}

/** Reads the stream of one answer into the message, checked with Zod. */
async function readMessage(res: Response, signal: AbortSignal | undefined): Promise<LlmMessage> {
  if (!res.body)
    throw new AnthropicError("request ended without sending any chunks", null, undefined, null);
  const acc = new MessageAccumulator();
  const requestId = res.headers.get("request-id");
  try {
    for await (const sse of readServerSentEvents(res.body)) {
      if (sse.event === "ping" || sse.event === null) continue;
      if (sse.event === "error") {
        const body = safeJson(sse.data) ?? sse.data;
        throw new AnthropicError(statusErrorMessage(null, body, sse.data), null, body, requestId);
      }
      if (!sse.data) continue;
      acc.add(JSON.parse(sse.data) as { type: string });
    }
  } catch (error) {
    await res.body.cancel().catch(() => {});
    if (signal?.aborted) throw new AnthropicConnectionError("aborted", error);
    throw error;
  }
  checkAborted(signal);
  return parseMessage(acc.message());
}

/** The message, checked at the boundary (invariant 5). */
export function parseMessage(value: unknown): LlmMessage {
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) {
    throw new AnthropicError(
      `invalid message from the API: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      null,
      undefined,
      null,
    );
  }
  // DECISION: blocks of types we never ask for (server tools other than web search and fetch)
  // pass through as they came, typed as the ones we read; nothing above the transport reads
  // them, and a transcript sent back must carry them unchanged.
  return parsed.data as unknown as LlmMessage;
}
