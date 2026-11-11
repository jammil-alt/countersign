import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANTHROPIC_VERSION,
  AnthropicConnectionError,
  AnthropicError,
  anthropicRetryDelayMs,
  anthropicTransport,
  MessageAccumulator,
  parseMessage,
  readServerSentEvents,
} from "./anthropic";
import { createLlmClient } from "./client";
import { messageSchema } from "./messages";
import { PROVIDER_FIXTURE_DIR, scriptedFetch } from "./test-fetch";
import type { LlmRequest } from "./transport";

const MODEL = "claude-sonnet-5-5";

function req(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL,
    max_tokens: 1000,
    messages: [{ role: "user", content: "Hello" }],
    ...partial,
  };
}

/** A `text/event-stream` answer made of these events, as the API sends it. */
function sse(events: { event: string; data: unknown }[], status = 200) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream", "request-id": "req_1" },
  });
}

const start = (overrides: Record<string, unknown> = {}) => ({
  event: "message_start",
  data: {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 120,
        output_tokens: 1,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: "standard",
      },
      ...overrides,
    },
  },
});
const ev = (type: string, data: Record<string, unknown> = {}) => ({
  event: type,
  data: { type, ...data },
});
const stop = (stopReason: string, outputTokens: number) => [
  ev("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
    usage: { output_tokens: outputTokens },
  }),
  ev("message_stop"),
];

const textAnswer = (text: string) =>
  sse([
    start(),
    ev("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    }),
    { event: "ping", data: { type: "ping" } },
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(0, 3) } }),
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(3) } }),
    ev("content_block_stop", { index: 0 }),
    ...stop("end_turn", 12),
  ]);

const errorBody = (type: string, message: string) => ({
  type: "error",
  error: { type, message },
});
const errorResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "request-id": "req_err", ...headers },
  });

function transport(fetchFn: typeof fetch, extra: { timeoutMs?: number; maxRetries?: number } = {}) {
  const waits: number[] = [];
  const t = anthropicTransport({
    apiKey: "sk-test",
    fetch: fetchFn,
    sleep: async (ms) => void waits.push(ms),
    random: () => 0,
    ...extra,
  });
  return { t, waits };
}

describe("anthropicTransport: the request", () => {
  it("posts the request, streamed, with the SDK's URL and headers", async () => {
    const { fn, calls } = scriptedFetch(textAnswer("Hi there"));
    const { t } = transport(fn);
    const request = req({
      system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
      tools: [
        {
          name: "get_invoice",
          description: "Read one invoice",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
          strict: true,
        },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      output_config: { effort: "high" },
    });
    await t.create(request);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init.method).toBe("POST");
    expect(call?.headers).toEqual({
      accept: "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      authorization: "Bearer sk-test",
      "content-type": "application/json",
    });
    expect(ANTHROPIC_VERSION).toBe("2026-10-21");
    // The body is the request as given, plus `stream: true`, in the same key order.
    expect(call?.init.body).toBe(JSON.stringify({ ...request, stream: true }));
    expect(call?.body).toEqual({ ...request, stream: true });
  });

  it("takes another base URL, with or without a trailing slash", async () => {
    const { fn, calls } = scriptedFetch(textAnswer("Hi"), textAnswer("Hi"));
    await anthropicTransport({ apiKey: "k", fetch: fn, baseURL: "https://proxy.test/" }).create(
      req(),
    );
    await anthropicTransport({ apiKey: "k", fetch: fn, baseURL: "https://proxy.test" }).create(
      req(),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://proxy.test/v1/messages",
      "https://proxy.test/v1/messages",
    ]);
  });
});

