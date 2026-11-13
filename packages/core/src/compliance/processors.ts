// HIPAA mode (docs/plan.md §1.35): which of Mezonas' own vendors ("processors") a feature sends a
// client's data to, and whether a client in HIPAA mode may use it. A processor may receive a HIPAA
// client's data only when it is listed in `BAA_PROCESSORS` (a Worker variable the owner sets once
// that vendor's BAA is signed). The client's own tools (QuickBooks, Gmail, Zoho CRM, Podio, its
// webhook endpoints, the sites of its browser logins, its Google Chat: v0.14 W4-E) are the
// client's vendors, not ours: they are not processors here. Plaid, which carries the bank feed on
// Mezonas' own account, is.
// M46: the website connector (`website`) sends nothing to a new vendor: it writes guides to our own
// bucket at Cloudflare (infrastructure), and tells IndexNow only the public address of a page the
// client published (docs/plan.md §1.76).
// v0.14 W4-D: Google Drive and Google Sheets (`gdrive`, `gsheets`) are not: the client's own Google
// account, which only the client signs in to; we send its data nowhere else.
// M45: Google Search Console and Bing Webmaster Tools (`gsc`, `bing_webmaster`) are not either: the
// client's own accounts with Google and Microsoft, holding figures about the client's own site that
// those vendors already have; we only read them, with a key the client enters, and send them
// nothing (docs/plan.md §1.75). Mezonas has no contract with either for this. M50: `gsc_oauth`,
// the same Search Console account by Google sign-in, is not a processor either (§1.78).
// §1.87: BILL (`billcom`) is, though the organization is the client's own: every call goes out
// under Mezonas' developer key and agreement with BILL, as Plaid's do (the owner's brief).

import { z } from "zod";
import { modelProvider } from "../api/models";

export const PROCESSORS = [
  // Infrastructure: every request and every stored record goes through these.
  "cloudflare",
  "neon",
  "workos",
  // Models.
  "anthropic",
  "openai",
  // Models: xAI (Grok) for `xai:` ids, Google (the Gemini API) for `google:` ids.
  "xai",
  "google",
  // Messaging and calls on Mezonas' accounts.
  "twilio",
  "meta_whatsapp",
  "elevenlabs",
  "resend",
  // v0.12 bankfeed: bank and card feeds (docs/plan.md §1.52).
  "plaid",
  // §1.77: web research (`web.search`, `web.fetch`) through the model vendor's server-side tools,
  // and Hacker News search (`hackernews.*`, Algolia's search and the official item API).
  "anthropic_web",
  "hackernews",
  // §1.87: BILL (Bill.com), accounts payable, on Mezonas' developer key.
  "billcom",
  // §1.97: phone notifications through Expo's push service (on to Apple's and Google's): a device
  // token, "Mezonas" or the business's name, and a count. HIPAA mode sends none until covered.
  "expo_push",
] as const;
export type Processor = (typeof PROCESSORS)[number];

/** Needed by every client: HIPAA mode can't be turned on until all of them are covered. */
export const INFRASTRUCTURE_PROCESSORS: readonly Processor[] = ["cloudflare", "neon", "workos"];

export const PROCESSOR_NAMES: Record<Processor, string> = {
  cloudflare: "Cloudflare",
  neon: "Neon",
  workos: "WorkOS",
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  google: "Google (Gemini API)",
  twilio: "Twilio",
  meta_whatsapp: "WhatsApp (Meta)",
  elevenlabs: "ElevenLabs",
  resend: "Resend",
  plaid: "Plaid",
  // §1.77
  anthropic_web: "Anthropic web search and fetch",
  hackernews: "Hacker News (Algolia and Firebase)",
  // §1.87
  billcom: "BILL",
  // §1.97
  expo_push: "Expo (push notifications)",
};

/** `BAA_PROCESSORS`: comma- or space-separated processor ids; unknown words are ignored. */
export function parseCoveredProcessors(raw: string | null | undefined): ReadonlySet<Processor> {
  const known = new Set<string>(PROCESSORS);
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((w) => w.trim().toLowerCase())
      .filter((w): w is Processor => known.has(w)),
  );
}

