// P-7: one translation on the fake model: the answer is read only when the model finished it.

import { createLlmClient, FakeModel } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { TranslateError, translateOnce } from "./translate";

const REQUEST = {
  text: "Hola, ¿llega el viernes?",
  from: null,
  to: "en",
  model: "claude-sonnet-5-5",
};

describe("translateOnce", () => {
  it("returns the checked translation", async () => {
    const model = new FakeModel([
      {
        toolUse: {
          name: "finish",
          input: { sourceLanguage: "es", translation: "Hi, does it arrive Friday?" },
        },
      },
    ]);
    const out = await translateOnce(createLlmClient({ transport: model }), REQUEST as never);
    expect(out).toEqual({ sourceLanguage: "es", translation: "Hi, does it arrive Friday?" });
  });

  it("never uses a translation cut off at max_tokens", async () => {
    const model = new FakeModel([
      {
        toolUse: { name: "finish", input: { sourceLanguage: "es", translation: "Hi, does" } },
        cutOff: true,
      },
    ]);
    const error = await translateOnce(
      createLlmClient({ transport: model }),
      REQUEST as never,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TranslateError);
    expect((error as Error).message).toBe("the answer was cut off");
  });
});
