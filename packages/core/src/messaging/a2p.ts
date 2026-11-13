import { z } from "zod";
import { dec } from "../money";
import { E164, HELP_WORDS, OPT_IN_WORDS, OPT_OUT_WORDS } from "./rules";

// P-8: US texting registration (A2P 10DLC) by Twilio's ISV API (docs/plan.md §1.70). What the
// client admin gives, what is kept on the client's `twilio` connection, the fees Twilio charges and
// the campaign's words. Twilio's field names and allowed values are checked against its docs
// (packages/connectors/src/twilio/NOTES.md, "A2P 10DLC by API"). Pure: the API, the connector and
// the web app share it.

export const A2P_BUSINESS_TYPES = [
  "Co-operative",
  "Corporation",
  "Limited Liability Corporation",
  "Non-profit Corporation",
  "Partnership",
] as const;

export const A2P_INDUSTRIES = [
  "AGRICULTURE",
  "AUTOMOTIVE",
  "BANKING",
  "CONSTRUCTION",
  "CONSUMER",
  "EDUCATION",
  "ELECTRONICS",
  "ENGINEERING",
  "ENERGY",
  "FAST_MOVING_CONSUMER_GOODS",
  "FINANCIAL",
  "FINTECH",
  "FOOD_AND_BEVERAGE",
  "GOVERNMENT",
  "HEALTHCARE",
  "HOSPITALITY",
  "INSURANCE",
  "JEWELRY",
  "LEGAL",
  "MANUFACTURING",
  "MEDIA",
  "NOT_FOR_PROFIT",
  "OIL_AND_GAS",
  "ONLINE",
  "PROFESSIONAL_SERVICES",
  "RAW_MATERIALS",
  "REAL_ESTATE",
  "RELIGION",
  "RETAIL",
  "TECHNOLOGY",
  "TELECOMMUNICATIONS",
  "TRANSPORTATION",
  "TRAVEL",
] as const;

// DECISION: public companies (stock ticker, Authentication+ email) are not offered (plan §1.70).
export const A2P_COMPANY_TYPES = ["private", "non-profit", "government"] as const;
export const A2P_REGIONS = ["USA_AND_CANADA", "LATIN_AMERICA", "EUROPE", "ASIA", "AFRICA"] as const;
export const A2P_POSITIONS = [
  "Director",
  "GM",
  "VP",
  "CEO",
  "CFO",
  "General Counsel",
  "Other",
] as const;
/** What the company texts: never marketing (owner, 2026-11-08). */
export const A2P_USES = ["team", "vendors", "customer_care"] as const;
/** Fewer than 6,000 texts a day (Low-Volume Standard brand), or more (Standard brand). */
export const A2P_VOLUMES = ["low", "standard"] as const;

export type A2pUse = (typeof A2P_USES)[number];
export type A2pVolume = (typeof A2P_VOLUMES)[number];

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Whether `v` is an http(s) link with a host that has a dot, checked by a scan (no pattern). */
export function isWebLink(v: string): boolean {
  const lower = v.toLowerCase();
  const scheme = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0;
  if (scheme === 0) return false;
  let host = "";
  for (const ch of lower.slice(scheme)) {
    if (ch === "/" || ch === "?" || ch === "#") break;
    host += ch;
  }
  if (host.length < 3 || !host.includes(".") || host.startsWith(".") || host.endsWith(".")) {
    return false;
  }
  for (const ch of host) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "-" ||
      ch === ":";
    if (!ok) return false;
  }
  for (const ch of v) if (ch === " " || ch === "\n" || ch === "\t") return false;
  return true;
}

/** An http(s) link. */
export const WebLink = z
  .string()
  .trim()
  .max(500)
  .refine(isWebLink, "a full link, starting with https://");

export const A2pAddress = z.strictObject({
  street: text(2, 120),
  streetSecondary: z.string().trim().max(120).optional(),
  city: text(2, 80),
  /** The state's two-letter code. */
  region: z.string().regex(/^[A-Z]{2}$/, "the state's two-letter code, e.g. TX"),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/, "a ZIP code, e.g. 78701"),
  country: z.literal("US"),
});

export const A2pRepresentative = z.strictObject({
  firstName: text(1, 60),
  lastName: text(1, 60),
  /** Their exact job title. */
  title: text(2, 80),
  position: z.enum(A2P_POSITIONS),
  phone: E164,
  email: z.email().max(200),
});