describe("anthropicTransport: the answer", () => {
  it("puts a streamed text answer together, with its usage", async () => {
    const { fn } = scriptedFetch(textAnswer("Hi there"));
    const message = await transport(fn).t.create(req());
    expect(message).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text: "Hi there", citations: null }],
      container: null,
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 120,
        output_tokens: 12,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        inference_geo: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: "standard",
      },
    });
  });

  it("puts thinking, a tool call's JSON pieces and citations together", async () => {
    const { fn } = scriptedFetch(
      sse([
        start(),
        ev("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        ev("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "Look " },
        }),
        ev("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "it up." },
        }),
        ev("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", {
          index: 1,
          content_block: { type: "text", text: "", citations: null },
        }),
        ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "See" } }),
        ev("content_block_delta", {
          index: 1,
          delta: { type: "citations_delta", citation: { type: "char_location", cited_text: "x" } },
        }),
        ev("content_block_stop", { index: 1 }),
        ev("content_block_start", {
          index: 2,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "get_invoice",
            input: {},
            caller: { type: "direct" },
          },
        }),
        ev("content_block_delta", {
          index: 2,
          delta: { type: "input_json_delta", partial_json: "" },
        }),
        ev("content_block_delta", {
          index: 2,
          delta: { type: "input_json_delta", partial_json: '{"id": "IN' },
        }),
        ev("content_block_delta", {
          index: 2,
          delta: { type: "input_json_delta", partial_json: 'V-1"}' },
        }),
        ev("content_block_stop", { index: 2 }),
        ev("message_delta", {
          delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
          usage: { output_tokens: 50, input_tokens: 125, cache_read_input_tokens: 45 },
        }),
        ev("message_stop"),
      ]),
    );
    const message = await transport(fn).t.create(req());
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Look it up.", signature: "sig" },
      { type: "text", text: "See", citations: [{ type: "char_location", cited_text: "x" }] },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "get_invoice",
        input: { id: "INV-1" },
        caller: { type: "direct" },
      },
    ]);
    expect(message.stop_reason).toBe("tool_use");
    // The totals in message_delta replace the start's; the others stay.
    expect(message.usage).toMatchObject({
      input_tokens: 125,
      output_tokens: 50,
      cache_read_input_tokens: 45,
      cache_creation_input_tokens: 30,
    });
  });

  it("gives a tool call with no input pieces an empty input, and a cut-off one {}", () => {
    const acc = new MessageAccumulator();
    acc.add(start().data);
    acc.add({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "t1", name: "a", input: {} },
    });
    acc.add({ type: "content_block_stop", index: 0 });
    acc.add({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "t2", name: "b", input: {} },
    });
    acc.add({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"id": "IN' },
    });
    const message = acc.message() as { content: { input: unknown }[] };
    expect(message.content.map((b) => b.input)).toEqual([{}, {}]);
  });

  it("works through the client: usage and cost as before", async () => {
    const { fn } = scriptedFetch(textAnswer("Hi there"));
    const client = createLlmClient({ transport: transport(fn).t, clock: () => 0 });
    const { record } = await client.message({ messages: [{ role: "user", content: "Hello" }] });
    expect(record.usage).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cacheWriteTokens: 30,
      cacheWrite1hTokens: 20,
      cacheReadTokens: 40,
    });
    expect(record.stopReason).toBe("end_turn");
    expect(record.ok).toBe(true);
  });

  it("refuses an answer that is not a message (Zod at the boundary)", async () => {
    const { fn } = scriptedFetch(
      sse([start({ content: [{ type: "tool_use", id: 3, name: "x" }] }), ...stop("tool_use", 1)]),
    );
    await expect(transport(fn).t.create(req())).rejects.toThrow(/invalid message from the API/);
  });

  it("fails a stream that sent no message", async () => {
    const { fn } = scriptedFetch(sse([{ event: "ping", data: { type: "ping" } }]));
    await expect(transport(fn).t.create(req())).rejects.toThrow(
      "request ended without sending any chunks",
    );
  });

  it("throws an error the stream carried, worded as the SDK did", async () => {
    const { fn } = scriptedFetch(
      sse([start(), { event: "error", data: errorBody("overloaded_error", "Overloaded") }]),
    );
    const error = await transport(fn)
      .t.create(req())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnthropicError);
    expect((error as Error).name).toBe("Error");
    expect((error as Error).message).toBe(
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    );
    expect((error as AnthropicError).type).toBe("overloaded_error");
  });
});

