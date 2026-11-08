// P-8: the A2P 10DLC calls against the fake Twilio (docs/plan.md §1.70). Never the live Twilio.

import { A2pBusinessDetails, a2pCampaignTextOf } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  addServiceNumber,
  assignToBundle,
  brandUseCases,
  businessAttributes,
  createA2pService,
  createAddress,
  createBrand,
  createBundle,
  createCampaign,
  createEndUser,
  deleteCampaign,
  evaluateBundle,
  fetchBrand,
  fetchBundle,
  fetchCampaign,
  issuesOf,
  representativeAttributes,
  serviceNumbers,
  submitBundle,
  updateBrand,
} from "./a2p";
import { TwilioError } from "./api";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "./fake";
import { FAKE_PRIMARY_PROFILE } from "./fake-a2p";
import { buyNumber, createSubaccount } from "./index";

const EIN = "12-3456789";
const DETAILS = A2pBusinessDetails.parse({
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
  uses: ["team", "vendors", "customer_care"],
  optIn:
    "Our team and vendors give us their mobile number on our onboarding form and tick a box agreeing to texts.",
  privacyPolicyUrl: "https://acme-millwork.example.com/privacy",
  termsUrl: "https://acme-millwork.example.com/terms",
});

async function profiles(
  twilio: ReturnType<typeof fakeTwilio>,
  sub: { accountSid: string; authToken: string },
) {
  const f = twilio.fetch;
  const profile = await createBundle(f, sub, "CustomerProfiles", {
    friendlyName: "Acme profile",
    email: "a2p@mezonas.test",
  });
  const business = await createEndUser(f, sub, {
    type: "customer_profile_business_information",
    friendlyName: "Acme business",
    attributes: businessAttributes(DETAILS, EIN),
  });
  const rep = await createEndUser(f, sub, {
    type: "authorized_representative_1",
    friendlyName: "Acme rep",
    attributes: representativeAttributes(DETAILS),
  });
  const { documentSid } = await createAddress(f, sub, DETAILS);
  for (const obj of [business, rep, documentSid]) {
    await assignToBundle(f, sub, "CustomerProfiles", profile.sid, obj);
  }
  return { profile: profile.sid, primaryMissing: true };
}