/**
 * A model id's provider: `openai:` ids go to OpenAI, `xai:` ids to xAI, `google:` ids to Google,
 * everything else to Anthropic. Each provider is its own processor, so a client in HIPAA mode is
 * refused a model until that provider's BAA is recorded in `BAA_PROCESSORS`.
 */
// DECISION: `google` is the Gemini API on Mezonas' own key, a vendor of ours. It is not the
// client's own Google account (Gmail, Drive, Sheets, Search Console), which needs no listing.
export function processorForModel(modelId: string): Processor {
  return modelProvider(modelId);
}

/**
 * §1.88: what makes the vendor catalog's embeddings (master items, vendor items, new lines),
 * and so where their text goes. A client in HIPAA mode is refused them until that provider's BAA
 * is recorded, as its model calls are (apps/api's `guardModels` holds `embed` to it).
 */
// DECISION: embeddings are a feature of their own here (not hidden in "a model call"): an item's
// text goes to OpenAI even when every agent of the client runs on Anthropic's models.
export const EMBEDDING_FEATURE = {
  id: "materials.embeddings",
  what: "The vendor catalog's search by meaning (embeddings of item names)",
  model: "openai:text-embedding-3-large",
} as const;

/** The processor an embedding model's provider is: `openai:` ids go to OpenAI. */
export function processorForEmbedding(modelId: string): Processor {
  return modelProvider(modelId);
}

// DECISION: connectors are named here by id rather than each manifest declaring its processors:
// the list is the platform's data-flow inventory (SOC 2 C1, HIPAA §164.308(b)) in one place, and a
// new connector that sends data to a vendor of ours must be added here (a test lists them).
const CONNECTOR_PROCESSORS: Record<string, readonly Processor[]> = {
  twilio: ["twilio"],
  resend: ["resend"],
  elevenlabs: ["elevenlabs"],
  // DECISION: v0.12 bankfeed: Plaid is ours, not the client's tool. Mezonas holds the Plaid
  // account and contract, and the client's bank data passes through it to us, so it is a
  // processor (a subprocessor on the site), unlike the bank itself or QuickBooks. A client in
  // HIPAA mode can't be offered the bank feed until `plaid` is in BAA_PROCESSORS.
  bankfeed: ["plaid"],
  // v0.14 W4-A: WhatsApp on the client's own number through Meta's Cloud API (docs/plan.md §1.57):
  // the messages pass through Meta to us, as they do for Twilio's WhatsApp, so it is the same
  // processor (`meta_whatsapp`) a client in HIPAA mode needs covered.
  whatsapp_meta: ["meta_whatsapp"],
  // DECISION (§1.77): Hacker News is a public service with no account, but an agent's search words
  // go to Algolia (and item ids to Firebase), so a client in HIPAA mode is refused it like any
  // vendor of ours without a BAA. LinkedIn is not here: it is the client's own company page, which
  // only the client signs in to, like Slack.
  hackernews: ["hackernews"],
  // DECISION (§1.87): BILL is a processor, unlike QuickBooks or Ramp, because the calls go out
  // under Mezonas' developer key (BILL_DEV_KEY) and its developer agreement with BILL, the way
  // Plaid's account is ours. A client in HIPAA mode is refused it until `billcom` is in
  // BAA_PROCESSORS.
  billcom: ["billcom"],
};

/** The processors a connector sends a client's data to, whichever of its tools is used. */
export function processorsForConnector(connectorId: string): readonly Processor[] {
  return CONNECTOR_PROCESSORS[connectorId] ?? [];
}

/** A tool's processors: its connector's, plus WhatsApp for `whatsapp.*` and ElevenLabs for `call.*`. */
export function processorsForTool(toolId: string, connectorId: string | null): Processor[] {
  const out = new Set<Processor>(connectorId ? processorsForConnector(connectorId) : []);
  if (toolId.startsWith("whatsapp.")) out.add("meta_whatsapp");
  if (toolId.startsWith("call.")) out.add("elevenlabs");
  // DECISION (§1.77): web research is its own processor, not `anthropic`: the vendor's search and
  // fetch tools send the agent's words on to search and web providers, so a BAA that covers the
  // model alone does not cover them.
  if (toolId.startsWith("web.")) out.add("anthropic_web");
  return [...out];
}

