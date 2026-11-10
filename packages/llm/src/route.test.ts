import { describe, expect, it } from "vitest";
import { FakeModel } from "./fake";
import { MODELS } from "./models";
import { ProviderNotConfiguredError, providerOf, routingTransport } from "./route";
import type { LlmRequest } from "./transport";

const req = (model: string) =>
  ({ model, max_tokens: 10, messages: [{ role: "user", content: "Hi" }] }) as LlmRequest;

describe("routingTransport", () => {
  it("sends each model to the provider its prefix names", async () => {
    const t = routingTransport({
      anthropic: new FakeModel([{ text: "claude" }]),
      openai: new FakeModel([{ text: "gpt" }]),
      xai: new FakeModel([{ text: "grok" }]),
      google: new FakeModel([{ text: "gemini" }, { text: "gemini lite" }]),
    });
    const text = async (model: string) =>
      ((await t.create(req(model))).content[0] as { text: string }).text;
    expect(await text(MODELS.grok)).toBe("grok");
    expect(await text(MODELS.geminiPro)).toBe("gemini");
    expect(await text(MODELS.geminiFlashLite)).toBe("gemini lite");
    expect(await text(MODELS.gpt)).toBe("gpt");
    expect(await text(MODELS.sonnet)).toBe("claude");
  });

  it("reads the provider from the prefix only", () => {
    expect(providerOf("xai:grok-4.7")).toBe("xai");
    expect(providerOf("google:gemini-3.1-pro")).toBe("google");
    expect(providerOf("openai:gpt-5.5")).toBe("openai");
    expect(providerOf("claude-opus-5-5")).toBe("anthropic");
    // An unprefixed id is Anthropic's, whatever it says: it never reaches another vendor.
    expect(providerOf("grok-4.7")).toBe("anthropic");
    expect(providerOf("gemini-3.1-pro")).toBe("anthropic");
  });

  it("names the missing key when xAI or Gemini is not configured", async () => {
    const t = routingTransport({ anthropic: new FakeModel([]) });
    const fail = (model: string) =>
      t.create(req(model)).then(
        () => new Error("answered"),
        (e: unknown) => e as Error,
      );
    const xai = await fail(MODELS.grok);
    expect(xai).toBeInstanceOf(ProviderNotConfiguredError);
    expect(xai.message).toBe("no xai model is configured for xai:grok-4.7: set XAI_API_KEY");
    const google = await fail(MODELS.geminiPro);
    expect(google.message).toBe(
      "no google model is configured for google:gemini-3.1-pro: set GEMINI_API_KEY",
    );
  });
});
