import { z } from "zod";

// Texts and WhatsApp messages to a client's contacts (docs/plan.md §1.19, §1.22): phone numbers,
// consent, opt-out words, quiet hours and WhatsApp's 24-hour window. These rules are checked in code
// before any send reaches a provider, never left to a model. Pure: the API, the connectors and the
// web app share them.

export const MESSAGING_CHANNELS = ["sms", "whatsapp"] as const;
export const MessagingChannel = z.enum(MESSAGING_CHANNELS);
export type MessagingChannel = z.infer<typeof MessagingChannel>;

/** E.164: a plus, a country code that doesn't start with 0, at most 15 digits in all. */
export const E164_RE = /^\+[1-9]\d{6,14}$/;
export const E164 = z
  .string()
  .regex(E164_RE, "a phone number in international form, e.g. +15551234567");

/**
 * A number as people type it (spaces, dashes, dots, brackets, a `whatsapp:` prefix, `00` for `+`)
 * in E.164, or null when it isn't one.
 */
// DECISION: no country is guessed: a number without its country code (+1 …) is refused, so a
// contact is never texted at a number in the wrong country.
export function normalizePhone(raw: string): string | null {
  let v = raw.trim().replace(/^whatsapp:/i, "");
  v = v.replace(/[\s().\- ]/g, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  return E164_RE.test(v) ? v : null;
}

/** A US or Canadian number (+1): texting it needs an approved A2P 10DLC campaign. */
export function isNanpNumber(e164: string): boolean {
  return /^\+1\d{10}$/.test(e164);
}

// ── Consent ──────────────────────────────────────────────────────────────────────────────────────

export const CONSENT_SOURCE_MAX = 200;

/**
 * Why a contact may be reached on a channel (docs/plan.md §1.97): `express`, they agreed to it (a
 * form, a signed paper, a START text); `relationship`, they gave the client this number or address
 * for their business together (on their invoices, an order form, a signed account application).
 */
// DECISION: the owner (2026-11-13): every Mezonas contact is someone the client does business
// with, who gave the client their number, and no message is marketing. So the relationship basis
// covers texts, calls from the automated assistant and email, as a dentist or a supplier texts the
// people who gave it their number. Consent stored before has no `basis` and reads as `express`.
// WhatsApp is left out: Meta's business policy asks for an opt-in before a business starts a
// conversation, so WhatsApp still needs express consent, a START, or the contact writing first
// (inside its 24-hour window). Counsel is to confirm the basis (docs/open.md).
// DECISION: narrowed by the owner on 2026-11-14 (docs/plan.md §1.98): texts need express consent
// too, from the sign-up page, an invitation or START, because US 10DLC review asks to see where
// each person agreed to texts. The relationship basis covers calls and email only.
export const CONSENT_BASES = ["express", "relationship"] as const;
export const ConsentBasis = z.enum(CONSENT_BASES);
export type ConsentBasis = z.infer<typeof ConsentBasis>;

export const ChannelConsent = z.object({
  grantedAt: z.iso.datetime({ offset: true }),
  /**
   * How it was given, kept as evidence: "website form", "signed agreement", "texted START"; for
   * the relationship basis, where the number came from ("number on their invoices").
   */
  source: z.string().trim().min(1).max(CONSENT_SOURCE_MAX),
  /** Absent: `express` (consent recorded before the relationship basis). */
  basis: ConsentBasis.optional(),
});
export type ChannelConsent = z.infer<typeof ChannelConsent>;

export function consentBasisOf(c: Pick<ChannelConsent, "basis">): ConsentBasis {
  return c.basis ?? "express";
}

/**
 * What a contact can agree to: texts, WhatsApp, and calls from an automated assistant (`voice`, to
 * the contact's phone; docs/plan.md §1.23).
 */
// DECISION: calls need their own consent, separate from texts: a call from an automated voice is
// a different thing to agree to (the US treats AI voices as artificial voices), so a contact who
// agreed to texts is not called until they agree to calls too. `email` is email from an agent
// (docs/plan.md §1.25), with its own consent like the rest.
export const CONSENT_CHANNELS = ["sms", "whatsapp", "voice", "email"] as const;
export const ConsentChannel = z.enum(CONSENT_CHANNELS);
export type ConsentChannel = z.infer<typeof ConsentChannel>;

export const ContactConsent = z.object({
  sms: ChannelConsent.optional(),
  whatsapp: ChannelConsent.optional(),
  voice: ChannelConsent.optional(),
  email: ChannelConsent.optional(),
});
export type ContactConsent = z.infer<typeof ContactConsent>;

/** The channels the relationship basis covers: calls and email, never texts or WhatsApp (§1.98). */
export const RELATIONSHIP_CHANNELS = ["voice", "email"] as const satisfies ConsentChannel[];

/** The channels that take express consent only: texts (US 10DLC, §1.98) and WhatsApp (Meta). */
export const EXPRESS_ONLY_CHANNELS = ["sms", "whatsapp"] as const satisfies ConsentChannel[];

/**
 * The channels the relationship basis grants for a contact with these addresses: calls with a
 * phone, email with an address.
 */
export function relationshipChannelsFor(c: {
  phone: string | null | undefined;
  email: string | null | undefined;
}): ConsentChannel[] {
  return RELATIONSHIP_CHANNELS.filter((ch) => (ch === "email" ? !!c.email : !!c.phone));
}

/**
 * Whether the consent recorded lets this channel be used. Texts and WhatsApp take express consent
 * only, so a relationship basis written there by any path (including before §1.98) doesn't open it.
 */
export function hasConsent(consent: ContactConsent, channel: ConsentChannel): boolean {
  const c = consent[channel];
  if (!c) return false;
  if ((EXPRESS_ONLY_CHANNELS as readonly ConsentChannel[]).includes(channel)) {
    return consentBasisOf(c) === "express";
  }
  return true;
}

/** What a send needs to know about its contact. */
export interface ConsentState {
  phone: string | null;
  whatsapp: string | null;
  consent: ContactConsent;
  optedOutAt: string | Date | null;
}

export type SendBlock = "no_number" | "no_consent" | "opted_out" | "quiet_hours" | "a2p_pending";

/** Whether this contact may be sent to on this channel, quiet hours aside. */
export function consentBlock(c: ConsentState, channel: MessagingChannel): SendBlock | null {
  if (c.optedOutAt) return "opted_out";
  const number = channel === "sms" ? c.phone : c.whatsapp;
  if (!number) return "no_number";
  if (!hasConsent(c.consent, channel)) return "no_consent";
  return null;
}

// ── Opt-out and opt-in words ─────────────────────────────────────────────────────────────────────

// DECISION: the words US carriers and Twilio's default handling recognise, matched on the whole
// message (trimmed, any case, trailing punctuation ignored), so "Stop." opts out but "don't stop
// the order" doesn't. An opt-out stops every channel; START lifts it and records consent for the
// channel it came on, since texting START is asking to hear from the client.
export const OPT_OUT_WORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
] as const;
export const OPT_IN_WORDS = ["START", "UNSTOP", "YES"] as const;
export const HELP_WORDS = ["HELP", "INFO"] as const;