/** The business details the client admin gives (no EIN: that goes to the vault). */
export const A2pBusinessDetails = z.strictObject({
  /** Exactly as on the EIN letter (CP 575 or 147C). */
  legalName: text(2, 255),
  businessType: z.enum(A2P_BUSINESS_TYPES),
  industry: z.enum(A2P_INDUSTRIES),
  companyType: z.enum(A2P_COMPANY_TYPES),
  website: WebLink,
  socialLinks: z.string().trim().max(500).optional(),
  regions: z.array(z.enum(A2P_REGIONS)).min(1).max(5).default(["USA_AND_CANADA"]),
  address: A2pAddress,
  representative: A2pRepresentative,
  volume: z.enum(A2P_VOLUMES).default("low"),
  uses: z.array(z.enum(A2P_USES)).min(1).max(3),
  /** How people agree to texts, in the client's own words (Twilio's message flow). */
  optIn: text(40, 2048),
  privacyPolicyUrl: WebLink,
  termsUrl: WebLink,
  hasLinks: z.boolean().default(false),
  hasPhoneNumbers: z.boolean().default(false),
});
export type A2pBusinessDetails = z.infer<typeof A2pBusinessDetails>;

// ── The EIN ──────────────────────────────────────────────────────────────────────────────────────

/** An EIN as people type it (`12-3456789`, `123456789`, spaces) in Twilio's `00-0000000`, or null. */
export function normalizeEin(raw: string): string | null {
  let digits = "";
  for (const ch of raw.trim()) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (ch !== "-" && ch !== " ") return null;
  }
  return digits.length === 9 ? `${digits.slice(0, 2)}-${digits.slice(2)}` : null;
}

/** What a screen may show of an EIN: its last two digits. */
export function einHint(ein: string): string {
  return `••-•••••${ein.slice(-2)}`;
}

/**
 * `text` with every occurrence of the EIN (with or without its dash) replaced: Twilio's answers
 * may quote what they were given, and nothing of ours keeps or shows it.
 */
export function redactEin(text: string, ein: string | null): string {
  if (!ein) return text;
  const plain = ein.replace("-", "");
  return text.split(ein).join("[EIN]").split(plain).join("[EIN]");
}

// ── What is kept ─────────────────────────────────────────────────────────────────────────────────

export const A2P_STAGES = [
  "draft",
  "submitted",
  "campaign",
  "ready",
  "needs_changes",
  "suspended",
] as const;
export const A2pStage = z.enum(A2P_STAGES);
export type A2pStage = z.infer<typeof A2pStage>;

export const A2P_ISSUE_SOURCES = [
  "profile",
  "trust_product",
  "brand",
  "campaign",
  "use_case",
] as const;

/** One of Twilio's reasons, as kept and shown. */
export const A2pIssue = z.object({
  source: z.enum(A2P_ISSUE_SOURCES),
  code: z.string().nullable(),
  fields: z.array(z.string()),
  description: z.string(),
});
export type A2pIssue = z.infer<typeof A2pIssue>;

/** The campaign's words: built from the details, editable by the operator before a submit. */
export const A2pCampaignText = z.strictObject({
  description: text(40, 4096),
  samples: z.array(text(20, 1024)).min(2).max(5),
  messageFlow: text(40, 2048),
});
export type A2pCampaignText = z.infer<typeof A2pCampaignText>;

const Sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9a-fA-F]{32}$`));

/** `connection.config.a2p.registration` on the client's `twilio` connection. */
export const A2pRegistrationState = z.looseObject({
  stage: A2pStage.default("draft"),
  details: A2pBusinessDetails.nullable().default(null),
  detailsUpdatedAt: z.string().nullable().default(null),
  einHint: z.string().nullable().default(null),
  einSetAt: z.string().nullable().default(null),
  /** Set at the first submit, from the details' volume. */
  brandType: z.enum(["standard", "low_volume"]).nullable().default(null),
  useCase: z.enum(["MIXED", "LOW_VOLUME"]).nullable().default(null),
  customerProfileSid: Sid("BU").nullable().default(null),
  customerProfileStatus: z.string().nullable().default(null),
  trustProductSid: Sid("BU").nullable().default(null),
  trustProductStatus: z.string().nullable().default(null),
  endUsers: z
    .object({
      business: Sid("IT").nullable().default(null),
      representative: Sid("IT").nullable().default(null),
      messagingProfile: Sid("IT").nullable().default(null),
    })
    .default({ business: null, representative: null, messagingProfile: null }),
  addressSid: Sid("AD").nullable().default(null),
  supportingDocumentSid: Sid("RD").nullable().default(null),
  /** What has been assigned to which bundle (`<bundle sid>:<object sid>`), so a retry skips it. */
  assigned: z.array(z.string()).default([]),
  /** The operator's edit of the campaign's words; null: built from the details. */
  campaign: A2pCampaignText.nullable().default(null),
  /** How many times a campaign was made (each one is vetted and charged). */
  campaignAttempts: z.number().int().nonnegative().default(0),
  /** The campaign as last sent to Twilio. */
  submittedCampaign: A2pCampaignText.nullable().default(null),
  /** Numbers (PN…) added to the Messaging Service. */
  serviceNumbers: z.array(z.string()).default([]),
  issues: z.array(A2pIssue).default([]),
  /** Brand updates after a rejection (Twilio: three are free). */
  brandUpdates: z.number().int().nonnegative().default(0),
  submissions: z
    .array(z.object({ at: z.string(), by: z.string(), reason: z.string() }))
    .default([]),
  /** Fees recorded, by key, with their amount (the raw records are the source). */
  fees: z
    .array(z.object({ key: z.string(), kind: z.string(), amountUsd: z.string(), at: z.string() }))
    .default([]),
  /** The last stage people were told about. */
  notifiedStage: A2pStage.nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type A2pRegistrationState = z.infer<typeof A2pRegistrationState>;

export function readA2pRegistration(value: unknown): A2pRegistrationState | null {
  if (value === undefined || value === null) return null;
  const r = A2pRegistrationState.safeParse(value);
  return r.success ? r.data : null;
}

export function emptyA2pRegistration(): A2pRegistrationState {
  return A2pRegistrationState.parse({});
}

/** Whether the client admin may change the details now. */
export function a2pEditable(stage: A2pStage): boolean {
  return stage === "draft" || stage === "needs_changes";
}

/** Whether the operator may submit now. */
export function a2pSubmittable(state: A2pRegistrationState, einSet: boolean): string[] {
  const missing: string[] = [];
  if (!a2pEditable(state.stage)) missing.push("stage");
  if (!state.details) missing.push("details");
  if (!einSet) missing.push("ein");
  return missing;
}

export function a2pBrandTypeOf(volume: A2pVolume): "standard" | "low_volume" {
  return volume === "standard" ? "standard" : "low_volume";
}

/**
 * The campaign's use case, from the brand type only: `MIXED` for a Standard brand, `LOW_VOLUME`
 * for a Low-Volume Standard one (Twilio's "Gather business information": both cover several
 * use cases; our texts are the team's, vendors' and customer care). Never from input.
 */
// DECISION: never marketing (owner, 2026-11-08); `MIXED`/`LOW_VOLUME` because no single use case
// covers internal, vendor and customer-care texts (plan §1.70).
export function a2pUseCaseOf(brandType: "standard" | "low_volume"): "MIXED" | "LOW_VOLUME" {
  return brandType === "standard" ? "MIXED" : "LOW_VOLUME";
}

// ── Fees ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Twilio's A2P 10DLC fees in USD (https://www.twilio.com/en-us/phone-numbers/a2p-10dlc, read
 * 2026-11-08). The monthly amounts per use case are TCR's rates as resellers quote them; Twilio's
 * page gives the range $1.50–$10 (NOTES.md: to confirm with Twilio's help article).
 */
// DECISION: a table in code with its source and date, not an operator setting (plan §1.70).
export const A2P_FEES = {
  checkedAt: "2026-11-08",
  source: "https://www.twilio.com/en-us/phone-numbers/a2p-10dlc",
  brand: { standard: "44.0000", low_volume: "4.0000" },
  vetting: "15.0000",
  monthly: { MIXED: "10.0000", LOW_VOLUME: "1.5000" },
} as const;

export const A2P_FEE_KINDS = ["brand", "vetting", "monthly"] as const;
export type A2pFeeKind = (typeof A2P_FEE_KINDS)[number];

export const A2pFeeLine = z.object({
  kind: z.enum(A2P_FEE_KINDS),
  label: z.string(),
  amountUsd: z.string(),
  /** Charged every month while the campaign is registered. */
  monthly: z.boolean(),
});
export type A2pFeeLine = z.infer<typeof A2pFeeLine>;

/**
 * What the next submit will charge, as the operator sees it before submitting: a first submit the
 * brand, the vetting and (once verified) the monthly fee; a resubmit after a brand or profile
 * rejection nothing new (three brand updates are free) unless the campaign must be made again;
 * after a campaign rejection a new vetting fee (the campaign is deleted and made again).
 */
export function a2pFeePreview(
  state: A2pRegistrationState,
  volume: A2pVolume,
): { lines: A2pFeeLine[]; nowUsd: string } {
  const brandType = state.brandType ?? a2pBrandTypeOf(volume);
  const useCase = a2pUseCaseOf(brandType);
  const lines: A2pFeeLine[] = [];
  const brandMade = state.fees.some((f) => f.kind === "brand");
  if (!brandMade) {
    lines.push({
      kind: "brand",
      label:
        brandType === "standard"
          ? "Brand registration (Standard), one time"
          : "Brand registration (Low-Volume Standard), one time",
      amountUsd: A2P_FEES.brand[brandType],
      monthly: false,
    });
  }
  const campaignFailed = state.issues.some((i) => i.source === "campaign");
  if (state.campaignAttempts === 0 || campaignFailed) {
    lines.push({
      kind: "vetting",
      label:
        state.campaignAttempts === 0
          ? "Campaign vetting, one time (charged when the brand is approved)"
          : "Campaign vetting again (the rejected campaign is made again)",
      amountUsd: A2P_FEES.vetting,
      monthly: false,
    });
  }
  lines.push({
    kind: "monthly",
    label: `Campaign fee (${useCase}), every month once approved`,
    amountUsd: A2P_FEES.monthly[useCase],
    monthly: true,
  });
  const now = lines
    .filter((l) => !l.monthly)
    .reduce((sum, l) => sum.plus(dec(l.amountUsd)), dec("0"));
  return { lines, nowUsd: now.toFixed(4) };
}

// ── The campaign's words ─────────────────────────────────────────────────────────────────────────

const USE_WORDS: Record<A2pUse, string> = {
  team: "its own team (sign-in codes and work updates)",
  vendors: "its vendors (orders, deliveries and invoices)",
  customer_care: "its customers who asked to hear from it (customer care about their orders)",
};

/** The campaign's description, samples and opt-in text, from the details. */
export function a2pCampaignTextOf(details: A2pBusinessDetails): A2pCampaignText {
  const name = details.legalName;
  const uses = A2P_USES.filter((u) => details.uses.includes(u));
  const to = uses.map((u) => USE_WORDS[u]);
  const list =
    to.length === 1 ? to[0] : `${to.slice(0, -1).join(", ")} and ${to[to.length - 1] ?? ""}`;
  const description = `${name} sends its own operational texts through Mezonas, its back-office service, to ${list}. Recipients are people the business works with who gave it their mobile number and agreed to texts. No marketing or promotional messages are sent.`;
  const samples: string[] = [];
  if (uses.includes("team")) {
    samples.push(
      `${name}: Mezonas code: [code]. Enter it to let [agent name] use [tool] for this run. It expires in 10 minutes. Reply STOP to opt out.`,
    );
  }
  if (uses.includes("vendors")) {
    samples.push(
      `Hi [vendor contact], this is [agent name] for ${name}. Could you send the invoice for order [PO number] delivered on [date]? Reply to this text. Reply STOP to opt out.`,
    );
  }
  if (uses.includes("customer_care")) {
    samples.push(
      `Hi [customer name], ${name} here. Your order [order number] is ready on [date]. Questions? Reply to this text. Reply STOP to opt out, HELP for help.`,
    );
  }
  if (samples.length < 2) {
    samples.push(
      `${name}: [agent name] here with an update on [subject]: [details]. Reply to this text with any questions. Reply STOP to opt out.`,
    );
  }
  return {
    description,
    samples,
    messageFlow: `${details.optIn} Privacy policy: ${details.privacyPolicyUrl}. Terms: ${details.termsUrl}.`,
  };
}

/**
 * The line a client's forms carry where people give their mobile number (docs/plan.md §1.97): the
 * call to action carriers check when they vet the campaign.
 */
export function smsDisclosureLine(business: string): string {
  return `By giving us your mobile number you agree to texts from ${business} about your orders. Msg & data rates may apply. Reply STOP to opt out.`;
}

/**
 * The starting words for "how people agree to texts" on the relationship basis (§1.97), for the
 * client to edit: where their forms ask for the number, and the line those forms carry. The part
 * in brackets is theirs to fill in.
 */
// DECISION: the relationship basis still needs a call to action a carrier can check (US 10DLC
// vetting), so the starting words point to the client's own forms and the one-line disclosure on
// them, rather than claiming a separate opt-in. In English: it goes to Twilio and the carriers.
export function a2pRelationshipOptIn(business: string): string {
  const name = business.trim() || "[Business]";
  return `${name} texts only the vendors and customers it does business with, about their orders, deliveries and invoices. They give ${name} their mobile number on [where: e.g. our credit application, order form and online account at example.com/account], and each of those forms says: "${smsDisclosureLine(name)}" The first text to each person names ${name} and says how to opt out. No marketing is sent.`;
}

/** Opt-in, opt-out and help keywords and replies, with the business's name (Twilio: 20–320). */
export function a2pKeywordsOf(legalName: string) {
  const name = legalName.slice(0, 120);
  return {
    optInKeywords: [...OPT_IN_WORDS],
    optInMessage: `${name}: you are signed up for texts from us. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    optOutKeywords: [...OPT_OUT_WORDS],
    optOutMessage: `${name}: you have been unsubscribed and will get no more texts from us. Reply START to sign up again.`,
    helpKeywords: [...HELP_WORDS],
    helpMessage: `${name}: reply to this text to reach us. Msg & data rates may apply. Reply STOP to opt out.`,
  };
}

