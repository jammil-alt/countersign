// Provider answers that don't fit are refused at the boundary (invariant 5), as Anthropic's
// `parseMessage` refuses its own: a 200 that isn't an answer, an answer with no usage, or a
// function call with no name is a typed provider error, never an empty turn priced at $0.

import { describe, expect, it } from "vitest";
import { createLlmClient } from "./client";
import { GeminiError, geminiTransport } from "./gemini";
import { MODELS } from "./models";
import { OpenAIError, openaiTransport } from "./openai";
import type { LlmRequest } from "./transport";

function fetchOnce(body: unknown) {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const ASK: LlmRequest = {
  model: MODELS.gpt,
  max_tokens: 1000,
  messages: [{ role: "user", content: "Hello" }],
};

describe("OpenAI and xAI answers", () => {
  it("(PLATFORM_QA AI-4) a 200 answer that isn't a Responses object is a provider error, not an empty turn", async () => {
    const t = openaiTransport({ apiKey: "sk-test", fetch: fetchOnce({}), maxRetries: 0 });
    await expect(t.create(ASK)).rejects.toThrow(OpenAIError);
  });

  it("(PLATFORM_QA AI-4) an answer with no usage block is refused rather than priced at 0 tokens", async () => {
    const t = openaiTransport({
      apiKey: "sk-test",
      fetch: fetchOnce({
        id: "resp_1",
        status: "completed",
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "finish",
            arguments: '{"total":"12.00"}',
          },
        ],
      }),
      maxRetries: 0,
    });
    const records: { costUsd: string | null; tokens: number }[] = [];
    const llm = createLlmClient({
      transport: t,
      onCall: (r) => {
        records.push({ costUsd: r.costUsd, tokens: r.usage.inputTokens + r.usage.outputTokens });
      },
    });
    const outcome = await llm.message(ASK).then(
      () => "accepted",
      () => "refused",
    );
    expect({ outcome, records }).toMatchObject({ outcome: "refused" });
  });

  it("(PLATFORM_QA AI-4) a function call with no name is a provider error", async () => {
    const t = openaiTransport({
      apiKey: "sk-test",
      fetch: fetchOnce({
        id: "resp_2",
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", arguments: "{}" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      maxRetries: 0,
    });
    await expect(t.create(ASK)).rejects.toThrow(/function call with no name/);
  });
});

describe("Gemini answers", () => {
  const GEMINI = { ...ASK, model: MODELS.geminiPro };

  it("(PLATFORM_QA AI-4) a 200 answer with no candidate and no block reason is a provider error, not an empty turn", async () => {
    const t = geminiTransport({ apiKey: "g-test", fetch: fetchOnce({}), maxRetries: 0 });
    await expect(t.create(GEMINI)).rejects.toThrow(GeminiError);
    const noCandidate = geminiTransport({
      apiKey: "g-test",
      fetch: fetchOnce({ usageMetadata: { promptTokenCount: 3 } }),
      maxRetries: 0,
    });
    await expect(noCandidate.create(GEMINI)).rejects.toThrow(/no candidate/);
  });

  it("(PLATFORM_QA AI-4) a function call with no name and non-object args is refused at the boundary", async () => {
    const t = geminiTransport({
      apiKey: "g-test",
      fetch: fetchOnce({
        responseId: "r1",
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { args: "not an object" } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
      maxRetries: 0,
    });
    await expect(t.create(GEMINI)).rejects.toThrow(GeminiError);
  });
});
