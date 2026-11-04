import { describe, expect, it } from "vitest";
import { ConnectorManifest } from "../schemas/connector";
import {
  consentBlock,
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  inWhatsAppWindow,
  isNanpNumber,
  keywordOf,
  localTime,
  normalizePhone,
} from "./rules";

describe("messaging rules", () => {
  it("takes numbers as people type them, in E.164, and never guesses a country", () => {
    expect(normalizePhone("+1 (555) 555-0100")).toBe("+15555550100");
    expect(normalizePhone("whatsapp:+447700900123")).toBe("+447700900123");
    expect(normalizePhone("0044 7700 900123")).toBe("+447700900123");
    expect(normalizePhone("555-0100")).toBeNull();
    expect(normalizePhone("+0123456789")).toBeNull();
    expect(isNanpNumber("+15555550100")).toBe(true);
    expect(isNanpNumber("+447700900123")).toBe(false);
  });

  it("reads STOP, START and HELP on the whole message only", () => {
    expect(keywordOf("stop")).toBe("stop");
    expect(keywordOf("  Unsubscribe. ")).toBe("stop");
    expect(keywordOf("START")).toBe("start");
    expect(keywordOf("help")).toBe("help");
    expect(keywordOf("please don't stop the order")).toBeNull();
    expect(keywordOf("")).toBeNull();
  });

  it("checks consent per channel, and an opt-out stops every channel", () => {
    const at = { grantedAt: "2026-11-04T00:00:00Z", source: "form" };
    const c = { phone: "+15555550100", whatsapp: null, consent: { sms: at }, optedOutAt: null };
    expect(consentBlock(c, "sms")).toBeNull();
    expect(consentBlock(c, "whatsapp")).toBe("no_number");
    expect(consentBlock({ ...c, whatsapp: c.phone }, "whatsapp")).toBe("no_consent");
    expect(consentBlock({ ...c, optedOutAt: new Date() }, "sms")).toBe("opted_out");
  });

  it("keeps quiet hours in the client's timezone, across midnight", () => {
    const at = new Date("2026-11-04T03:30:00Z"); // 21:30 in Chicago (CST), 03:30 UTC
    expect(localTime(at, "America/Chicago")).toBe("21:30");
    expect(inQuietHours(at, "America/Chicago", DEFAULT_QUIET_HOURS)).toBe(true);
    expect(
      inQuietHours(new Date("2026-11-04T15:00:00Z"), "America/Chicago", DEFAULT_QUIET_HOURS),
    ).toBe(false);
    expect(inQuietHours(at, "UTC", { start: "09:00", end: "17:00" })).toBe(false);
    expect(inQuietHours(at, "Not/AZone", { start: "03:00", end: "04:00" })).toBe(true);
  });

  it("opens WhatsApp's window for 24 hours after the contact's last message", () => {
    const now = new Date("2026-11-04T15:00:00Z");
    expect(inWhatsAppWindow(new Date("2026-11-04T00:00:00Z"), now)).toBe(true);
    expect(inWhatsAppWindow(new Date("2026-11-03T14:00:00Z"), now)).toBe(false);
    expect(inWhatsAppWindow(null, now)).toBe(false);
  });

  it("lets a connector name tools and events in a shared namespace", () => {
    const base = {
      id: "twilio",
      name: "Texts",
      description: "",
      icon: "message",
      auth: "api_key" as const,
      entities: [],
      tools: [],
    };
    const event = { type: "message.received", description: "", payload: {}, sample: {} };
    expect(ConnectorManifest.safeParse({ ...base, events: [event] }).success).toBe(false);
    expect(
      ConnectorManifest.safeParse({ ...base, events: [event], sharedNamespaces: ["message"] })
        .success,
    ).toBe(true);
  });
});