export type Keyword = "stop" | "start" | "help";

export function keywordOf(text: string): Keyword | null {
  const w = text
    .trim()
    .replace(/[.!?\s]+$/, "")
    .toUpperCase();
  if ((OPT_OUT_WORDS as readonly string[]).includes(w)) return "stop";
  if ((OPT_IN_WORDS as readonly string[]).includes(w)) return "start";
  if ((HELP_WORDS as readonly string[]).includes(w)) return "help";
  return null;
}

// ── Quiet hours ──────────────────────────────────────────────────────────────────────────────────

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 21:00");

/** No sends from `start` until `end`, in the client's timezone (may wrap past midnight). */
export const QuietHours = z
  .object({ start: HHMM, end: HHMM })
  .refine((q) => q.start !== q.end, { message: "start and end must differ", path: ["end"] });
export type QuietHours = z.infer<typeof QuietHours>;

// DECISION: quiet hours are always on, 21:00 to 08:00 in the client's timezone by default (the US
// TCPA's 8am–9pm window); the operator can move them per client but not switch them off.
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "21:00", end: "08:00" };

/** `HH:MM` of a moment in a timezone (UTC when the zone is unknown). */
export function localTime(at: Date, timezone: string): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
  try {
    return fmt(timezone);
  } catch {
    return fmt("UTC");
  }
}

