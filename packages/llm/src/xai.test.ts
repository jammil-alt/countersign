import { describe, expect, it } from "vitest";
import { MODELS } from "./models";
import { type OAResponse, toOpenAIRequest } from "./openai";
import { ProviderError } from "./provider";
import { json, noSleep, scriptedFetch } from "./test-fetch";
import type { LlmRequest } from "./transport";
import { fromXAIResponse, toXAIRequest, XAIError, XAIRequestError, xaiTransport } from "./xai";

const GROK = MODELS.grok;

function req(partial: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: GROK,
    max_tokens: 1000,
    messages: [{ role: "user", content: "Hello" }],
    ...partial,
  } as LlmRequest;
}

const answer = (partial: Partial<OAResponse> = {}): OAResponse => ({
  id: "resp_1",
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "Hi" }] }],
  usage: { input_tokens: 10, output_tokens: 2 },
  ...partial,
});

describe("toXAIRequest", () => {
  const conversation = req({
    system: [
      { type: "text", text: "You check invoices." },
      { type: "text", text: "Be brief." },
    ],
    messages: [
      { role: "user", content: "Check INV-1" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "get_invoice", input: { id: "INV-1" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"total":"12.50"}' }],
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
    output_config: { effort: "high" },
  });

  it("is OpenAI's request, with the system prompt as a first message and no effort", () => {
    const xai = toXAIRequest(conversation);
    const openai = toOpenAIRequest(conversation);
    expect(xai.model).toBe("grok-4.7");
    expect(xai.instructions).toBeUndefined();
    expect(xai.reasoning).toBeUndefined();
    expect(xai.input[0]).toEqual({
      type: "message",
      role: "system",
      content: "You check invoices.\n\nBe brief.",
    });
    // Everything else is the shared translation, unchanged.
    expect(xai.input.slice(1)).toEqual(openai.input);
    const { instructions: _i, reasoning: _r, model: _m, input: _in, ...rest } = openai;
    expect(xai).toMatchObject(rest);
    expect(xai.store).toBe(false);
    expect(xai.tools?.[0]).toMatchObject({ type: "function", name: "get_invoice" });
    expect(xai.parallel_tool_calls).toBe(false);
  });

  it("asks for structured output the same way, and leaves out a missing system prompt", () => {
    const out = toXAIRequest(
      req({ output_config: { format: { type: "json_schema", schema: { type: "object" } } } }),
    );
    expect(out.input[0]).toMatchObject({ role: "user" });
    expect(out.text?.format).toEqual({
      type: "json_schema",
      name: "output",
      schema: { type: "object" },
      strict: true,
    });
  });

  it("refuses what it can't express, naming xAI", () => {
    let error: unknown;
    try {
      toXAIRequest(req({ tools: [{ type: "web_search_20250305", name: "web_search" }] }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(XAIRequestError);
    expect((error as Error).message).toBe("the server tool web_search_20250305 can't go to xAI");
  });
});

describe("fromXAIResponse", () => {
  it("names the platform model and maps stops", () => {
    const m = fromXAIResponse(answer(), req());
    expect(m.model).toBe(GROK);
    expect(m.stop_reason).toBe("end_turn");
    const cut = fromXAIResponse(
      answer({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
      req(),
    );
    expect(cut.stop_reason).toBe("max_tokens");
    const refused = fromXAIResponse(
      answer({ output: [{ type: "message", content: [{ type: "refusal", refusal: "No." }] }] }),
      req(),
    );
    expect(refused.stop_reason).toBe("refusal");
  });

  it("throws xAI's error for a failed response", () => {
    expect(() =>
      fromXAIResponse(answer({ status: "failed", error: { message: "boom" } }), req()),
    ).toThrow(XAIError);
  });
});

describe("xaiTransport", () => {
  it("posts to xAI's /responses with the key", async () => {
    const f = scriptedFetch(json(answer()));
    const m = await xaiTransport({ apiKey: "xai-test", fetch: f.fn }).create(req());
    expect(m.content[0]).toMatchObject({ type: "text", text: "Hi" });
    expect(f.calls[0]?.url).toBe("https://api.x.ai/v1/responses");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer xai-test");
    expect(f.calls[0]?.body).toMatchObject({ model: "grok-4.7", store: false });
  });

  it("maps errors onto our kinds: rate limit, overload, a bad request, a timeout", async () => {
    const { sleep } = noSleep();
    const fail = async (res: Response | Error) =>
      xaiTransport({ apiKey: "k", fetch: scriptedFetch(res).fn, sleep, maxRetries: 0 })
        .create(req())
        .catch((e: unknown) => e as XAIError);

    const limited = await fail(
      json({ code: "Some resource has been exhausted", error: "Too many requests" }, 429),
    );
    expect(limited).toBeInstanceOf(XAIError);
    expect(limited).toBeInstanceOf(ProviderError);
    expect(limited).toMatchObject({
      kind: "rate_limited",
      status: 429,
      code: "Some resource has been exhausted",
      message: "xAI 429: Too many requests",
    });

    const busy = await fail(json({ error: "Service temporarily unavailable" }, 503));
    expect(busy).toMatchObject({
      kind: "overloaded",
      message: "xAI 503 (overloaded): Service temporarily unavailable",
    });

    const bad = await fail(json({ code: "Client specified an invalid argument", error: "x" }, 400));
    expect(bad).toMatchObject({ kind: "bad_request" });

    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const late = await fail(timeout);
    expect(late).toBeInstanceOf(XAIError);
    expect(late).toMatchObject({ kind: "timeout", message: "xAI timed out after 600 s" });
  });

  it("retries a rate limit after xAI's retry-after", async () => {
    const { waits, sleep } = noSleep();
    const f = scriptedFetch(
      json({ error: "slow down" }, 429, { "retry-after": "3" }),
      json(answer()),
    );
    await xaiTransport({ apiKey: "k", fetch: f.fn, sleep }).create(req());
    expect(f.calls).toHaveLength(2);
    expect(waits).toEqual([3000]);
  });
});
