// P-8: US texting registration (A2P 10DLC) through Twilio's ISV API (docs/plan.md §1.70): Trust
// Hub's secondary customer profile and A2P trust product, the BrandRegistration, a Messaging
// Service, the Usa2p campaign and the service's numbers. Every call is made with the client's
// subaccount credentials. Each answer is checked with Zod. What was checked against Twilio's docs
// (and what wasn't) is in NOTES.md, "A2P 10DLC by API".

import {
  type A2pBusinessDetails,
  type A2pCampaignText,
  type A2pIssue,
  a2pKeywordsOf,
} from "@countersign/core";
import { z } from "zod";
import type { FetchLike } from "../http";
import { accountUrl, TWILIO_MESSAGING_API, type TwilioAuth, twilioRequest } from "./api";

export const TWILIO_TRUSTHUB_API = "https://trusthub.twilio.com/v1";
/** Trust Hub's policy for a secondary customer profile (ISV guide, step 1.1). */
export const SECONDARY_PROFILE_POLICY = "RNdfbf3fae0e1107f8aded0e7cead80bf5";
/** Trust Hub's policy for the A2P trust product (ISV guide, step 2.1). */
export const A2P_TRUST_PRODUCT_POLICY = "RNb0d4771c2c98518d916a3d4cd70a8f8b";
/** The campaign's resource id on a Messaging Service is always this compliance type. */
export const USA2P_COMPLIANCE_SID = "QE2c6890da8086d771620e9b13fadeba0b";

const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`));
export const BundleSid = sid("BU");
export const EndUserSid = sid("IT");
export const BrandSid = sid("BN");
export const ServiceSid = sid("MG");

export type BundleKind = "CustomerProfiles" | "TrustProducts";

const Created = <T extends z.ZodType>(s: T) => z.looseObject({ sid: s });

// ── Trust Hub ────────────────────────────────────────────────────────────────────────────────────

const BundleAnswer = z.looseObject({
  sid: BundleSid,
  status: z.string(),
  errors: z.array(z.unknown()).nullish(),
});

/** A secondary customer profile or the A2P trust product, empty (status `draft`). */
export async function createBundle(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  input: { friendlyName: string; email: string },
): Promise<{ sid: string; status: string }> {
  const b = BundleAnswer.parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/${kind}`, {
      form: {
        FriendlyName: input.friendlyName.slice(0, 64),
        Email: input.email,
        PolicySid:
          kind === "CustomerProfiles" ? SECONDARY_PROFILE_POLICY : A2P_TRUST_PRODUCT_POLICY,
      },
    }),
  );
  return { sid: b.sid, status: b.status };
}

/** The business's information as Trust Hub's end user attributes (step 1.2). */
export function businessAttributes(d: A2pBusinessDetails, ein: string): Record<string, string> {
  return {
    business_name: d.legalName,
    business_type: d.businessType,
    business_industry: d.industry,
    business_registration_identifier: "EIN",
    business_registration_number: ein,
    business_identity: "direct_customer",
    business_regions_of_operation: d.regions.join(","),
    website_url: d.website,
    ...(d.socialLinks ? { social_media_profile_urls: d.socialLinks } : {}),
  };
}

/** The authorized representative's attributes (step 1.4). */
export function representativeAttributes(d: A2pBusinessDetails): Record<string, string> {
  const r = d.representative;
  return {
    first_name: r.firstName,
    last_name: r.lastName,
    business_title: r.title,
    job_position: r.position,
    phone_number: r.phone,
    email: r.email,
  };
}

export type EndUserType =
  | "customer_profile_business_information"
  | "authorized_representative_1"
  | "us_a2p_messaging_profile_information";

export async function createEndUser(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { type: EndUserType; friendlyName: string; attributes: Record<string, string> },
): Promise<string> {
  return Created(EndUserSid).parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/EndUsers`, {
      form: {
        Type: input.type,
        FriendlyName: input.friendlyName.slice(0, 64),
        Attributes: JSON.stringify(input.attributes),
      },
    }),
  ).sid;
}

export async function updateEndUser(
  fetch: FetchLike,
  auth: TwilioAuth,
  endUserSid: string,
  attributes: Record<string, string>,
): Promise<void> {
  Created(EndUserSid).parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/EndUsers/${endUserSid}`, {
      form: { Attributes: JSON.stringify(attributes) },
    }),
  );
}

function addressForm(d: A2pBusinessDetails): Record<string, string> {
  const a = d.address;
  return {
    CustomerName: d.legalName.slice(0, 120),
    Street: a.street,
    ...(a.streetSecondary ? { StreetSecondary: a.streetSecondary } : {}),
    City: a.city,
    Region: a.region,
    PostalCode: a.postalCode,
    IsoCountry: a.country,
  };
}

