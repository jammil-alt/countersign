import { describe, expect, it } from "vitest";
import {
  CALL_LANGUAGES,
  CALL_WORDS,
  callBlock,
  callLanguage,
  openingLine,
  outcomeOfStatus,
} from "./rules";

const agreed = { grantedAt: "2026-11-04T10:00:00.000Z", source: "signed" };

describe("call rules", () => {
  it("calls only a contact with a phone who agreed to calls and hasn't opted out", () => {
    const base = { phone: "+15555550100", whatsapp: null, optedOutAt: null };
    expect(callBlock({ ...base, consent: { voice: agreed } })).toBeNull();
    // Agreeing to texts is not agreeing to calls.
    expect(callBlock({ ...base, consent: { sms: agreed } })).toBe("no_consent");
    expect(callBlock({ ...base, phone: null, consent: { voice: agreed } })).toBe("no_number");
    expect(
      callBlock({ ...base, optedOutAt: "2026-11-04T11:00:00.000Z", consent: { voice: agreed } }),
    ).toBe("opted_out");
  });

  it("always opens with the disclosure, then the agent's line, then asks about a record", () => {
    expect(
      openingLine({
        direction: "out",
        language: "en",
        client: "Shop & Co",
        firstMessage: "  I'm calling about your order.  ",
      }),
    ).toBe(
      "Hello, this is an automated assistant calling for Shop & Co. I'm calling about your order. May I keep a written record of this call?",
    );
    const es = openingLine({ direction: "in", language: "es", client: "Taller" });
    expect(es.startsWith("Hola, ha llamado a Taller. Le atiende un asistente automático.")).toBe(
      true,
    );
    expect(es.endsWith("¿Me permite guardar un registro escrito de esta llamada?")).toBe(true);
  });

  it("has every sentence in every language, and picks the contact's language, else the client's", () => {
    for (const l of CALL_LANGUAGES) {
      for (const s of Object.values(CALL_WORDS[l])) expect(s.length).toBeGreaterThan(5);
    }
    expect(callLanguage(null, "fr")).toBe("fr");
    expect(callLanguage("pt", "en")).toBe("pt-BR");
    expect(callLanguage("de-AT")).toBe("de");
    expect(callLanguage("ja", undefined)).toBe("en");
  });

  it("reads Twilio's final statuses as outcomes", () => {
    expect(outcomeOfStatus("no-answer")).toBe("no_answer");
    expect(outcomeOfStatus("completed")).toBeNull();
  });
});
