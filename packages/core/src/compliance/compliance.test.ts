import { describe, expect, it } from "vitest";
import { luhnValid, redactCardNumbers, redactCardNumbersDeep } from "./card-numbers";
import {
  complianceOf,
  hipaaReadiness,
  PROCESSORS,
  parseCoveredProcessors,
  processingRefusal,
  processorForModel,
  processorsForOffer,
  processorsForTool,
} from "./processors";

describe("card numbers", () => {
  it("checks Luhn", () => {
    expect(luhnValid("4242424242424242")).toBe(true);
    expect(luhnValid("4242424242424241")).toBe(false);
  });

  it("redacts card numbers written any common way, keeping the last four", () => {
    expect(redactCardNumbers("Paid with 4242 4242 4242 4242 on 3/4")).toBe(
      "Paid with [card ending 4242] on 3/4",
    );
    expect(redactCardNumbers("card 5555-5555-5555-4444.")).toBe("card [card ending 4444].");
    expect(redactCardNumbers("amex 378282246310005")).toBe("amex [card ending 0005]");
  });

  it("leaves numbers that aren't cards alone", () => {
    for (const text of [
      "Invoice 4242424242424241", // fails Luhn
      "PO 123456789012", // 12 digits
      "Total 0000000000000000",
      "Phone +1 555 010 9999",
      "Date 2026-11-05, qty 12, $1,234.5600",
      "id 019a2f3c-0d2e-7c11-9a1b-4242424242424242", // inside a uuid
    ]) {
      expect(redactCardNumbers(text)).toBe(text);
    }
  });

  it("redacts every string inside a JSON value", () => {
    expect(
      redactCardNumbersDeep({ a: ["x 4111 1111 1111 1111"], b: 4, c: null, d: { e: "ok" } }),
    ).toEqual({ a: ["x [card ending 1111]"], b: 4, c: null, d: { e: "ok" } });
  });
});

describe("processors", () => {
  const all = parseCoveredProcessors("cloudflare, neon workos,anthropic,unknown");

  it("parses the BAA list, ignoring unknown words", () => {
    expect([...all].sort()).toEqual(["anthropic", "cloudflare", "neon", "workos"]);
    expect(parseCoveredProcessors(undefined).size).toBe(0);
  });

  it("names each feature's processors", () => {
    expect(processorForModel("claude-sonnet-5-5")).toBe("anthropic");
    expect(processorForModel("openai:gpt-5.5")).toBe("openai");
    expect(processorsForTool("sms.send", "twilio")).toEqual(["twilio"]);
    expect(processorsForTool("whatsapp.send", "twilio").sort()).toEqual([
      "meta_whatsapp",
      "twilio",
    ]);
    expect(processorsForTool("call.place", "twilio").sort()).toEqual(["elevenlabs", "twilio"]);
    expect(processorsForTool("email.send", "resend")).toEqual(["resend"]);
    // The client's own tools are not processors of ours.
    for (const c of [
      "qbo",
      "gmail",
      "zoho_crm",
      "podio",
      "webhook",
      "browser",
      "upload",
      // v0.12 W3-B
      "ramp",
      "hubspot",
      "gdrive",
      "outlook",
      // v0.14 W4-E
      "gchat",
      // v0.14 W4-D
      "gsheets",
      // v0.14 W4-C: the client's own workspace, not a processor of ours.
      "slack",
      // M45: the client's own search accounts, read only.
      "gsc",
      "bing_webmaster",
    ]) {
      expect(processorsForOffer(c), c).toEqual([]);
    }
    expect(processorsForOffer("twilio").sort()).toEqual(["elevenlabs", "meta_whatsapp", "twilio"]);
    // v0.14 W4-A: WhatsApp on the client's own number through Meta: Meta's WhatsApp, as Twilio's.
    expect(processorsForOffer("whatsapp_meta")).toEqual(["meta_whatsapp"]);
    expect(processorsForTool("whatsapp.send", "whatsapp_meta")).toEqual(["meta_whatsapp"]);
    expect(processorsForTool("message.get", "whatsapp_meta")).toEqual(["meta_whatsapp"]);
    // v0.12 bankfeed: Plaid is Mezonas' processor, not the client's tool.
    expect(processorsForOffer("bankfeed")).toEqual(["plaid"]);
    expect(processorsForTool("bankfeed.transaction.query", "bankfeed")).toEqual(["plaid"]);
    // §1.77: web research is its own processor; Hacker News is one; LinkedIn is the client's own.
    expect(processorsForTool("web.search", null)).toEqual(["anthropic_web"]);
    expect(processorsForTool("web.fetch", null)).toEqual(["anthropic_web"]);
    expect(processorsForTool("hackernews.search", "hackernews")).toEqual(["hackernews"]);
    expect(processorsForOffer("hackernews")).toEqual(["hackernews"]);
    expect(processorsForOffer("linkedin")).toEqual([]);
    expect(processingRefusal({ hipaa: true }, all, ["anthropic_web"], "web.search")).toBe(
      "web.search sends data to Anthropic web search and fetch, which has no signed BAA; this client is in HIPAA mode",
    );
  });

  it("lists exactly these processors", () => {
    expect([...PROCESSORS]).toEqual([
      "cloudflare",
      "neon",
      "workos",
      "anthropic",
      "openai",
      "twilio",
      "meta_whatsapp",
      "elevenlabs",
      "resend",
      "plaid",
      "anthropic_web",
      "hackernews",
    ]);
    expect(hipaaReadiness(parseCoveredProcessors("cloudflare neon workos"), ["bankfeed"])).toEqual([
      "The bankfeed connector is offered and sends data to Plaid, with no signed BAA. Withdraw it first.",
    ]);
  });

  it("refuses only in HIPAA mode, and only what isn't covered", () => {
    expect(processingRefusal({ hipaa: false }, new Set(), ["openai"], "x")).toBeNull();
    expect(processingRefusal({ hipaa: true }, all, ["anthropic"], "x")).toBeNull();
    expect(processingRefusal({ hipaa: true }, all, ["openai"], "The model")).toBe(
      "The model sends data to OpenAI, which has no signed BAA; this client is in HIPAA mode",
    );
  });

  it("reads the profile from client settings, off by default", () => {
    expect(complianceOf({})).toEqual({ hipaa: false });
    expect(complianceOf({ compliance: { hipaa: true } })).toEqual({ hipaa: true });
    expect(complianceOf({ compliance: "yes" })).toEqual({ hipaa: false });
  });

  it("is ready for HIPAA only with the infrastructure covered and no uncovered connector offered", () => {
    expect(hipaaReadiness(new Set(), [])).toHaveLength(1);
    expect(hipaaReadiness(all, ["upload", "qbo"])).toEqual([]);
    expect(hipaaReadiness(all, ["upload", "twilio"])).toEqual([
      "The twilio connector is offered and sends data to Twilio, WhatsApp (Meta), ElevenLabs, with no signed BAA. Withdraw it first.",
    ]);
  });
});
