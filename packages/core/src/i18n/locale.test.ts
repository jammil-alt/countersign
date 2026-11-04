import { describe, expect, it } from "vitest";
import { SkillDefinition } from "../schemas/skill";
import { ToolSpec } from "../schemas/tool";
import { renderSummary } from "../template/template";
import {
  clientLanguage,
  LocalizedString,
  matchLocale,
  parseAcceptLanguage,
  pickLocalized,
  resolveLocale,
  userLanguage,
} from "./locale";

describe("resolveLocale", () => {
  it("takes the user's choice over the client's, the browser's and English", () => {
    expect(resolveLocale({ user: "de", client: "es", browser: ["fr-FR"] })).toBe("de");
  });

  it("takes the client's default when the user has none", () => {
    expect(resolveLocale({ user: null, client: "es", browser: ["fr-FR"] })).toBe("es");
  });

  it("takes the browser's first language we have when neither is set", () => {
    expect(resolveLocale({ browser: ["ja-JP", "fr-CA", "de"] })).toBe("fr");
  });

  it("falls back to English", () => {
    expect(resolveLocale({})).toBe("en");
    expect(resolveLocale({ browser: ["ja", "zh-CN"] })).toBe("en");
  });

  it("skips stored values that aren't languages we have", () => {
    expect(resolveLocale({ user: "xx", client: "es-MX", browser: ["it"] })).toBe("it");
  });
});

describe("matchLocale", () => {
  it("shares a translation across a language's regions", () => {
    expect(matchLocale("es-MX")).toBe("es");
    expect(matchLocale("fr_CA")).toBe("fr");
    expect(matchLocale("pt-PT")).toBe("pt-BR");
    expect(matchLocale("pt")).toBe("pt-BR");
    expect(matchLocale("DE-ch")).toBe("de");
    expect(matchLocale("ar")).toBeNull();
    expect(matchLocale("")).toBeNull();
  });
});

describe("parseAcceptLanguage", () => {
  it("orders tags by weight and drops q=0 and *", () => {
    expect(parseAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, de;q=0.95, *;q=0.5, it;q=0")).toEqual([
      "fr-CH",
      "de",
      "fr",
      "en",
    ]);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });
});

describe("settings", () => {
  it("reads the client's default and a user's own choice, checked", () => {
    const settings = { language: "es", user_languages: { u1: "de", u2: "klingon" } };
    expect(clientLanguage(settings)).toBe("es");
    expect(userLanguage(settings, "u1")).toBe("de");
    expect(userLanguage(settings, "u2")).toBeNull();
    expect(userLanguage(settings, "u3")).toBeNull();
    expect(clientLanguage({ language: 3 })).toBeNull();
    expect(userLanguage({ user_languages: ["de"] }, "0")).toBeNull();
  });
});

describe("localized text", () => {
  it("keeps the plain string form valid", () => {
    expect(LocalizedString.parse("Attached {{filename}}")).toBe("Attached {{filename}}");
  });

  it("requires English and refuses languages we don't have", () => {
    expect(LocalizedString.safeParse({ es: "Hola" }).success).toBe(false);
    expect(LocalizedString.safeParse({ en: "Hi", xx: "?" }).success).toBe(false);
    expect(LocalizedString.safeParse({ en: "Hi", "pt-BR": "Oi" }).success).toBe(true);
  });

  it("falls back to English for a language without a version", () => {
    const text = { en: "Attached {{filename}}", es: "Adjuntado {{filename}}" };
    expect(pickLocalized(text, "es")).toBe("Adjuntado {{filename}}");
    expect(pickLocalized(text, "de")).toBe("Attached {{filename}}");
    expect(pickLocalized("Attached", "fr")).toBe("Attached");
  });

  it("renders a summary in the client's language, else English", () => {
    const template = { en: "Read {{count}} lines", de: "{{count}} Zeilen gelesen" };
    expect(renderSummary(template, { count: 4 }, "de")).toBe("4 Zeilen gelesen");
    expect(renderSummary(template, { count: 4 }, "it")).toBe("Read 4 lines");
    expect(renderSummary("Read {{count}} lines", { count: 4 }, "de")).toBe("Read 4 lines");
    expect(renderSummary(template, { count: 4 })).toBe("Read 4 lines");
  });

  it("lets skill and tool summaries carry a version per language, and still take a string", () => {
    const skill = {
      schemaVersion: 1,
      id: "custom:read",
      name: "Read",
      description: "Reads",
      category: "documents",
      mode: "agent",
      instructions: "Read it.",
      tools: [],
      input: {},
      output: {},
    };
    expect(SkillDefinition.parse({ ...skill, summary: "Read it" }).summary).toBe("Read it");
    expect(
      SkillDefinition.parse({ ...skill, summary: { en: "Read it", fr: "Lu" } }).summary,
    ).toEqual({ en: "Read it", fr: "Lu" });
    expect(SkillDefinition.safeParse({ ...skill, summary: { fr: "Lu" } }).success).toBe(false);
    const tool = {
      id: "testkit.record.read",
      description: "Read a record",
      input: {},
      output: {},
      sideEffect: "none",
      verb: "read",
      source: "testkit",
    };
    expect(ToolSpec.parse({ ...tool, summary: "Read {{id}}" }).summary).toBe("Read {{id}}");
    expect(
      ToolSpec.parse({ ...tool, summary: { en: "Read {{id}}", it: "Letto {{id}}" } }).summary,
    ).toEqual({ en: "Read {{id}}", it: "Letto {{id}}" });
  });
});
