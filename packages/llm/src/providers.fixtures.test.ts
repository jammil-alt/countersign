// xAI and Gemini end to end, on hand-written answers in each provider's own format
// (fixtures/llm/providers/<provider>/*.json; there are no keys here, so nothing was recorded live).
// Each answer goes through the real transport (a scripted fetch stands in for the network), and the
// result is also replayed from fixtures/llm like any recorded call (LLM_MODE=replay), so a change
// to a translation that would change what was recorded fails here.
//
// After changing a request below or a translation, rebuild the replay files, then delete the ones
// whose hashes no longer appear:
//   WRITE_PROVIDER_FIXTURES=1 pnpm --filter @countersign/llm exec vitest run src/providers.fixtures.test.ts

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { createLlmClient, type LlmCallRecord } from "./client";
import { GeminiError, geminiTransport } from "./gemini";
import { MODELS } from "./models";
import { fileFixtureStore } from "./node";
import type { HttpTransportOptions } from "./provider";
import { type FixtureStore, withRecording } from "./record";
import { routingTransport } from "./route";
import { fixtureResponse, noSleep, scriptedFetch } from "./test-fetch";
import type { LlmMessage, LlmRequest, LlmTransport } from "./transport";
import { XAIError, xaiTransport } from "./xai";

const WRITE = process.env.WRITE_PROVIDER_FIXTURES === "1";

const TOOL: Anthropic.Tool = {
  name: "get_invoice",
  description: "Read one invoice by its number",
  input_schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};
const SYSTEM = "You check invoices for a client. Use the tools to read them.";

const plainRequest = (model: string): LlmRequest => ({
  model,
  max_tokens: 1024,
  system: SYSTEM,
  messages: [{ role: "user", content: "Who is INV-1 from, and what does it total?" }],
});

const toolRequest = (model: string): LlmRequest => ({
  model,
  max_tokens: 1024,
  system: SYSTEM,
  messages: [{ role: "user", content: "What does INV-1 total?" }],
  tools: [TOOL],
  tool_choice: { type: "auto" },
});

/** The tool loop's next request: the call as the model made it, and the tool's result. */
const withResult = (first: LlmRequest, call: LlmMessage): LlmRequest => {
  const use = call.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return {
    ...first,
    messages: [
      ...first.messages,
      { role: "assistant", content: call.content as Anthropic.ContentBlockParam[] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: use?.id ?? "",
            content: '{"id":"INV-1","vendor":"Acme Supply","total":"12.50","currency":"USD"}',
          },
        ],
      },
    ],
  };
};

type Provider = "xai" | "gemini";
const PROVIDERS: {
  provider: Provider;
  model: string;
  transport: (o: HttpTransportOptions) => LlmTransport;
}[] = [
  { provider: "xai", model: MODELS.grok, transport: xaiTransport },
  { provider: "gemini", model: MODELS.geminiPro, transport: geminiTransport },
];

const handWritten = (store: FixtureStore): FixtureStore => ({
  read: (hash) => store.read(hash),
  write: (call) => store.write({ ...call, handWritten: true } as typeof call),
});

/** The provider's answer through its transport; with WRITE set, also written as a replay file. */
async function answer(
  p: (typeof PROVIDERS)[number],
  fixture: string,
  request: LlmRequest,
): Promise<{ message: LlmMessage; sent: unknown }> {
  const f = scriptedFetch(fixtureResponse(p.provider, fixture));
  const live = p.transport({ apiKey: "test-key", fetch: f.fn });
  const message = WRITE
    ? await withRecording(live, {
        mode: "record",
        store: handWritten(fileFixtureStore()),
        now: () => new Date("2026-11-10T12:00:00.000Z"),
      }).create(request)
    : await live.create(request);
  return { message, sent: f.calls[0]?.body };
}

const replay = withRecording(null, { mode: "replay", store: fileFixtureStore() });

