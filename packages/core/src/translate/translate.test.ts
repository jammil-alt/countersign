import { describe, expect, it } from "vitest";
import { detectLanguage } from "./detect";
import {
  clipForTranslation,
  isPayloadPath,
  payloadText,
  TRANSLATION_OFF,
  translationOf,
  translationWanted,
} from "./settings";

describe("detectLanguage", () => {
  it.each([
    ["en", "Hi, can you send the quote for the birch plywood by tomorrow? Thanks"],
    ["es", "Hola, ¿me puede enviar la cotización del triplay para mañana? Gracias"],
    ["fr", "Bonjour, pouvez-vous nous envoyer le devis pour demain ? Merci beaucoup"],
    ["pt-BR", "Olá, você pode mandar o orçamento amanhã? Muito obrigado"],
    ["it", "Ciao, puoi mandare il preventivo per domani? Grazie mille"],
    ["de", "Hallo, können Sie mir bitte das Angebot für morgen schicken? Danke"],
  ])("is sure of %s", (language, text) => {
    expect(detectLanguage(text)).toMatchObject({ language, confidence: "sure" });
  });

  it("calls another script unknown, sure, and never guesses one of the six", () => {
    expect(detectLanguage("明日までに見積もりを送ってください")).toMatchObject({
      language: "unknown",
      confidence: "sure",
    });
    expect(detectLanguage("Пришлите, пожалуйста, счёт завтра")).toMatchObject({
      language: "unknown",
      confidence: "sure",
    });
  });

  it("is not sure of a short or mixed text, and counts its letters", () => {
    expect(detectLanguage("ok 👍")).toMatchObject({ confidence: "unsure", letters: 2 });
    expect(detectLanguage("Sí, mañana").confidence).not.toBe("sure");
    expect(detectLanguage("12345 !!!")).toMatchObject({ language: "unknown", letters: 0 });
  });

  it("stays fast on a long hostile text (no backtracking)", () => {
    const text = `${"a".repeat(50_000)}!${"é ".repeat(20_000)}`;
    const t0 = Date.now();
    detectLanguage(text);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("translation settings", () => {
  it("is off when absent, unreadable or with no working language", () => {
    expect(translationOf(undefined)).toEqual(TRANSLATION_OFF);
    expect(translationOf({ translation: { working: "xx" } })).toEqual(TRANSLATION_OFF);
    expect(translationOf({ translation: { working: null, incoming: true } })).toEqual(
      TRANSLATION_OFF,
    );
  });

  it("fills the defaults once a working language is set", () => {
    expect(translationOf({ translation: { working: "es" } })).toMatchObject({
      working: "es",
      incoming: true,
      outgoing: true,
      threads: true,
      model: null,
      dailyLimit: 200,
    });
  });

  it("lets a contact's switch win over the client's, both ways", () => {
    const on = translationOf({ translation: { working: "es" } });
    const off = translationOf({ translation: { working: "es", incoming: false } });
    expect(translationWanted(on, {}, "incoming")).toBe(true);
    expect(translationWanted(on, { incoming: false }, "incoming")).toBe(false);
    expect(translationWanted(off, { incoming: true }, "incoming")).toBe(true);
    expect(translationWanted(off, null, "incoming")).toBe(false);
    // With translation off for the client, a contact can't turn it on: there is no target.
    expect(translationWanted(TRANSLATION_OFF, { incoming: true }, "incoming")).toBe(false);
  });
});

describe("clipForTranslation", () => {
  it("keeps a short text whole", () => {
    expect(clipForTranslation("Hola")).toEqual({ text: "Hola", truncated: false });
  });

  it("cuts a long one at a sentence end near the limit", () => {
    const sentence = "Necesitamos doce hojas para el viernes. ";
    const text = sentence.repeat(300);
    const out = clipForTranslation(text, 1000);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(1000);
    expect(out.text.endsWith(".")).toBe(true);
  });
});

describe("payload paths", () => {
  it("reads a string at a dotted path, and refuses anything else", () => {
    const payload = { body: { comment: "Hola", n: 3 }, text: "x" };
    expect(payloadText(payload, "body.comment")).toBe("Hola");
    expect(payloadText(payload, "body.n")).toBeNull();
    expect(payloadText(payload, "body.missing")).toBeNull();
    expect(isPayloadPath("__proto__.x")).toBe(false);
    expect(isPayloadPath("a.b.c.d.e.f")).toBe(false);
    expect(isPayloadPath("a b")).toBe(false);
    expect(isPayloadPath("")).toBe(false);
  });
});