// ── Marketing refused ────────────────────────────────────────────────────────────────────────────

const MARKETING_WORDS = new Set([
  "promo",
  "promos",
  "promotion",
  "promotions",
  "promotional",
  "discount",
  "discounts",
  "coupon",
  "coupons",
  "marketing",
  "advertising",
  "advertisement",
]);

/** Whole words in `text` that read as marketing, by a letter scan (no pattern on the input). */
export function marketingWordsIn(text: string): string[] {
  const found = new Set<string>();
  let word = "";
  const flush = () => {
    if (word && MARKETING_WORDS.has(word)) found.add(word);
    word = "";
  };
  for (const ch of text.toLowerCase()) {
    if (ch >= "a" && ch <= "z") word += ch;
    else flush();
  }
  flush();
  return [...found];
}

/** The marketing words in a campaign's description and samples ("no marketing or promotional"
 * in our own description is ours, not a promotion, and is left out of the check). */
export function campaignMarketingWords(c: A2pCampaignText): string[] {
  const ours = "No marketing or promotional messages are sent.";
  return marketingWordsIn([c.description.split(ours).join(" "), ...c.samples].join("\n"));
}

// ── What people are told ─────────────────────────────────────────────────────────────────────────

/** Twilio's field names in a reason, said in plain words for the person fixing it. */
const FIELD_WORDS: Record<string, string> = {
  business_name: "the legal name",
  business_registration_number: "the EIN",
  business_type: "the business type",
  business_industry: "the industry",
  website_url: "the website",
  first_name: "the representative's first name",
  last_name: "the representative's last name",
  email: "the representative's email",
  phone_number: "the representative's phone",
  street: "the address",
  city: "the address",
  region: "the address",
  postal_code: "the address",
  USE_CASE_DESCRIPTION: "the campaign description",
  MESSAGE_FLOW: "how people agree to texts",
  SAMPLE_MESSAGE_1: "the first sample message",
  SAMPLE_MESSAGE_2: "the second sample message",
  PRIVACY_POLICY_URL: "the privacy policy link",
  TERMS_AND_CONDITIONS_URL: "the terms link",
};

/** One reason as a sentence: Twilio's words, then what to change. */
export function a2pIssueWords(issue: A2pIssue): string {
  const fields = [...new Set(issue.fields.map((f) => FIELD_WORDS[f] ?? f.toLowerCase()))];
  const fix = fields.length > 0 ? ` Check ${fields.join(", ")}.` : "";
  return `${issue.description}${fix}`;
}