/** The business's address (an Address resource, then the supporting document that holds it). */
export async function createAddress(
  fetch: FetchLike,
  auth: TwilioAuth,
  d: A2pBusinessDetails,
): Promise<{ addressSid: string; documentSid: string }> {
  const address = Created(sid("AD")).parse(
    await twilioRequest(fetch, auth, "POST", `${accountUrl(auth.accountSid)}/Addresses.json`, {
      form: { FriendlyName: `${d.legalName} address`.slice(0, 64), ...addressForm(d) },
    }),
  ).sid;
  const documentSid = Created(sid("RD")).parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/SupportingDocuments`, {
      form: {
        FriendlyName: `${d.legalName} address`.slice(0, 64),
        Type: "customer_profile_address",
        Attributes: JSON.stringify({ address_sids: address }),
      },
    }),
  ).sid;
  return { addressSid: address, documentSid };
}

export async function updateAddress(
  fetch: FetchLike,
  auth: TwilioAuth,
  addressSid: string,
  d: A2pBusinessDetails,
): Promise<void> {
  Created(sid("AD")).parse(
    await twilioRequest(
      fetch,
      auth,
      "POST",
      `${accountUrl(auth.accountSid)}/Addresses/${addressSid}.json`,
      { form: addressForm(d) },
    ),
  );
}

export async function assignToBundle(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
  objectSid: string,
): Promise<void> {
  await twilioRequest(
    fetch,
    auth,
    "POST",
    `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}/EntityAssignments`,
    { form: { ObjectSid: objectSid } },
  );
}

const Evaluation = z.looseObject({
  status: z.string(),
  results: z
    .array(
      z.looseObject({
        friendly_name: z.string().nullish(),
        passed: z.boolean().nullish(),
        failure_reason: z.string().nullish(),
        error_code: z.union([z.number(), z.string()]).nullish(),
        invalid: z
          .array(
            z.looseObject({
              object_field: z.string().nullish(),
              failure_reason: z.string().nullish(),
              error_code: z.union([z.number(), z.string()]).nullish(),
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
});

/** Trust Hub's evaluation: `compliant`, or the fields it found missing or invalid. */
export async function evaluateBundle(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
): Promise<{ compliant: boolean; issues: A2pIssue[] }> {
  const e = Evaluation.parse(
    await twilioRequest(
      fetch,
      auth,
      "POST",
      `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}/Evaluations`,
      {
        form: {
          PolicySid:
            kind === "CustomerProfiles" ? SECONDARY_PROFILE_POLICY : A2P_TRUST_PRODUCT_POLICY,
        },
      },
    ),
  );
  const source = kind === "CustomerProfiles" ? "profile" : "trust_product";
  const issues: A2pIssue[] = [];
  for (const r of e.results ?? []) {
    if (r.passed !== false) continue;
    const invalid = r.invalid ?? [];
    if (invalid.length === 0) {
      issues.push({
        source,
        code: r.error_code == null ? null : String(r.error_code),
        fields: [],
        description: r.failure_reason ?? `${r.friendly_name ?? "Something"} is missing`,
      });
    }
    for (const f of invalid) {
      issues.push({
        source,
        code: f.error_code == null ? null : String(f.error_code),
        fields: f.object_field ? [f.object_field] : [],
        description: f.failure_reason ?? `${f.object_field ?? "A field"} is invalid`,
      });
    }
  }
  return { compliant: e.status.toLowerCase() === "compliant", issues };
}

/** Sends a bundle to Twilio's review (`pending-review`). */
export async function submitBundle(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
): Promise<string> {
  return BundleAnswer.parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}`, {
      form: { Status: "pending-review" },
    }),
  ).status;
}

/** A bundle's review status and, when rejected, Twilio's reasons. */
export async function fetchBundle(
  fetch: FetchLike,
  auth: TwilioAuth,
  kind: BundleKind,
  bundleSid: string,
): Promise<{ status: string; issues: A2pIssue[] }> {
  const b = BundleAnswer.parse(
    await twilioRequest(fetch, auth, "GET", `${TWILIO_TRUSTHUB_API}/${kind}/${bundleSid}`),
  );
  return {
    status: b.status,
    issues: issuesOf(b.errors ?? [], kind === "CustomerProfiles" ? "profile" : "trust_product"),
  };
}

/**
 * Twilio's `errors[]` as kept: a campaign's shape `{error_code, fields, description}` (checked);
 * a brand's and a bundle's read the same way, with `code`/`message` as fallbacks (UNCHECKED).
 */