export function inQuietHours(at: Date, timezone: string, q: QuietHours): boolean {
  const t = localTime(at, timezone);
  return q.start < q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────────────────────────

/** WhatsApp allows free-form messages within 24 hours of the contact's last message. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function inWhatsAppWindow(lastInboundAt: Date | null, now: Date): boolean {
  return lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < WHATSAPP_WINDOW_MS;
}

// ── The first text ───────────────────────────────────────────────────────────────────────────────

/** A text after this long without one to the same contact counts as a first text again. */
export const INTRODUCTION_GAP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether this text is a first one to the contact: none sent before, or none in the last 30 days.
 * Unknown (`undefined`) counts as first.
 */
export function needsIntroduction(lastTextAt: Date | null | undefined, now: Date): boolean {
  return !lastTextAt || now.getTime() - lastTextAt.getTime() >= INTRODUCTION_GAP_MS;
}

// REVIEW: the translations below need a fluent speaker's review (docs/plan.md §1.18). The keyword
// stays STOP in every language: it is the word carriers and Twilio act on.
export const OPT_OUT_LINES: Record<string, string> = {
  en: "Reply STOP to opt out.",
  es: "Responda STOP para no recibir más mensajes.",
  fr: "Répondez STOP pour ne plus recevoir de messages.",
  "pt-BR": "Responda STOP para não receber mais mensagens.",
  it: "Rispondi STOP per non ricevere più messaggi.",
  de: "Antworten Sie STOP, um keine Nachrichten mehr zu erhalten.",
};

/** The opt-out line in the contact's language (English when unknown). */
export function optOutLine(language: string | null | undefined): string {
  if (language && OPT_OUT_LINES[language]) return OPT_OUT_LINES[language] as string;
  const base = language?.slice(0, 2).toLowerCase();
  if (base === "pt") return OPT_OUT_LINES["pt-BR"] as string;
  return (base && OPT_OUT_LINES[base]) || (OPT_OUT_LINES.en as string);
}

/**
 * A first text as it goes out (docs/plan.md §1.97): it names the client (the client's name first,
 * unless the text already says it) and ends with the opt-out line (unless it already offers STOP).
 */
// DECISION: added in code at send time, never left to the agent or its version, and shown on the
// approval card as it will go. STOP counts only in capitals ("stop by on Monday" isn't an offer).
export function withIntroduction(
  text: string,
  input: { client: string; language?: string | null | undefined },
): string {
  let out = text.trim();
  const client = input.client.trim();
  if (client && !out.toLowerCase().includes(client.toLowerCase())) out = `${client}: ${out}`;
  if (!/\bSTOP\b/.test(out)) out = `${out} ${optOutLine(input.language)}`;
  return out;
}

/** Plain words for a blocked send, for errors and the approval card. */
export function sendBlockMessage(block: SendBlock, extra: { until?: string } = {}): string {
  switch (block) {
    case "no_number":
      return "this contact has no number for that channel";
    case "no_consent":
      return "this contact hasn't agreed to messages on that channel";
    case "opted_out":
      return "this contact opted out of messages";
    case "quiet_hours":
      return `it is quiet hours for this client${extra.until ? ` until ${extra.until}` : ""}`;
    case "a2p_pending":
      return "the client's US texting registration (A2P 10DLC) isn't approved yet";
  }
}
