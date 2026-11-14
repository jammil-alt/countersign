import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmClient, type LlmCallRecord } from "./client";
import {
  fromGeminiResponse,
  GEMINI_SKIP_SIGNATURE,
  GeminiError,
  GeminiRequestError,
  type GeminiResponse,
  geminiTransport,
  toGeminiRequest,
} from "./gemini";
import { MODELS } from "./models";
import { costOf } from "./pricing";
import { json, noSleep, scriptedFetch } from "./test-fetch";
import type { LlmRequest } from "./transport";
import { usageOf } from "./usage";

const PRO = MODELS.geminiPro;

function req(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: PRO,
    max_tokens: 1000,
    messages: [{ role: "user", content: "Hello" }],
    ...partial,
  } as LlmRequest;
}

const answer = (partial: Partial<GeminiResponse> = {}): GeminiResponse => ({
  candidates: [{ content: { role: "model", parts: [{ text: "Hi there" }] }, finishReason: "STOP" }],
  usageMetadata: {
    promptTokenCount: 1200,
    cachedContentTokenCount: 200,
    candidatesTokenCount: 40,
    thoughtsTokenCount: 50,
  },
  responseId: "r1",
  ...partial,
});

describe("toGeminiRequest", () => {
  it("translates a tool conversation into contents, with signatures and names", () => {
    const out = toGeminiRequest(
      req({
        system: [
          { type: "text", text: "You check invoices." },
          { type: "text", text: "Be brief." },
        ],
        messages: [
          { role: "user", content: "Check INV-1 and INV-2" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "", signature: "gemini:SIG1" },
              {
                type: "tool_use",
                id: "gemini_call_r0_0",
                name: "get_invoice",
                input: { id: "INV-1" },
              },
              { type: "tool_use", id: "fc_2", name: "get_invoice", input: { id: "INV-2" } },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "gemini_call_r0_0",
                content: '{"total":"12.50"}',
              },
              {
                type: "tool_result",
                tool_use_id: "fc_2",
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
            input_schema: {
              type: "object",
              properties: { id: { type: "string" } },
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        output_config: { effort: "max" },
      }),
    );
    expect(out).toEqual({
      systemInstruction: { parts: [{ text: "You check invoices.\n\nBe brief." }] },
      contents: [
        { role: "user", parts: [{ text: "Check INV-1 and INV-2" }] },
        {
          role: "model",
          parts: [
            // Our own id for a call Gemini gave none is not sent back; the signature is.
            {
              functionCall: { name: "get_invoice", args: { id: "INV-1" } },
              thoughtSignature: "SIG1",
            },
            { functionCall: { id: "fc_2", name: "get_invoice", args: { id: "INV-2" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: { name: "get_invoice", response: { output: '{"total":"12.50"}' } },
            },
            {
              functionResponse: {
                id: "fc_2",
                name: "get_invoice",
                response: { error: "not found" },
              },
            },
            { text: "Finish when done." },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_invoice",
              description: "Read one invoice",
              parametersJsonSchema: {
                type: "object",
                properties: { id: { type: "string" } },
                additionalProperties: false,
              },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: "high" } },
    });
  });

  it("signs calls Gemini didn't make, and drops Anthropic's thinking", () => {
    // How confer, converse and oversight start a loop: a call the platform wrote itself.
    const out = toGeminiRequest(
      req({
        messages: [
          { role: "user", content: "Read the step, then answer with `finish`." },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Claude's thought", signature: "anthropic-sig" },
              { type: "text", text: "Reading." },
              { type: "tool_use", id: "toolu_read", name: "read_step", input: {} },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "{}" }],
          },
        ],
      }),
    );
    expect(out.contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Reading." },
        {
          functionCall: { id: "toolu_read", name: "read_step", args: {} },
          thoughtSignature: GEMINI_SKIP_SIGNATURE,
        },
      ],
    });
    expect(out.contents[2]?.parts[0]).toEqual({
      functionResponse: { id: "toolu_read", name: "read_step", response: { output: "{}" } },
    });
  });

  it("maps tool choice, effort, structured output, images and PDFs", () => {
    const out = toGeminiRequest(
      req({
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
        tools: [{ name: "t", input_schema: { type: "object" } }],
        tool_choice: { type: "tool", name: "t" },
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: { type: "object" } },
        },
      }),
    );
    expect(out.contents[0]?.parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "AAA" } },
      { inlineData: { mimeType: "application/pdf", data: "BBB" } },
    ]);
    expect(out.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["t"] },
    });
    expect(out.generationConfig).toEqual({
      maxOutputTokens: 1000,
      thinkingConfig: { thinkingLevel: "low" },
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
    });
    expect(toGeminiRequest(req({ tool_choice: { type: "any" } })).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    });
    expect(toGeminiRequest(req()).systemInstruction).toBeUndefined();
  });

  it("refuses what it can't express", () => {
    const refused = (r: LlmRequest) => {
      try {
        toGeminiRequest(r);
      } catch (e) {
        return e;
      }
      return null;
    };
    expect(
      refused(
        req({
          messages: [
            { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "1" }] },
          ],
        }),
      ),
    ).toBeInstanceOf(GeminiRequestError);
    expect(
      refused(
        req({
          messages: [
            {
              role: "user",
              content: [{ type: "image", source: { type: "url", url: "https://x/a.png" } }],
            },
          ],
        }),
      ),
    ).toBeInstanceOf(GeminiRequestError);
    const server = refused(req({ tools: [{ type: "web_search_20250305", name: "web_search" }] }));
    expect((server as Error).message).toBe(
      "the server tool web_search_20250305 can't go to Gemini",
    );
  });
});