export function issuesOf(errors: readonly unknown[], source: A2pIssue["source"]): A2pIssue[] {
  return errors.flatMap((raw): A2pIssue[] => {
    if (typeof raw === "string") return [{ source, code: null, fields: [], description: raw }];
    const e = z
      .looseObject({
        error_code: z.union([z.number(), z.string()]).nullish(),
        code: z.union([z.number(), z.string()]).nullish(),
        fields: z.array(z.string()).nullish(),
        description: z.string().nullish(),
        message: z.string().nullish(),
      })
      .safeParse(raw);
    if (!e.success) return [];
    const code = e.data.error_code ?? e.data.code;
    return [
      {
        source,
        code: code == null ? null : String(code),
        fields: (e.data.fields ?? []).slice(0, 10),
        description: (e.data.description ?? e.data.message ?? "Twilio gave no reason").slice(
          0,
          500,
        ),
      },
    ];
  });
}

// ── Brand ────────────────────────────────────────────────────────────────────────────────────────

const BrandAnswer = z.looseObject({
  sid: BrandSid,
  status: z.string(),
  brand_type: z.string().nullish(),
  tcr_id: z.string().nullish(),
  failure_reason: z.string().nullish(),
  errors: z.array(z.unknown()).nullish(),
  mock: z.boolean().nullish(),
});
export interface BrandState {
  sid: string;
  status: string;
  tcrId: string | null;
  issues: A2pIssue[];
}

function brandState(b: z.infer<typeof BrandAnswer>): BrandState {
  const issues = issuesOf(b.errors ?? [], "brand");
  if (issues.length === 0 && b.status.toUpperCase() === "FAILED" && b.failure_reason) {
    issues.push({ source: "brand", code: null, fields: [], description: b.failure_reason });
  }
  return { sid: b.sid, status: b.status, tcrId: b.tcr_id ?? null, issues };
}

/**
 * Registers the brand (charged by Twilio). A Low-Volume Standard brand is `STANDARD` with
 * secondary vetting skipped (NOTES.md).
 */
export async function createBrand(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { customerProfileSid: string; trustProductSid: string; lowVolume: boolean },
): Promise<BrandState> {
  return brandState(
    BrandAnswer.parse(
      await twilioRequest(fetch, auth, "POST", `${TWILIO_MESSAGING_API}/a2p/BrandRegistrations`, {
        form: {
          CustomerProfileBundleSid: input.customerProfileSid,
          A2PProfileBundleSid: input.trustProductSid,
          BrandType: "STANDARD",
          ...(input.lowVolume ? { SkipAutomaticSecVet: "true" } : {}),
        },
      }),
    ),
  );
}

export async function fetchBrand(
  fetch: FetchLike,
  auth: TwilioAuth,
  brandSid: string,
): Promise<BrandState> {
  return brandState(
    BrandAnswer.parse(
      await twilioRequest(
        fetch,
        auth,
        "GET",
        `${TWILIO_MESSAGING_API}/a2p/BrandRegistrations/${brandSid}`,
      ),
    ),
  );
}

/** Resubmits a failed brand once its profile and trust product are fixed (free three times). */
export async function updateBrand(
  fetch: FetchLike,
  auth: TwilioAuth,
  brandSid: string,
): Promise<BrandState> {
  return brandState(
    BrandAnswer.parse(
      await twilioRequest(
        fetch,
        auth,
        "POST",
        `${TWILIO_MESSAGING_API}/a2p/BrandRegistrations/${brandSid}`,
        { form: {} },
      ),
    ),
  );
}

// ── Messaging Service, use cases, campaign, numbers ──────────────────────────────────────────────

/**
 * A new Messaging Service for the client's campaign. Inbound texts keep going to each number's own
 * webhook (`UseInboundWebhookOnNumber`), which our signature check is made over.
 */
export async function createA2pService(
  fetch: FetchLike,
  auth: TwilioAuth,
  input: { friendlyName: string; inboundUrl: string; statusUrl: string },
): Promise<string> {
  return Created(ServiceSid).parse(
    await twilioRequest(fetch, auth, "POST", `${TWILIO_MESSAGING_API}/Services`, {
      form: {
        FriendlyName: input.friendlyName.slice(0, 64),
        InboundRequestUrl: input.inboundUrl,
        StatusCallback: input.statusUrl,
        UseInboundWebhookOnNumber: "true",
      },
    }),
  ).sid;
}

