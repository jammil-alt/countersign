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

export const ChannelConsent = z.object({
  grantedAt: z.iso.datetime({ offset: true }),
  /** How it was given: "website form", "signed agreement", "texted START". */
  source: z.string().trim().min(1).max(CONSENT_SOURCE_MAX),
});
export type ChannelConsent = z.infer<typeof ChannelConsent>;

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
  if (!c.consent[channel]) return "no_consent";
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