describe("fromGeminiResponse", () => {
  it("gives an Anthropic-shaped message with usage split into fresh and cached input", () => {
    const m = fromGeminiResponse(answer(), req());
    expect(m.model).toBe(PRO);
    expect(m.id).toBe("r1");
    expect(m.stop_reason).toBe("end_turn");
    expect(m.content).toEqual([{ type: "text", text: "Hi there", citations: null }]);
    expect(usageOf(m)).toEqual({
      inputTokens: 1000,
      outputTokens: 90,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 200,
    });
    // 1000 × $2 + 90 × $12 + 200 × $0.20 per million.
    expect(costOf(m.model, usageOf(m))).toBe("0.003120");
  });

  it("turns function calls into tool_use blocks, keeping signatures and Gemini's ids", () => {
    const m = fromGeminiResponse(
      answer({
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking out loud", thought: true },
                { functionCall: { name: "a", args: { x: 1 } }, thoughtSignature: "S1" },
                { functionCall: { name: "b" } },
                { functionCall: { id: "g-3", name: "c", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
      req(),
    );
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toMatchObject([
      { type: "thinking", thinking: "", signature: "gemini:S1" },
      { type: "tool_use", id: "gemini_call_r1_0", name: "a", input: { x: 1 } },
      { type: "tool_use", id: "gemini_call_r1_1", name: "b", input: {} },
      { type: "tool_use", id: "g-3", name: "c", input: {} },
    ]);
    // The transcript goes back as it came: the signature on its call, our ids left out.
    const next = toGeminiRequest(
      req({
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content: m.content as never },
        ],
      }),
    );
    expect(next.contents[1]?.parts).toEqual([
      { functionCall: { name: "a", args: { x: 1 } }, thoughtSignature: "S1" },
      { functionCall: { name: "b", args: {} } },
      { functionCall: { id: "g-3", name: "c", args: {} } },
    ]);
  });

  it("maps finish reasons: length, safety, a blocked prompt; joins split text", () => {
    const stop = (finishReason: string) =>
      fromGeminiResponse(
        answer({ candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }] }),
        req(),
      ).stop_reason;
    expect(stop("MAX_TOKENS")).toBe("max_tokens");
    expect(stop("SAFETY")).toBe("refusal");
    expect(stop("RECITATION")).toBe("refusal");
    expect(stop("PROHIBITED_CONTENT")).toBe("refusal");
    expect(stop("MALFORMED_FUNCTION_CALL")).toBe("end_turn");
    const blocked = fromGeminiResponse(
      { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 5 } },
      req(),
    );
    expect(blocked.stop_reason).toBe("refusal");
    expect(blocked.content).toEqual([
      { type: "text", text: "Google blocked the request (SAFETY)", citations: null },
    ]);
    const split = fromGeminiResponse(
      answer({
        candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] }, finishReason: "STOP" }],
      }),
      req(),
    );
    expect(split.content).toEqual([{ type: "text", text: "ab", citations: null }]);
  });
});