/** Offering a connector: its own processors, and WhatsApp and calls for Twilio's. */
export function processorsForOffer(connectorId: string): Processor[] {
  const out = new Set<Processor>(processorsForConnector(connectorId));
  if (connectorId === "twilio") {
    out.add("meta_whatsapp");
    out.add("elevenlabs");
  }
  return [...out];
}

// ── The client's profile ────────────────────────────────────────────────────────────────────────

export const ComplianceProfile = z.object({
  hipaa: z.boolean().default(false),
});
export type ComplianceProfile = z.infer<typeof ComplianceProfile>;

/** `tenant.settings.compliance`; anything unreadable is the default (off). */
export function complianceOf(
  settings: Record<string, unknown> | null | undefined,
): ComplianceProfile {
  const parsed = ComplianceProfile.safeParse(settings?.compliance ?? {});
  return parsed.success ? parsed.data : { hipaa: false };
}

/** The processors of `needed` that a client may not use, given its profile and the signed BAAs. */
export function uncoveredProcessors(
  profile: ComplianceProfile,
  covered: ReadonlySet<Processor>,
  needed: readonly Processor[],
): Processor[] {
  if (!profile.hipaa) return [];
  return [...new Set(needed)].filter((p) => !covered.has(p));
}

/** Why a client in HIPAA mode can't use something, or null when it can. */
export function processingRefusal(
  profile: ComplianceProfile,
  covered: ReadonlySet<Processor>,
  needed: readonly Processor[],
  what: string,
): string | null {
  const missing = uncoveredProcessors(profile, covered, needed);
  if (missing.length === 0) return null;
  const names = missing.map((p) => PROCESSOR_NAMES[p]).join(", ");
  const verb = missing.length === 1 ? "has" : "have";
  return `${what} sends data to ${names}, which ${verb} no signed BAA; this client is in HIPAA mode`;
}

// ── What HIPAA mode holds back, whoever the vendor ──────────────────────────────────────────────

/**
 * M50 (docs/plan.md §1.78): what a pack takes in from the public with no session (the inbound
 * route, `POST /api/in/:pack/:tenantId/:target`: a measured website's beacons). Its vendors are
 * only our infrastructure, so no processor is missing; but a visit to a health client's site can
 * itself be health information (a page about a condition, a booking page), and we have not
 * decided how to measure such a site. So for a client in HIPAA mode the route stores nothing and
 * the pack is never called, until the owner decides; the answer is still 204.
 */
// DECISION: held for every pack's inbound, not only measurement: the route can't tell what a
// pack's inbound keeps, and nothing else uses it yet. Turning HIPAA mode off resumes it; what was
// stored before HIPAA mode was turned on stays (its retention limits still apply).
export function inboundHeld(profile: ComplianceProfile): boolean {
  return profile.hipaa;
}

/**
 * Whether a client may be put in HIPAA mode: the infrastructure must be covered, and no connector
 * it is offered may need an uncovered processor. Returns the problems, empty when it may.
 */
export function hipaaReadiness(
  covered: ReadonlySet<Processor>,
  offeredConnectorIds: readonly string[],
): string[] {
  const on: ComplianceProfile = { hipaa: true };
  const names = (ps: Processor[]) => ps.map((p) => PROCESSOR_NAMES[p]).join(", ");
  const problems: string[] = [];
  const infra = uncoveredProcessors(on, covered, INFRASTRUCTURE_PROCESSORS);
  if (infra.length > 0) {
    problems.push(`Every client needs a signed BAA with ${names(infra)}; there isn't one yet.`);
  }
  for (const id of offeredConnectorIds) {
    const missing = uncoveredProcessors(on, covered, processorsForOffer(id));
    if (missing.length > 0) {
      problems.push(
        `The ${id} connector is offered and sends data to ${names(missing)}, with no signed BAA. Withdraw it first.`,
      );
    }
  }
  return problems;
}