/** The use cases Twilio offers the brand (step 5.1). */
export async function brandUseCases(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
  brandSid: string,
): Promise<string[]> {
  const body = z
    .looseObject({
      us_app_to_person_usecases: z.array(z.looseObject({ code: z.string() })).default([]),
    })
    .parse(
      await twilioRequest(
        fetch,
        auth,
        "GET",
        `${TWILIO_MESSAGING_API}/Services/${serviceSid}/Compliance/Usa2p/Usecases`,
        { query: { BrandRegistrationSid: brandSid } },
      ),
    );
  return body.us_app_to_person_usecases.map((u) => u.code);
}

const CampaignAnswer = z.looseObject({
  sid: z.string().nullish(),
  campaign_status: z.string().nullish(),
  us_app_to_person_usecase: z.string().nullish(),
  errors: z.array(z.unknown()).nullish(),
});
export interface CampaignState {
  status: string | null;
  issues: A2pIssue[];
}

function campaignState(c: z.infer<typeof CampaignAnswer> | undefined): CampaignState | null {
  if (!c) return null;
  return { status: c.campaign_status ?? null, issues: issuesOf(c.errors ?? [], "campaign") };
}

/** The campaign's form: Twilio's names; samples and keywords are lists (repeated fields). */
function campaignForm(input: {
  brandSid: string;
  useCase: "MIXED" | "LOW_VOLUME";
  text: A2pCampaignText;
  details: A2pBusinessDetails;
}) {
  const k = a2pKeywordsOf(input.details.legalName);
  return {
    form: {
      BrandRegistrationSid: input.brandSid,
      Description: input.text.description,
      MessageFlow: input.text.messageFlow,
      UsAppToPersonUsecase: input.useCase,
      HasEmbeddedLinks: String(input.details.hasLinks),
      HasEmbeddedPhone: String(input.details.hasPhoneNumbers),
      OptInMessage: k.optInMessage,
      OptOutMessage: k.optOutMessage,
      HelpMessage: k.helpMessage,
      SubscriberOptIn: "true",
      AgeGated: "false",
      DirectLending: "false",
      PrivacyPolicyUrl: input.details.privacyPolicyUrl,
      TermsAndConditionsUrl: input.details.termsUrl,
    },
    repeatedMany: [
      { name: "MessageSamples", values: input.text.samples },
      { name: "OptInKeywords", values: k.optInKeywords },
      { name: "OptOutKeywords", values: k.optOutKeywords },
      { name: "HelpKeywords", values: k.helpKeywords },
    ],
  };
}

/** Creates the campaign on the service (vetted and charged by Twilio). */
export async function createCampaign(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
  input: {
    brandSid: string;
    useCase: "MIXED" | "LOW_VOLUME";
    text: A2pCampaignText;
    details: A2pBusinessDetails;
  },
): Promise<CampaignState> {
  const c = CampaignAnswer.parse(
    await twilioRequest(
      fetch,
      auth,
      "POST",
      `${TWILIO_MESSAGING_API}/Services/${serviceSid}/Compliance/Usa2p`,
      campaignForm(input),
    ),
  );
  return campaignState(c) ?? { status: null, issues: [] };
}

/** The service's campaign, or null when it has none. */
export async function fetchCampaign(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
): Promise<CampaignState | null> {
  const body = z
    .looseObject({ compliance: z.array(CampaignAnswer).default([]) })
    .parse(
      await twilioRequest(
        fetch,
        auth,
        "GET",
        `${TWILIO_MESSAGING_API}/Services/${serviceSid}/Compliance/Usa2p`,
      ),
    );
  return campaignState(body.compliance[0]);
}

/** Deletes the service's (failed) campaign, to make it again. */
export async function deleteCampaign(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
): Promise<void> {
  await twilioRequest(
    fetch,
    auth,
    "DELETE",
    `${TWILIO_MESSAGING_API}/Services/${serviceSid}/Compliance/Usa2p/${USA2P_COMPLIANCE_SID}`,
  );
}

/** The numbers (PN…) already in the service. */
export async function serviceNumbers(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
): Promise<string[]> {
  const body = z
    .looseObject({ phone_numbers: z.array(z.looseObject({ sid: z.string() })).default([]) })
    .parse(
      await twilioRequest(
        fetch,
        auth,
        "GET",
        `${TWILIO_MESSAGING_API}/Services/${serviceSid}/PhoneNumbers`,
        { query: { PageSize: "400" } },
      ),
    );
  return body.phone_numbers.map((p) => p.sid);
}

export async function addServiceNumber(
  fetch: FetchLike,
  auth: TwilioAuth,
  serviceSid: string,
  numberSid: string,
): Promise<void> {
  await twilioRequest(
    fetch,
    auth,
    "POST",
    `${TWILIO_MESSAGING_API}/Services/${serviceSid}/PhoneNumbers`,
    { form: { PhoneNumberSid: numberSid } },
  );
}
