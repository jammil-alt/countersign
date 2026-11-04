import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient, type LlmCallRecord, LlmToolError } from "./client";
import { FakeModel } from "./fake";
import { MODELS } from "./models";
import {
  fromOpenAIResponse,
  type OAResponse,
  OpenAIError,
  OpenAIRequestError,
  openaiTransport,
  toOpenAIRequest,
} from "./openai";
import { costOf } from "./pricing";
import { memoryFixtureStore, withRecording } from "./record";
import { ProviderNotConfiguredError, providerOf, routingTransport } from "./route";
import type { LlmRequest } from "./transport";
import { usageOf } from "./usage";

const GPT = MODELS.gpt;

function req(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: GPT,
    max_tokens: 1000,
    messages: [{ role: "user", content: "Hello" }],
    ...partial,
  } as LlmRequest;
}

function oaResponse(partial: Partial<OAResponse> = {}): OAResponse {
  return {
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hi there" }],
      },
    ],
    usage: {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 30 },
    },
    ...partial,
  };
}

/** A fetch that answers from a script and keeps what it was sent. */
function scriptedFetch(...answers: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) });
    const next = answers.shift();
    if (!next) throw new Error("scriptedFetch: no answer left");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("toOpenAIRequest", () => {
  it("translates a tool conversation into Responses input items", () => {
    const out = toOpenAIRequest(
      req({
        system: [
          { type: "text", text: "You check invoices." },
          { type: "text", text: "Be brief." },
        ],
        messages: [
          { role: "user", content: "Check INV-1" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm", signature: "s" },
              { type: "text", text: "Looking it up." },
              { type: "tool_use", id: "call_1", name: "get_invoice", input: { id: "INV-1" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "call_1", content: '{"total":"12.50"}' },
              {
                type: "tool_result",
                tool_use_id: "call_2",
                is_error: true,
                content: [{ type: "text", text: "not found" }],
              },
              { type: "text", text: "Finish when done." },
            ],
          },
        ],
        tools: [
          {
            name: "get_invoice",
            description: "Read one invoice",
            input_schema: { type: "object", properties: { id: { type: "string" } } },
          },
        ],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort: "max" },
      }),
    );
    expect(out).toEqual({
      model: "gpt-5.5",
      instructions: "You check invoices.\n\nBe brief.",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Check INV-1" }] },
        { type: "message", role: "assistant", content: "Looking it up." },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_invoice",
          arguments: '{"id":"INV-1"}',
        },
        { type: "function_call_output", call_id: "call_1", output: '{"total":"12.50"}' },
        { type: "function_call_output", call_id: "call_2", output: "Error: not found" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Finish when done." }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "get_invoice",
          description: "Read one invoice",
          parameters: { type: "object", properties: { id: { type: "string" } } },
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_output_tokens: 1000,
      reasoning: { effort: "high" },
      store: false,
    });
  });

  it("maps tool choice, strict tools, structured output, images and PDFs", () => {
    const out = toOpenAIRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
              {
                type: "document",
                title: "inv",
                source: { type: "base64", media_type: "application/pdf", data: "BBB" },
              },
            ],
          },
        ],
        tools: [{ name: "t", input_schema: { type: "object" }, strict: true }],
        tool_choice: { type: "tool", name: "t" },
        output_config: { format: { type: "json_schema", schema: { type: "object" } } },
      }),
    );
    expect(out.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AAA", detail: "auto" },
          { type: "input_file", filename: "inv.pdf", file_data: "data:application/pdf;base64,BBB" },
        ],
      },
    ]);
    expect(out.tools?.[0]?.strict).toBe(true);
    expect(out.tool_choice).toEqual({ type: "function", name: "t" });
    expect(out.text?.format).toEqual({
      type: "json_schema",
      name: "output",
      schema: { type: "object" },
      strict: true,
    });
    expect(toOpenAIRequest(req({ tool_choice: { type: "any" } })).tool_choice).toBe("required");
  });

  it("refuses blocks it can't express", () => {
    expect(() =>
      toOpenAIRequest(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "search_result",
                  source: "s",
                  title: "t",
                  content: [{ type: "text", text: "x" }],
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(OpenAIRequestError);
  });
});

describe("fromOpenAIResponse", () => {
  it("gives an Anthropic-shaped message with usage split into fresh and cached input", () => {
    const m = fromOpenAIResponse(oaResponse(), req());
    expect(m.model).toBe(GPT);
    expect(m.stop_reason).toBe("end_turn");
    expect(m.content).toEqual([{ type: "text", text: "Hi there", citations: null }]);
    expect(usageOf(m)).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 200,
    });
    // 1000 × $5 + 50 × $30 + 200 × $0.50 per million.
    expect(costOf(m.model, usageOf(m))).toBe("0.006600");
  });

  it("turns function calls into tool_use blocks", () => {
    const m = fromOpenAIResponse(
      oaResponse({
        output: [
          { type: "reasoning", id: "rs_1" },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_9",
            name: "get_invoice",
            arguments: '{"id":"INV-2"}',
          },
          { type: "function_call", id: "fc_2", call_id: "call_10", name: "x", arguments: "{oops" },
        ],
      }),
      req(),
    );
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toMatchObject([
      { type: "tool_use", id: "call_9", name: "get_invoice", input: { id: "INV-2" } },
      { type: "tool_use", id: "call_10", name: "x", input: "{oops" },
    ]);
  });

  it("maps refusals, truncation and failures", () => {
    const refusal = fromOpenAIResponse(
      oaResponse({
        output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help" }] }],
      }),
      req(),
    );
    expect(refusal.stop_reason).toBe("refusal");
    const cut = fromOpenAIResponse(
      oaResponse({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      req(),
    );
    expect(cut.stop_reason).toBe("max_tokens");
    expect(() =>
      fromOpenAIResponse(
        oaResponse({ status: "failed", error: { code: "server_error", message: "boom" } }),
        req(),
      ),
    ).toThrow(OpenAIError);
  });
});

