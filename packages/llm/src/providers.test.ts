// xAI (Grok) and Google (Gemini) behind the one seam: request and answer translation, the wire,
// routing and cost.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient, type LlmCallRecord } from "./client";
import { FakeModel } from "./fake";
import {
  fromGeminiResponse,
  GeminiError,
  GeminiRequestError,
  type GResponse,
  geminiTransport,
  toGeminiRequest,
  UNSIGNED_CALL,
} from "./gemini";
import { MODELS } from "./models";
import { OpenAIError, toOpenAIRequest } from "./openai";
import { costOf, knownModelIds } from "./pricing";
import { memoryFixtureStore, withRecording } from "./record";
import { ProviderNotConfiguredError, providerOf, routingTransport } from "./route";
import type { LlmRequest } from "./transport";
import { usageOf } from "./usage";
import { XAI_DIALECT, xaiTransport } from "./xai";

function req(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODELS.gemini,
    max_tokens: 1000,
    messages: [{ role: "user", content: "Hello" }],
    ...partial,
  } as LlmRequest;
}

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function gResponse(partial: Partial<GResponse> = {}): GResponse {
  return {
    responseId: "g1",
    candidates: [
      { content: { role: "model", parts: [{ text: "Hi there" }] }, finishReason: "STOP" },
    ],
    usageMetadata: {
      promptTokenCount: 1200,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
    },
    ...partial,
  };
}

describe("models", () => {
  it("routes each prefix to its provider and prices every model", () => {
    expect(providerOf(MODELS.grok)).toBe("xai");
    expect(providerOf(MODELS.gemini)).toBe("google");
    expect(providerOf(MODELS.geminiFlash)).toBe("google");
    expect(providerOf(MODELS.gpt)).toBe("openai");
    expect(providerOf(MODELS.sonnet)).toBe("anthropic");
    for (const id of Object.values(MODELS)) expect(knownModelIds()).toContain(id);
  });

  it("prices Grok and Gemini, long prompts at the higher rate", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    };
    expect(costOf(MODELS.grok, usage)).toBe("16.000000");
    expect(costOf(MODELS.gemini, usage)).toBe("22.000000");
    expect(costOf(MODELS.gemini, { ...usage, inputTokens: 100_000 })).toBe("12.200000");
  });
});

describe("xaiTransport", () => {
  it("speaks the Responses API to api.x.ai without the prefix or a reasoning effort", async () => {
    const f = scriptedFetch(
      json({
        id: "resp_x",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Yo" }] },
        ],
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    const t = xaiTransport({ apiKey: "xai-test", fetch: f.fn });
    const m = await t.create(
      req({ model: MODELS.grok, output_config: { effort: "high" } } as Partial<LlmRequest>),
    );
    expect(m.content[0]).toMatchObject({ type: "text", text: "Yo" });
    expect(m.model).toBe(MODELS.grok);
    expect(f.calls[0]?.url).toBe("https://api.x.ai/v1/responses");
    expect((f.calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer xai-test",
    );
    expect(f.calls[0]?.body).toMatchObject({ model: "grok-4.7", store: false });
    expect(f.calls[0]?.body).not.toHaveProperty("reasoning");
    expect(toOpenAIRequest(req({ model: MODELS.grok }), XAI_DIALECT).model).toBe("grok-4.7");
  });

  it("names xAI in its errors", async () => {
    const f = scriptedFetch(json({ error: { message: "bad key", code: "unauthorized" } }, 401));
    const error = await xaiTransport({ apiKey: "k", fetch: f.fn })
      .create(req({ model: MODELS.grok }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAIError);
    expect((error as Error).message).toBe("xAI 401: bad key");
  });
});

describe("toGeminiRequest", () => {
  it("translates a tool conversation, carrying Gemini's signatures back", () => {
    const body = toGeminiRequest(
      req({
        system: "You are terse.",
        tools: [
          {
            name: "lookup",
            description: "Look it up",
            input_schema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        tool_choice: { type: "tool", name: "lookup" },
        messages: [
          { role: "user", content: "Find A" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "gemini:sig-1" },
              { type: "tool_use", id: "c1", name: "lookup", input: { q: "A" } },
              { type: "tool_use", id: "c2", name: "lookup", input: { q: "B" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "c1", content: "A is 1" },
              { type: "tool_result", tool_use_id: "c2", content: "not found", is_error: true },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "c3", name: "lookup", input: { q: "C" } }],
          },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "c3", content: "C" }] },
        ],
      }),
    );
    expect(body.systemInstruction).toEqual({ parts: [{ text: "You are terse." }] });
    expect(body.tools?.[0]?.functionDeclarations[0]).toMatchObject({
      name: "lookup",
      parametersJsonSchema: { type: "object" },
    });
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["lookup"] },
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Find A" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "c1", name: "lookup", args: { q: "A" } },
            thoughtSignature: "sig-1",
          },
          { functionCall: { id: "c2", name: "lookup", args: { q: "B" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "c1", name: "lookup", response: { result: "A is 1" } } },
          { functionResponse: { id: "c2", name: "lookup", response: { error: "not found" } } },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "c3", name: "lookup", args: { q: "C" } },
            thoughtSignature: UNSIGNED_CALL,
          },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { id: "c3", name: "lookup", response: { result: "C" } } }],
      },
    ]);
  });

  it("maps structured output, effort, images and PDFs; refuses what it can't express", () => {
    const body = toGeminiRequest(
      req({
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: { type: "object" } },
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: "BBB" },
              },
            ],
          },
        ],
      } as Partial<LlmRequest>),
    );
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 1000,
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
      thinkingConfig: { thinkingLevel: "low" },
    });
    expect(body.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAA" } },
      { inlineData: { mimeType: "application/pdf", data: "BBB" } },
    ]);
    expect(() =>
      toGeminiRequest(
        req({
          messages: [
            {
              role: "user",
              content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }],
            },
          ],
        }),
      ),
    ).toThrow(GeminiRequestError);
    expect(() =>
      toGeminiRequest(
        req({
          messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "nope" }] }],
        }),
      ),
    ).toThrow(GeminiRequestError);
  });
});