describe("A2P 10DLC by API", () => {
  it("registers a profile, trust product, brand, service and campaign, and adds the number", async () => {
    const twilio = fakeTwilio();
    const f = twilio.fetch;
    const sub = await createSubaccount(f, FAKE_TWILIO_MAIN, "Acme");
    const { profile } = await profiles(twilio, sub);
    // The primary profile is missing until assigned: the evaluation says so.
    const before = await evaluateBundle(f, sub, "CustomerProfiles", profile);
    expect(before.compliant).toBe(false);
    expect(before.issues.map((i) => i.description)).toEqual([
      "Primary Customer Profile is missing. Please add one to the regulatory bundle.",
    ]);
    await assignToBundle(f, sub, "CustomerProfiles", profile, FAKE_PRIMARY_PROFILE);
    expect((await evaluateBundle(f, sub, "CustomerProfiles", profile)).compliant).toBe(true);
    expect(await submitBundle(f, sub, "CustomerProfiles", profile)).toBe("pending-review");

    const trust = await createBundle(f, sub, "TrustProducts", {
      friendlyName: "Acme A2P",
      email: "a2p@mezonas.test",
    });
    const mp = await createEndUser(f, sub, {
      type: "us_a2p_messaging_profile_information",
      friendlyName: "Acme messaging profile",
      attributes: { company_type: "private" },
    });
    await assignToBundle(f, sub, "TrustProducts", trust.sid, mp);
    await assignToBundle(f, sub, "TrustProducts", trust.sid, profile);
    expect((await evaluateBundle(f, sub, "TrustProducts", trust.sid)).compliant).toBe(true);
    await submitBundle(f, sub, "TrustProducts", trust.sid);

    const brand = await createBrand(f, sub, {
      customerProfileSid: profile,
      trustProductSid: trust.sid,
      lowVolume: true,
    });
    expect(brand.status).toBe("PENDING");
    const brandForm = twilio.requests.find((r) => r.url.endsWith("/a2p/BrandRegistrations"))?.form;
    expect(brandForm).toMatchObject({ BrandType: "STANDARD", SkipAutomaticSecVet: "true" });

    const svc = await createA2pService(f, sub, {
      friendlyName: "Acme",
      inboundUrl: "https://app.mezonas.test/api/twilio/x/messages",
      statusUrl: "https://app.mezonas.test/api/twilio/x/status",
    });
    expect(twilio.a2p.services.get(svc)?.useInboundWebhookOnNumber).toBe(true);
    // Not before the brand is approved.
    await expect(brandUseCases(f, sub, svc, brand.sid)).rejects.toBeInstanceOf(TwilioError);
    twilio.setBrand(brand.sid, "APPROVED");
    expect(await brandUseCases(f, sub, svc, brand.sid)).toContain("LOW_VOLUME");

    const text = a2pCampaignTextOf(DETAILS);
    const made = await createCampaign(f, sub, svc, {
      brandSid: brand.sid,
      useCase: "LOW_VOLUME",
      text,
      details: DETAILS,
    });
    expect(made.status).toBe("PENDING");
    const record = twilio.a2p.campaignRecords.get(svc);
    expect(record?.samples).toEqual(text.samples);
    expect(record?.optOutKeywords).toContain("STOP");
    expect(record?.usecase).toBe("LOW_VOLUME");
    twilio.setCampaign(svc, "VERIFIED");
    expect((await fetchCampaign(f, sub, svc))?.status).toBe("VERIFIED");

    const n = await buyNumber(f, sub, {
      phoneNumber: "+15125550101",
      smsUrl: "https://app.mezonas.test/api/twilio/x/messages",
      friendlyName: "Acme",
      now: new Date(),
    });
    await addServiceNumber(f, sub, svc, n.sid);
    expect(await serviceNumbers(f, sub, svc)).toEqual([n.sid]);
    expect(twilio.a2p.charged.map((c) => c.kind)).toEqual(["brand", "vetting"]);
  });

  it("reads a rejection's reasons, updates the brand (three times free) and remakes a campaign", async () => {
    const twilio = fakeTwilio();
    const f = twilio.fetch;
    const sub = await createSubaccount(f, FAKE_TWILIO_MAIN, "Acme");
    const { profile } = await profiles(twilio, sub);
    await assignToBundle(f, sub, "CustomerProfiles", profile, FAKE_PRIMARY_PROFILE);
    twilio.a2p.setBundle(profile, "twilio-rejected", [
      { code: 22215, message: "The Business Name does not match the EIN" },
    ]);
    expect(await fetchBundle(f, sub, "CustomerProfiles", profile)).toEqual({
      status: "twilio-rejected",
      issues: [
        {
          source: "profile",
          code: "22215",
          fields: [],
          description: "The Business Name does not match the EIN",
        },
      ],
    });
    twilio.a2p.setBundle(profile, "twilio-approved");
    const trust = await createBundle(f, sub, "TrustProducts", {
      friendlyName: "T",
      email: "a@b.co",
    });
    await assignToBundle(f, sub, "TrustProducts", trust.sid, profile);
    const brand = await createBrand(f, sub, {
      customerProfileSid: profile,
      trustProductSid: trust.sid,
      lowVolume: false,
    });
    // Updating a brand that hasn't failed is refused.
    await expect(updateBrand(f, sub, brand.sid)).rejects.toMatchObject({ code: 21730 });
    twilio.setBrandResult(brand.sid, "FAILED", [
      { error_code: 30794, fields: ["business_name"], description: "Tax ID mismatch" },
    ]);
    expect((await fetchBrand(f, sub, brand.sid)).issues).toEqual([
      { source: "brand", code: "30794", fields: ["business_name"], description: "Tax ID mismatch" },
    ]);
    for (let i = 0; i < 3; i++) {
      expect((await updateBrand(f, sub, brand.sid)).status).toBe("PENDING");
      twilio.setBrandResult(brand.sid, "FAILED");
    }
    await expect(updateBrand(f, sub, brand.sid)).rejects.toMatchObject({ code: 21724 });

    twilio.setBrand(brand.sid, "APPROVED");
    const svc = await createA2pService(f, sub, {
      friendlyName: "A",
      inboundUrl: "https://x.test/i",
      statusUrl: "https://x.test/s",
    });
    const input = {
      brandSid: brand.sid,
      useCase: "MIXED" as const,
      text: a2pCampaignTextOf(DETAILS),
      details: DETAILS,
    };
    await createCampaign(f, sub, svc, input);
    twilio.setCampaign(svc, "FAILED", [
      {
        error_code: 30893,
        fields: ["SAMPLE_MESSAGE_1"],
        url: "https://www.twilio.com/docs/api/errors/30893",
        description: "Invalid sample message",
      },
    ]);
    expect((await fetchCampaign(f, sub, svc))?.issues[0]).toMatchObject({
      code: "30893",
      fields: ["SAMPLE_MESSAGE_1"],
    });
    // A second campaign on the same service is refused until the failed one is deleted.
    await expect(createCampaign(f, sub, svc, input)).rejects.toMatchObject({ code: 21710 });
    await deleteCampaign(f, sub, svc);
    expect(await fetchCampaign(f, sub, svc)).toBeNull();
    await createCampaign(f, sub, svc, input);
    expect(twilio.a2p.charged.filter((c) => c.kind === "vetting")).toHaveLength(2);
  });

  it("refuses another subaccount's bundles and a marketing use case for a low-volume brand", async () => {
    const twilio = fakeTwilio();
    const f = twilio.fetch;
    const a = await createSubaccount(f, FAKE_TWILIO_MAIN, "A");
    const b = await createSubaccount(f, FAKE_TWILIO_MAIN, "B");
    const { profile } = await profiles(twilio, a);
    await expect(fetchBundle(f, b, "CustomerProfiles", profile)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      createBrand(f, b, { customerProfileSid: profile, trustProductSid: profile, lowVolume: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reads Twilio's errors in each shape it may answer with", () => {
    expect(
      issuesOf(["plain words", { code: 1, message: "m" }, { nonsense: true }, 7], "brand"),
    ).toEqual([
      { source: "brand", code: null, fields: [], description: "plain words" },
      { source: "brand", code: "1", fields: [], description: "m" },
      { source: "brand", code: null, fields: [], description: "Twilio gave no reason" },
    ]);
  });
});
