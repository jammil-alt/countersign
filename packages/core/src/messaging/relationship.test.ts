import { describe, expect, it } from "vitest";
import { ContactConsentChange, ContactCreate } from "../api/messaging";
import { callBlock } from "../calls/rules";
import { consentBlockFor } from "../reach/rules";
import { A2pBusinessDetails, a2pRelationshipOptIn, smsDisclosureLine } from "./a2p";
import {
  ChannelConsent,
  consentBasisOf,
  consentBlock,
  hasConsent,
  INTRODUCTION_GAP_MS,
  needsIntroduction,
  optOutLine,
  relationshipChannelsFor,
  withIntroduction,
} from "./rules";

// The relationship basis and the first text (docs/plan.md §1.97).
const AT = "2026-11-13T10:00:00.000Z";
const given = { grantedAt: AT, source: "number on their invoices", basis: "relationship" as const };
const agreed = { grantedAt: AT, source: "texted START" };
const base = { phone: "+15555550100", whatsapp: "+15555550100", optedOutAt: null };

describe("consent basis", () => {
  it("reads consent stored before as express, and keeps the source as evidence", () => {
    expect(consentBasisOf(ChannelConsent.parse(agreed))).toBe("express");
    expect(consentBasisOf(ChannelConsent.parse(given))).toBe("relationship");
    expect(ChannelConsent.parse(given).source).toBe("number on their invoices");
    expect(ChannelConsent.safeParse({ ...given, basis: "implied" }).success).toBe(false);
  });

  it("opens texts, calls and email on the relationship basis, never WhatsApp", () => {
    const consent = { sms: given, voice: given, email: given, whatsapp: given };
    expect(consentBlock({ ...base, consent }, "sms")).toBeNull();
    expect(callBlock({ ...base, consent })).toBeNull();
    expect(hasConsent(consent, "email")).toBe(true);
    expect(consentBlock({ ...base, consent }, "whatsapp")).toBe("no_consent");
    expect(consentBlock({ ...base, consent: { whatsapp: agreed } }, "whatsapp")).toBeNull();
  });

  it("still stops every channel after an opt-out", () => {
    const consent = { sms: given, voice: given, email: given };
    const out = { ...base, consent, optedOutAt: new Date(AT) };
    expect(consentBlock(out, "sms")).toBe("opted_out");
    expect(callBlock(out)).toBe("opted_out");
    const reach = {
      id: "c1",
      name: "Pat",
      email: "pat@shop.example",
      phone: base.phone,
      whatsapp: null,
      language: null,
      preferredChannels: [],
      timezone: null,
      quietHours: null,
      consent,
      optedOutAt: new Date(AT),
    };
    expect(consentBlockFor(reach, "email")).toBe("opted_out");
    expect(consentBlockFor({ ...reach, optedOutAt: null }, "email")).toBeNull();
  });

  it("grants the channels the contact has an address for", () => {
    expect(relationshipChannelsFor({ phone: "+15555550100", email: "a@b.co" })).toEqual([
      "sms",
      "voice",
      "email",
    ]);
    expect(relationshipChannelsFor({ phone: null, email: "a@b.co" })).toEqual(["email"]);
    expect(relationshipChannelsFor({ phone: null, email: null })).toEqual([]);
  });

  it("takes the basis on a new contact and as a consent change, with a required note", () => {
    const create = { name: "Pat", phone: "+15555550100" };
    expect(
      ContactCreate.safeParse({ ...create, consent: { basis: "relationship", source: "invoices" } })
        .success,
    ).toBe(true);
    expect(
      ContactCreate.safeParse({ ...create, consent: { basis: "relationship", source: " " } })
        .success,
    ).toBe(false);
    expect(
      ContactCreate.safeParse({ ...create, consent: { channels: ["sms"], source: "form" } })
        .success,
    ).toBe(true);
    expect(ContactConsentChange.safeParse({ action: "relationship", source: "" }).success).toBe(
      false,
    );
    expect(
      ContactConsentChange.safeParse({ action: "relationship", source: "order form" }).success,
    ).toBe(true);
  });
});

describe("the first text", () => {
  const now = new Date(AT);
  it("is the first ever, or the first after 30 days", () => {
    expect(needsIntroduction(null, now)).toBe(true);
    expect(needsIntroduction(undefined, now)).toBe(true);
    expect(needsIntroduction(new Date(now.getTime() - INTRODUCTION_GAP_MS + 1), now)).toBe(false);
    expect(needsIntroduction(new Date(now.getTime() - INTRODUCTION_GAP_MS), now)).toBe(true);
  });

  it("names the client and ends with the opt-out line, once", () => {
    const client = "Rivera Supply";
    expect(withIntroduction("Your order is ready.", { client })).toBe(
      "Rivera Supply: Your order is ready. Reply STOP to opt out.",
    );
    expect(withIntroduction("This is rivera supply. Ready.", { client })).toBe(
      "This is rivera supply. Ready. Reply STOP to opt out.",
    );
    const done = "Rivera Supply: ready. Reply STOP to opt out.";
    expect(withIntroduction(done, { client })).toBe(done);
    expect(withIntroduction("Ready. Text STOP to end.", { client })).toBe(
      "Rivera Supply: Ready. Text STOP to end.",
    );
  });

  it("writes the opt-out line in the contact's language, keeping the word STOP", () => {
    expect(optOutLine("fr")).toContain("STOP");
    expect(optOutLine("pt")).toBe(optOutLine("pt-BR"));
    expect(optOutLine("es-MX")).toBe(optOutLine("es"));
    expect(optOutLine("ja")).toBe("Reply STOP to opt out.");
    expect(optOutLine(null)).toBe("Reply STOP to opt out.");
  });
});

describe("the 10DLC wording", () => {
  it("points to the client's forms and the line they carry", () => {
    const words = a2pRelationshipOptIn("Rivera Supply");
    expect(words).toContain(smsDisclosureLine("Rivera Supply"));
    expect(smsDisclosureLine("Rivera Supply")).toBe(
      "By giving us your mobile number you agree to texts from Rivera Supply about your orders. Msg & data rates may apply. Reply STOP to opt out.",
    );
    expect(a2pRelationshipOptIn("")).toContain("[Business]");
    expect(A2pBusinessDetails.shape.optIn.safeParse(words).success).toBe(true);
  });
});