describe("fromGeminiResponse", () => {
  it("splits cached input from fresh and bills thinking as output", () => {
    const m = fromGeminiResponse(gResponse(), req());
    expect(m.content).toEqual([{ type: "text", text: "Hi there", citations: null }]);
    expect(m.stop_reason).toBe("end_turn");
    expect(m.model).toBe(MODELS.gemini);
    expect(usageOf(m)).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 200,
    });
  });

  it("turns function calls into tool_use blocks, keeping their signature", () => {
    const m = fromGeminiResponse(
      gResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "planning", thought: true },
                { functionCall: { name: "lookup", args: { q: "A" } }, thoughtSignature: "s1" },
                { functionCall: { name: "lookup", args: { q: "B" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
      req(),
    );
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toEqual([
      { type: "thinking", thinking: "", signature: "gemini:s1" },
      {
        type: "tool_use",
        id: "g1_call_0",
        name: "lookup",
        input: { q: "A" },
        caller: { type: "direct" },
      },
      {
        type: "tool_use",
        id: "g1_call_1",
        name: "lookup",
        input: { q: "B" },
        caller: { type: "direct" },
      },
    ]);
    // What came back goes out again as it came.
    const next = toGeminiRequest(
      req({
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: m.content },
        ],
      }),
    );
    expect(next.contents[1]?.parts[0]).toMatchObject({ thoughtSignature: "s1" });
  });

  it("maps refusals, blocked prompts and truncation", () => {
    const stop = (finishReason: string) =>
      fromGeminiResponse(
        gResponse({ candidates: [{ content: { parts: [] }, finishReason }] }),
        req(),
      ).stop_reason;
    expect(stop("SAFETY")).toBe("refusal");
    expect(stop("MAX_TOKENS")).toBe("max_tokens");
    const none = fromGeminiResponse(
      { responseId: "g2", promptFeedback: { blockReason: "SAFETY" } },
      req(),
    );
    expect(none.stop_reason).toBe("refusal");
  });
});

describe("geminiTransport", () => {
  it("posts to generateContent with the key, retries, and names Gemini in errors", async () => {
    const f = scriptedFetch(json({ error: { message: "busy" } }, 503), json(gResponse()));
    const t = geminiTransport({ apiKey: "g-key", fetch: f.fn, sleep: async () => {} });
    const m = await t.create(req());
    expect(m.content[0]).toMatchObject({ text: "Hi there" });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent",
    );
    expect(
      (f.calls[0]?.init.headers as Record<string, string> | undefined)?.["x-goog-api-key"],
    ).toBe("g-key");

    const bad = scriptedFetch(
      json({ error: { code: 400, message: "Invalid schema", status: "INVALID_ARGUMENT" } }, 400),
    );
    const error = await geminiTransport({ apiKey: "k", fetch: bad.fn })
      .create(req())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GeminiError);
    expect((error as GeminiError).code).toBe("INVALID_ARGUMENT");
    expect((error as Error).message).toBe("Gemini 400: Invalid schema");
  });

  it("works under callTool with cost, and records and replays", async () => {
    const Verdict = z.object({ same: z.boolean() });
    const answer = gResponse({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "record_verdict", args: { same: true } } }] },
          finishReason: "STOP",
        },
      ],
    });
    const f = scriptedFetch(json(answer));
    const store = memoryFixtureStore();
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: withRecording(geminiTransport({ apiKey: "k", fetch: f.fn }), {
        mode: "record",
        store,
      }),
      onCall: (r) => void records.push(r),
    });
    const input = {
      model: MODELS.gemini,
      messages: [{ role: "user" as const, content: "A vs B" }],
      tool: { name: "record_verdict", description: "Record it", schema: Verdict },
    };
    const { value } = await llm.callTool(input);
    expect(value).toEqual({ same: true });
    // 1000 fresh × $2 + 200 cached × $0.20 + 50 out × $12, per million.
    expect(records[0]).toMatchObject({ model: MODELS.gemini, ok: true, costUsd: "0.002640" });
    const replay = createLlmClient({ transport: withRecording(null, { mode: "replay", store }) });
    expect((await replay.callTool(input)).value).toEqual({ same: true });
    expect(f.calls).toHaveLength(1);
  });
});

describe("routingTransport", () => {
  it("sends xai: and gemini: models to their providers, and names a missing key", async () => {
    const t = routingTransport({
      anthropic: new FakeModel([{ text: "claude" }]),
      xai: new FakeModel([{ text: "grok" }]),
      google: new FakeModel([{ text: "gemini" }]),
    });
    expect((await t.create(req({ model: MODELS.grok }))).content[0]).toMatchObject({
      text: "grok",
    });
    expect((await t.create(req({ model: MODELS.gemini }))).content[0]).toMatchObject({
      text: "gemini",
    });
    const error = await routingTransport({})
      .create(req({ model: MODELS.gemini }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderNotConfiguredError);
    expect((error as Error).message).toBe(
      "no google model is configured for gemini:gemini-3.1-pro: set GEMINI_API_KEY",
    );
  });
});