describe("openaiTransport", () => {
  it("posts to /responses with the key and returns the translated message", async () => {
    const f = scriptedFetch(json(oaResponse()));
    const t = openaiTransport({ apiKey: "sk-test", fetch: f.fn });
    const m = await t.create(req());
    expect(m.content[0]).toMatchObject({ type: "text", text: "Hi there" });
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    const headers = f.calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(f.calls[0]?.body).toMatchObject({ model: "gpt-5.5", store: false });
  });

  it("retries rate limits and server errors, then gives up with OpenAI's message", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = scriptedFetch(
      json({ error: { message: "slow down" } }, 429, { "retry-after": "2" }),
      new TypeError("connection reset"),
      json(oaResponse()),
    );
    await openaiTransport({ apiKey: "k", fetch: ok.fn, sleep }).create(req());
    expect(ok.calls).toHaveLength(3);
    expect(waits).toEqual([2000, 1000]);

    const bad = scriptedFetch(
      json({ error: { message: "Invalid schema", code: "invalid_request" } }, 400),
    );
    const error = await openaiTransport({ apiKey: "k", fetch: bad.fn, sleep })
      .create(req())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAIError);
    expect((error as OpenAIError).status).toBe(400);
    expect((error as OpenAIError).message).toBe("OpenAI 400: Invalid schema");
    expect(bad.calls).toHaveLength(1);
  });

  it("works under the client's callTool, with cost and validation", async () => {
    const Verdict = z.object({ same: z.boolean(), reason: z.string() });
    const f = scriptedFetch(
      json(
        oaResponse({
          output: [
            {
              type: "function_call",
              call_id: "c1",
              name: "record_verdict",
              arguments: '{"same":true,"reason":"same SKU"}',
            },
          ],
        }),
      ),
      json(
        oaResponse({
          output: [
            {
              type: "function_call",
              call_id: "c2",
              name: "record_verdict",
              arguments: '{"same":"yes"}',
            },
          ],
        }),
      ),
    );
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: openaiTransport({ apiKey: "k", fetch: f.fn }),
      onCall: (r) => void records.push(r),
    });
    const tool = { name: "record_verdict", description: "Record it", schema: Verdict };
    const { value } = await llm.callTool({
      model: GPT,
      messages: [{ role: "user", content: "A vs B" }],
      tool,
    });
    expect(value).toEqual({ same: true, reason: "same SKU" });
    expect(records[0]).toMatchObject({ model: GPT, ok: true, costUsd: "0.006600" });
    expect(f.calls[0]?.body).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ name: "record_verdict" }],
    });

    const error = await llm
      .callTool({ model: GPT, messages: [{ role: "user", content: "A vs B" }], tool })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmToolError);
    expect((error as LlmToolError).code).toBe("invalid_input");
  });

  it("records and replays like any transport", async () => {
    const store = memoryFixtureStore();
    const f = scriptedFetch(json(oaResponse()));
    const recorder = withRecording(openaiTransport({ apiKey: "k", fetch: f.fn }), {
      mode: "record",
      store,
    });
    const first = await recorder.create(req());
    const replay = withRecording(null, { mode: "replay", store });
    expect(await replay.create(req())).toEqual(first);
    expect(f.calls).toHaveLength(1);
  });
});

describe("routingTransport", () => {
  it("sends openai: models to OpenAI and everything else to Anthropic", async () => {
    const anthropic = new FakeModel([{ text: "from claude" }]);
    const openai = new FakeModel([{ text: "from gpt" }]);
    const t = routingTransport({ anthropic, openai });
    expect((await t.create(req({ model: GPT }))).content[0]).toMatchObject({ text: "from gpt" });
    expect((await t.create(req({ model: MODELS.sonnet }))).content[0]).toMatchObject({
      text: "from claude",
    });
    expect(providerOf("openai:gpt-5.5")).toBe("openai");
    expect(providerOf("claude-opus-5-5")).toBe("anthropic");
  });

  it("names the missing key when a provider is not configured", async () => {
    const t = routingTransport({ anthropic: new FakeModel([]) });
    const error = await t.create(req({ model: GPT })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderNotConfiguredError);
    expect((error as Error).message).toBe(
      "no openai model is configured for openai:gpt-5.5: set OPENAI_API_KEY",
    );
  });
});