describe.each(PROVIDERS)("$provider, from hand-written answers", (p) => {
  it("a plain answer: translated, priced, and replayed as recorded", async () => {
    const request = plainRequest(p.model);
    const { message } = await answer(p, "plain", request);
    expect(message.model).toBe(p.model);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content.filter((b) => b.type === "text")).toEqual([
      {
        type: "text",
        text: "Invoice INV-1 is from Acme Supply and totals $12.50.",
        citations: null,
      },
    ]);
    expect(await replay.create(request)).toEqual(message);

    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: routingTransport({ [p.provider === "xai" ? "xai" : "google"]: replay }),
      onCall: (r) => void records.push(r),
    });
    await llm.message(request);
    // xAI: 1000 fresh × $2 + 60 × $6 + 200 cached × $0.50; Gemini: 1000 × $2 + 90 × $12 + 200 × $0.20.
    expect(records[0]).toMatchObject({
      model: p.model,
      ok: true,
      costUsd: p.provider === "xai" ? "0.002460" : "0.003120",
    });
  });

  it("a tool call, then the answer to its result: the loop's second request carries the call", async () => {
    const first = toolRequest(p.model);
    const { message: call, sent: firstSent } = await answer(p, "tool-call", first);
    expect(call.stop_reason).toBe("tool_use");
    const use = call.content.find((b) => b.type === "tool_use");
    expect(use).toMatchObject({ name: "get_invoice", input: { id: "INV-1" } });
    expect(await replay.create(first)).toEqual(call);

    const second = withResult(first, call);
    const { message: final, sent } = await answer(p, "tool-result", second);
    expect(final.stop_reason).toBe("end_turn");
    expect(final.content).toEqual([
      { type: "text", text: "INV-1 totals $12.50.", citations: null },
    ]);
    expect(await replay.create(second)).toEqual(final);

    if (p.provider === "xai") {
      expect(firstSent).toMatchObject({
        model: "grok-4.7",
        input: [{ role: "system", content: SYSTEM }, { role: "user" }],
        tools: [{ type: "function", name: "get_invoice", strict: false }],
        store: false,
      });
      expect((sent as { input: unknown[] }).input.slice(2)).toEqual([
        {
          type: "function_call",
          call_id: "call_xai_0001",
          name: "get_invoice",
          arguments: '{"id":"INV-1"}',
        },
        {
          type: "function_call_output",
          call_id: "call_xai_0001",
          output: '{"id":"INV-1","vendor":"Acme Supply","total":"12.50","currency":"USD"}',
        },
      ]);
    } else {
      expect(firstSent).toMatchObject({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        tools: [{ functionDeclarations: [{ name: "get_invoice" }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      });
      // Gemini 3 needs the call's thought signature back; the response names its function.
      expect((sent as { contents: unknown[] }).contents.slice(1)).toEqual([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "get_invoice", args: { id: "INV-1" } },
              thoughtSignature: "EqYCAdHtim9toolCallSignatureForFixtureOnly",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "get_invoice",
                response: {
                  output: '{"id":"INV-1","vendor":"Acme Supply","total":"12.50","currency":"USD"}',
                },
              },
            },
          ],
        },
      ]);
    }
  });
});

describe("errors, from hand-written answers", () => {
  const { sleep } = noSleep();
  const failWith = (transport: LlmTransport, model: string) =>
    transport.create(plainRequest(model)).catch((e: unknown) => e as Error);

  it("xAI's rate limit is a rate_limited XAIError", async () => {
    const f = scriptedFetch(fixtureResponse("xai", "error-rate-limit"));
    const error = await failWith(
      xaiTransport({ apiKey: "k", fetch: f.fn, sleep, maxRetries: 0 }),
      MODELS.grok,
    );
    expect(error).toBeInstanceOf(XAIError);
    expect(error).toMatchObject({
      kind: "rate_limited",
      status: 429,
      message:
        "xAI 429: Your team has exceeded its requests per minute for model grok-4.7. Please try again later.",
    });
  });

  it("Gemini's overload and quota are overloaded and rate_limited GeminiErrors", async () => {
    const busy = await failWith(
      geminiTransport({
        apiKey: "k",
        fetch: scriptedFetch(fixtureResponse("gemini", "error-overloaded")).fn,
        sleep,
        maxRetries: 0,
      }),
      MODELS.geminiPro,
    );
    expect(busy).toBeInstanceOf(GeminiError);
    expect(busy).toMatchObject({
      kind: "overloaded",
      message: "Google 503 (overloaded): The model is overloaded. Please try again later.",
    });
    const quota = await failWith(
      geminiTransport({
        apiKey: "k",
        fetch: scriptedFetch(fixtureResponse("gemini", "error-rate-limit")).fn,
        sleep,
        maxRetries: 0,
      }),
      MODELS.geminiPro,
    );
    expect(quota).toMatchObject({ kind: "rate_limited", code: "RESOURCE_EXHAUSTED" });
  });

  it("a prompt Gemini blocks is a refusal, which the client records as not ok", async () => {
    const records: LlmCallRecord[] = [];
    const llm = createLlmClient({
      transport: geminiTransport({
        apiKey: "k",
        fetch: scriptedFetch(fixtureResponse("gemini", "blocked")).fn,
      }),
      onCall: (r) => void records.push(r),
    });
    const { message } = await llm.message(plainRequest(MODELS.geminiPro));
    expect(message.stop_reason).toBe("refusal");
    expect(records[0]).toMatchObject({ ok: false, stopReason: "refusal" });
  });
});