describe("anthropicTransport: retries and errors", () => {
  it("retries a 529 and a 429 after the waits asked for, then answers", async () => {
    const { fn, calls } = scriptedFetch(
      errorResponse(529, errorBody("overloaded_error", "Overloaded")),
      errorResponse(429, errorBody("rate_limit_error", "Slow down"), { "retry-after": "3" }),
      textAnswer("Hi"),
    );
    const { t, waits } = transport(fn);
    const message = await t.create(req());
    expect(message.content).toEqual([{ type: "text", text: "Hi", citations: null }]);
    expect(calls).toHaveLength(3);
    // The first wait is the backoff (0.5 s, no jitter with random 0); the second is retry-after.
    expect(waits).toEqual([500, 3000]);
    // Every attempt sends the same request.
    expect(new Set(calls.map((c) => c.init.body)).size).toBe(1);
  });

  it("gives up after two retries with the SDK's words, so run error keys read the same", async () => {
    const body = errorBody("overloaded_error", "Overloaded");
    const { fn, calls } = scriptedFetch(
      errorResponse(529, body),
      errorResponse(529, body),
      errorResponse(529, body),
    );
    const error = (await transport(fn)
      .t.create(req())
      .catch((e: unknown) => e)) as AnthropicError;
    expect(calls).toHaveLength(3);
    expect(error.message).toBe(
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    );
    expect(error.name).toBe("Error");
    expect(error.status).toBe(529);
    expect(error.type).toBe("overloaded_error");
    expect(error.requestId).toBe("req_err");
  });

  it("does not retry a 400 or a 401, and keeps a body that is not JSON", async () => {
    const { fn, calls } = scriptedFetch(
      errorResponse(400, errorBody("invalid_request_error", "max_tokens: too big")),
      errorResponse(401, "no key"),
      errorResponse(500, ""),
    );
    const { t } = transport(fn, { maxRetries: 0 });
    await expect(t.create(req())).rejects.toThrow(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too big"}}',
    );
    await expect(t.create(req())).rejects.toThrow(/^401 no key$/);
    await expect(t.create(req())).rejects.toThrow(/^500 status code \(no body\)$/);
    expect(calls).toHaveLength(3);
  });

  it("obeys x-should-retry either way", async () => {
    const { fn, calls } = scriptedFetch(
      errorResponse(400, errorBody("x", "retry me"), { "x-should-retry": "true" }),
      errorResponse(503, errorBody("x", "don't"), { "x-should-retry": "false" }),
    );
    await expect(transport(fn).t.create(req())).rejects.toThrow(/^503 /);
    expect(calls).toHaveLength(2);
  });

  it("retries a dropped connection, then says `Connection error.`", async () => {
    const { fn, calls } = scriptedFetch(
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    );
    const error = (await transport(fn)
      .t.create(req())
      .catch((e: unknown) => e)) as AnthropicConnectionError;
    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(AnthropicConnectionError);
    expect(error.message).toBe("Connection error.");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("times out the wait for the answer to start, retries, then says `Request timed out.`", async () => {
    let attempts = 0;
    const hanging = ((_url: string, init: RequestInit) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const { t } = transport(hanging, { timeoutMs: 5, maxRetries: 1 });
    await expect(t.create(req())).rejects.toThrow("Request timed out.");
    expect(attempts).toBe(2);
  });

  it("does not time out a stream that has started", async () => {
    const text = await textAnswer("Hello").text();
    const encoder = new TextEncoder();
    const fn = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            // Each event comes 10 ms after the last: longer than the 5 ms limit in all.
            for (const part of text.split(/(?<=\n\n)/)) {
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(encoder.encode(part));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const message = await transport(fn, { timeoutMs: 5 }).t.create(req());
    expect(message.content).toEqual([{ type: "text", text: "Hello", citations: null }]);
  });

  it("stops when the caller aborts, without retrying", async () => {
    let attempts = 0;
    const hanging = ((_url: string, init: RequestInit) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const pending = transport(hanging).t.create(req(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("Request was aborted.");
    expect(attempts).toBe(1);
    const already = new AbortController();
    already.abort();
    await expect(transport(hanging).t.create(req(), { signal: already.signal })).rejects.toThrow(
      "Request was aborted.",
    );
    expect(attempts).toBe(1);
  });
});

describe("anthropicRetryDelayMs", () => {
  const h = (headers: Record<string, string>) => new Headers(headers);
  it("prefers retry-after-ms, then retry-after in seconds or as a date", () => {
    expect(anthropicRetryDelayMs(0, h({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250);
    expect(anthropicRetryDelayMs(0, h({ "retry-after": "2" }))).toBe(2000);
    const now = () => Date.parse("2026-11-11T00:00:00Z");
    expect(
      anthropicRetryDelayMs(0, h({ "retry-after": "Wed, 11 Nov 2026 00:00:04 GMT" }), () => 0, now),
    ).toBe(4000);
  });
  it("backs off from 0.5 s to 8 s, less up to a quarter", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => anthropicRetryDelayMs(n, null, () => 0))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000,
    ]);
    expect(anthropicRetryDelayMs(0, null, () => 1)).toBe(375);
    expect(anthropicRetryDelayMs(1, h({ "retry-after": "0" }), () => 0)).toBe(1000);
  });
});

describe("readServerSentEvents", () => {
  it("reads events split across chunks, with CRLF, comments and many data lines", async () => {
    const encoder = new TextEncoder();
    const parts = [
      ": comment\r\nevent: a\r",
      "\ndata: 1\r\ndata: 2\r\n\r\nev",
      'ent: b\ndata: {"x":1}\n\ndata: last',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(encoder.encode(p));
        c.close();
      },
    });
    const events = [];
    for await (const e of readServerSentEvents(body)) events.push(e);
    expect(events).toEqual([
      { event: "a", data: "1\n2" },
      { event: "b", data: '{"x":1}' },
      { event: null, data: "last" },
    ]);
  });
});

describe("the message schema", () => {
  it("accepts every recorded answer under fixtures/llm", () => {
    const dir = resolve(PROVIDER_FIXTURE_DIR, "..");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const entry = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as {
        kind?: string;
        response: unknown;
      };
      if (entry.kind === "embedding") continue;
      const parsed = messageSchema.safeParse(entry.response);
      expect(parsed.success ? null : `${file}: ${z.prettifyError(parsed.error)}`).toBeNull();
      // Parsing keeps the answer as it was recorded.
      expect(parseMessage(entry.response)).toEqual(entry.response);
    }
  });

  it("keeps a block of a type we never ask for, but not a known type with the wrong shape", () => {
    const base = start().data.message;
    const other = { type: "code_execution_tool_result", tool_use_id: "s1", content: {} };
    expect(parseMessage({ ...base, stop_reason: "end_turn", content: [other] }).content).toEqual([
      other,
    ]);
    for (const wrong of [
      { type: "text" },
      {
        type: "web_search_tool_result",
        tool_use_id: "s1",
        content: [{ type: "web_search_result" }],
      },
    ]) {
      expect(() => parseMessage({ ...base, stop_reason: "end_turn", content: [wrong] })).toThrow(
        /invalid message/,
      );
    }
  });
});

describe("anthropicTransport: the server-side web tools (packages/agents' web.search and web.fetch)", () => {
  it("sends the tool as given and puts the search, its results and citations together", async () => {
    const results = [
      {
        type: "web_search_result",
        url: "https://example.com/a",
        title: "A",
        page_age: "3 days ago",
        encrypted_content: "enc",
      },
    ];
    const { fn, calls } = scriptedFetch(
      sse([
        start(),
        ev("content_block_start", {
          index: 0,
          content_block: {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: {},
            caller: { type: "direct" },
          },
        }),
        ev("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query": "invoices"}' },
        }),
        ev("content_block_stop", { index: 0 }),
        ev("content_block_start", {
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            caller: { type: "direct" },
            content: results,
          },
        }),
        ev("content_block_stop", { index: 1 }),
        ev("content_block_start", {
          index: 2,
          content_block: { type: "text", text: "", citations: null },
        }),
        ev("content_block_delta", {
          index: 2,
          delta: {
            type: "citations_delta",
            citation: {
              type: "web_search_result_location",
              url: "https://example.com/a",
              title: "A",
              cited_text: "Most teams approve by email.",
              encrypted_index: "idx",
            },
          },
        }),
        ev("content_block_delta", { index: 2, delta: { type: "text_delta", text: "Done." } }),
        ev("content_block_stop", { index: 2 }),
        ev("message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
          usage: {
            output_tokens: 20,
            server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
          },
        }),
        ev("message_stop"),
      ]),
    );
    const tools: LlmRequest["tools"] = [
      { type: "web_search_20250305", name: "web_search", max_uses: 1 },
    ];
    const message = await transport(fn).t.create(req({ tools }));
    expect(calls[0]?.body).toMatchObject({ tools, stream: true });
    expect(message.content).toEqual([
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "invoices" },
        caller: { type: "direct" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        caller: { type: "direct" },
        content: results,
      },
      {
        type: "text",
        text: "Done.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://example.com/a",
            title: "A",
            cited_text: "Most teams approve by email.",
            encrypted_index: "idx",
          },
        ],
      },
    ]);
    expect(message.usage.server_tool_use).toEqual({
      web_search_requests: 1,
      web_fetch_requests: 0,
    });
  });

  it("reads a fetched page's result block", () => {
    const fetched = {
      type: "web_fetch_tool_result",
      tool_use_id: "srvtoolu_2",
      content: {
        type: "web_fetch_result",
        url: "https://example.com/page",
        retrieved_at: "2026-11-11T00:00:00Z",
        content: {
          type: "document",
          source: { type: "text", media_type: "text/plain", data: "Hello" },
          title: "Page",
          citations: null,
        },
      },
    };
    const failed = {
      type: "web_fetch_tool_result",
      tool_use_id: "srvtoolu_3",
      content: { type: "web_fetch_tool_result_error", error_code: "url_not_accessible" },
    };
    const base = start().data.message;
    expect(
      parseMessage({ ...base, stop_reason: "end_turn", content: [fetched, failed] }).content,
    ).toEqual([fetched, failed]);
  });
});
