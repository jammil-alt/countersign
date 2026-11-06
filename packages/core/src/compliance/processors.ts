// HIPAA mode (docs/plan.md §1.35): which of Mezonas' own vendors ("processors") a feature sends a
// client's data to, and whether a client in HIPAA mode may use it. A processor may receive a HIPAA
// client's data only when it is listed in `BAA_PROCESSORS` (a Worker variable the owner sets once
// that vendor's BAA is signed). The client's own tools (QuickBooks, Gmail, Zoho CRM, Podio, its
// webhook endpoints, the sites of its browser logins, its Google Chat: v0.14 W4-E) are the
// client's vendors, not ours: they are not processors here. Plaid, which carries the bank feed on
// Mezonas' own account, is.

import { z } from "zod";

export const PROCESSORS = [
  // Infrastructure: every request and every stored record goes through these.
  "cloudflare",
  "neon",
  "workos",
  // Models.
  "anthropic",
  "openai",
  // Messaging and calls on Mezonas' accounts.
  "twilio",
  "meta_whatsapp",
  "elevenlabs",
  "resend",
  // v0.12 bankfeed: bank and card feeds (docs/plan.md §1.52).
  "plaid",
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
  twilio: "Twilio",
  meta_whatsapp: "WhatsApp (Meta)",
  elevenlabs: "ElevenLabs",
  resend: "Resend",
  plaid: "Plaid",
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

/** A model id's provider: `openai:` ids go to OpenAI, everything else to Anthropic. */
export function processorForModel(modelId: string): Processor {
  return modelId.startsWith("openai:") ? "openai" : "anthropic";
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