describe("geminiTransport", () => {
  it("posts to the model's generateContent with the key in its header", async () => {
    const f = scriptedFetch(json(answer()));
    const m = await geminiTransport({ apiKey: "g-test", fetch: f.fn }).create(req());
    expect(m.content[0]).toMatchObject({ type: "text", text: "Hi there" });
    expect(f.calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent",
    );
    expect(f.calls[0]?.headers["x-goog-api-key"]).toBe("g-test");
    expect(f.calls[0]?.headers.authorization).toBeUndefined();
    // Nothing is kept at Google: the request is the whole transcript, with no cache or session.
    expect(Object.keys(f.calls[0]?.body as object).sort()).toEqual([
      "contents",
      "generationConfig",
    ]);
  });

  it("maps Google's errors onto our kinds and retries the ones that pass", async () => {
    const { waits, sleep } = noSleep();
    const err = (code: number, status: string, message: string) =>
      json({ error: { code, status, message } }, code);
    const busy = scriptedFetch(
      err(503, "UNAVAILABLE", "The model is overloaded. Please try again later."),
      err(503, "UNAVAILABLE", "The model is overloaded. Please try again later."),
      err(503, "UNAVAILABLE", "The model is overloaded. Please try again later."),
    );
    const e1 = await geminiTransport({ apiKey: "k", fetch: busy.fn, sleep })
      .create(req())
      .catch((e: unknown) => e as GeminiError);
    expect(busy.calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
    expect(e1).toBeInstanceOf(GeminiError);
    expect(e1).toMatchObject({
      kind: "overloaded",
      status: 503,
      code: "UNAVAILABLE",
      message: "Google 503 (overloaded): The model is overloaded. Please try again later.",
    });

    const quota = scriptedFetch(err(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted"));
    const e2 = await geminiTransport({ apiKey: "k", fetch: quota.fn, sleep, maxRetries: 0 })
      .create(req())
      .catch((e: unknown) => e as GeminiError);
    expect(e2).toMatchObject({
      kind: "rate_limited",
      message: "Google 429: Resource has been exhausted",
    });

    const bad = scriptedFetch(err(400, "INVALID_ARGUMENT", "Invalid JSON payload"));
    const e3 = await geminiTransport({ apiKey: "k", fetch: bad.fn, sleep })
      .create(req())
      .catch((e: unknown) => e as GeminiError);
    expect(bad.calls).toHaveLength(1);
    expect(e3).toMatchObject({ kind: "bad_request", code: "INVALID_ARGUMENT" });
  });

  it("works under the client's callTool, with cost", async () => {
    const Verdict = z.object({ same: z.boolean(), reason: z.string() });
    const f = scriptedFetch(
      json(
        answer({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "record_verdict",
                      args: { same: true, reason: "same SKU" },
                    },
                    thoughtSignature: "S",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      ),
    );
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: geminiTransport({ apiKey: "k", fetch: f.fn }),
      onCall: (r) => void records.push(r),
    });
    const { value } = await llm.callTool({
      model: PRO,
      messages: [{ role: "user", content: "A vs B" }],
      tool: { name: "record_verdict", description: "Record it", schema: Verdict },
    });
    expect(value).toEqual({ same: true, reason: "same SKU" });
    expect(records[0]).toMatchObject({ model: PRO, ok: true, costUsd: "0.003120" });
    expect(f.calls[0]?.body).toMatchObject({
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      tools: [{ functionDeclarations: [{ name: "record_verdict" }] }],
    });
  });
});
