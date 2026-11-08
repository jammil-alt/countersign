import { describe, expect, it } from "vitest";
import { TextingRegistrationView } from "../api/a2p";
import { forbiddenPortalFields, secretResponseFields } from "../api/contract";
import { routes } from "../api/routes";
import {
  A2P_FEES,
  A2pBusinessDetails,
  A2pCampaignText,
  a2pCampaignTextOf,
  a2pFeePreview,
  a2pIssueWords,
  a2pKeywordsOf,
  a2pUseCaseOf,
  campaignMarketingWords,
  einHint,
  emptyA2pRegistration,
  isWebLink,
  marketingWordsIn,
  normalizeEin,
  readA2pRegistration,
  redactEin,
} from "./a2p";

export const DETAILS = A2pBusinessDetails.parse({
  legalName: "Acme Millwork LLC",
  businessType: "Limited Liability Corporation",
  industry: "MANUFACTURING",
  companyType: "private",
  website: "https://acme-millwork.example.com",
  address: {
    street: "100 Main St",
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    country: "US",
  },
  representative: {
    firstName: "Dana",
    lastName: "Reyes",
    title: "Owner",
    position: "CEO",
    phone: "+15125550199",
    email: "dana@acme-millwork.example.com",
  },
  uses: ["team", "vendors"],
  optIn:
    "Our team and vendors give us their mobile number on our onboarding form and tick a box agreeing to texts from Acme Millwork.",
  privacyPolicyUrl: "https://acme-millwork.example.com/privacy",
  termsUrl: "https://acme-millwork.example.com/terms",
});

describe("A2P details", () => {
  it("defaults to low volume in the USA and Canada, no links or phone numbers", () => {
    expect(DETAILS.volume).toBe("low");
    expect(DETAILS.regions).toEqual(["USA_AND_CANADA"]);
    expect(DETAILS.hasLinks).toBe(false);
  });

  it("refuses a marketing use, a public company and a short opt-in", () => {
    expect(A2pBusinessDetails.safeParse({ ...DETAILS, uses: ["marketing"] }).success).toBe(false);
    expect(A2pBusinessDetails.safeParse({ ...DETAILS, companyType: "public" }).success).toBe(false);
    expect(A2pBusinessDetails.safeParse({ ...DETAILS, optIn: "they agree" }).success).toBe(false);
  });

  it("checks links by a scan", () => {
    expect(isWebLink("https://acme.example.com/privacy")).toBe(true);
    expect(isWebLink("http://acme.com")).toBe(true);
    expect(isWebLink("ftp://acme.com")).toBe(false);
    expect(isWebLink("https://localhost/x")).toBe(false);
    expect(isWebLink("https://acme .com")).toBe(false);
    expect(isWebLink("https://a_b.com")).toBe(false);
  });
});

describe("the EIN", () => {
  it("normalizes to Twilio's 00-0000000 and refuses anything else", () => {
    expect(normalizeEin("12-3456789")).toBe("12-3456789");
    expect(normalizeEin(" 123456789 ")).toBe("12-3456789");
    expect(normalizeEin("12 345 6789")).toBe("12-3456789");
    expect(normalizeEin("12-345678")).toBeNull();
    expect(normalizeEin("AB-3456789")).toBeNull();
  });

  it("shows only its last two digits and is redacted from any text", () => {
    expect(einHint("12-3456789")).toBe("••-•••••89");
    expect(redactEin("Number 12-3456789 or 123456789 is wrong", "12-3456789")).toBe(
      "Number [EIN] or [EIN] is wrong",
    );
    expect(redactEin("nothing here", null)).toBe("nothing here");
  });
});

describe("use case and fees", () => {
  it("is MIXED or LOW_VOLUME by brand type, never marketing", () => {
    expect(a2pUseCaseOf("standard")).toBe("MIXED");
    expect(a2pUseCaseOf("low_volume")).toBe("LOW_VOLUME");
  });

  it("previews a first submit: brand, vetting and the monthly fee", () => {
    const low = a2pFeePreview(emptyA2pRegistration(), "low");
    expect(low.lines.map((l) => [l.kind, l.amountUsd])).toEqual([
      ["brand", A2P_FEES.brand.low_volume],
      ["vetting", A2P_FEES.vetting],
      ["monthly", A2P_FEES.monthly.LOW_VOLUME],
    ]);
    expect(low.nowUsd).toBe("19.0000");
    expect(a2pFeePreview(emptyA2pRegistration(), "standard").nowUsd).toBe("59.0000");
  });

  it("previews a resubmit: nothing new after a brand rejection, a new vetting after a campaign's", () => {
    const base = {
      ...emptyA2pRegistration(),
      brandType: "standard" as const,
      fees: [{ key: "a2p:brand:BN1", kind: "brand", amountUsd: "44.0000", at: "x" }],
    };
    const brandRejected = a2pFeePreview(
      {
        ...base,
        issues: [{ source: "brand", code: null, fields: [], description: "Tax id mismatch" }],
      },
      "standard",
    );
    expect(brandRejected.nowUsd).toBe("15.0000"); // the campaign was never made
    const campaignRejected = a2pFeePreview(
      {
        ...base,
        campaignAttempts: 1,
        issues: [{ source: "campaign", code: "30893", fields: [], description: "Bad samples" }],
      },
      "standard",
    );
    expect(campaignRejected.lines.map((l) => l.kind)).toEqual(["vetting", "monthly"]);
    expect(campaignRejected.nowUsd).toBe("15.0000");
  });
});

describe("the campaign's words", () => {
  it("names the business, fits Twilio's lengths and is never marketing", () => {
    const c = a2pCampaignTextOf(DETAILS);
    expect(A2pCampaignText.safeParse(c).success).toBe(true);
    expect(c.samples).toHaveLength(2);
    for (const s of c.samples) expect(s).toContain("Acme Millwork LLC");
    expect(c.description).toContain("No marketing");
    expect(c.messageFlow).toContain("https://acme-millwork.example.com/privacy");
    expect(campaignMarketingWords(c)).toEqual([]);
  });

  it("adds a sample when only one use is chosen", () => {
    const c = a2pCampaignTextOf({ ...DETAILS, uses: ["customer_care"] });
    expect(c.samples.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps keyword replies within Twilio's 20–320 characters", () => {
    const k = a2pKeywordsOf("A".repeat(300));
    for (const m of [k.optInMessage, k.optOutMessage, k.helpMessage]) {
      expect(m.length).toBeGreaterThanOrEqual(20);
      expect(m.length).toBeLessThanOrEqual(320);
    }
    expect(k.optOutKeywords).toContain("STOP");
  });

  it("finds marketing words as whole words only", () => {
    expect(marketingWordsIn("20% DISCOUNT this week! Promo code inside")).toEqual([
      "discount",
      "promo",
    ]);
    expect(marketingWordsIn("Your promotion to lead is confirmed")).toEqual(["promotion"]);
    expect(marketingWordsIn("Discounted? no: discountable")).toEqual([]);
  });

  it("says a reason in plain words, with what to check", () => {
    expect(
      a2pIssueWords({
        source: "campaign",
        code: "30893",
        fields: ["SAMPLE_MESSAGE_1", "MESSAGE_FLOW"],
        description: "Invalid sample message content.",
      }),
    ).toBe(
      "Invalid sample message content. Check the first sample message, how people agree to texts.",
    );
  });
});

describe("what is stored and answered", () => {
  it("reads an empty or partial registration with defaults", () => {
    expect(readA2pRegistration(undefined)).toBeNull();
    expect(readA2pRegistration({ stage: "submitted" })?.serviceNumbers).toEqual([]);
  });

  it("keeps the EIN out of every response and the portal's view free of cost and SIDs", () => {
    for (const [name, spec] of Object.entries(routes)) {
      expect(secretResponseFields(spec.response), name).toEqual([]);
    }
    expect(forbiddenPortalFields(TextingRegistrationView)).toEqual([]);
    const keys = Object.keys(TextingRegistrationView.shape);
    expect(keys.some((k) => k.toLowerCase().includes("sid"))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes("fee"))).toBe(false);
  });
});
