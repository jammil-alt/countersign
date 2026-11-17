// Sloan by email and text (docs/plan.md §1.150): a client's people reach their account agent at its
// own address on the forwarding domain and at the account's number, and Sloan answers the way the
// message came. What arrives is a message in the person's own conversation with Sloan (an account
// thread), so Sloan's chat runs as it does for the portal and the portal shows both sides.

import type { Locale } from "../i18n/locale";
import { agentAddress, parseAgentAddress } from "../triggers/address";

/** The address name of the account agent: `sloan.<client label>-<client id>@<domain>`. */
// DECISION: the name is fixed, not the agent's command name: the account agent is the client's
// Sloan whatever its fork is called, and an area owner or agent renamed "Sloan" never takes it.
export const SLOAN_ADDRESS_NAME = "sloan";

/** How a person's message reached Sloan, kept in the message's body as `via`. */
export const SLOAN_CHANNELS = ["email", "sms"] as const;
export type SloanChannel = (typeof SLOAN_CHANNELS)[number];

/**
 * The fixed title of a person's conversation with Sloan for one channel: one per person and
 * channel, found again by it, so a reply by email continues where the last email left off.
 */
// DECISION: one conversation per person and channel, not one per email subject: texts have no
// subject, and a reply that lost its headers still lands in the same place.
export const SLOAN_CHANNEL_THREAD_TITLES: Record<SloanChannel, string> = {
  email: "By email",
  sms: "By text",
};

/** Sloan's address for a client, on the forwarding domain. */
export function sloanAddress(input: { clientName: string; tenantId: string; domain: string }) {
  return agentAddress({ commandName: SLOAN_ADDRESS_NAME, ...input });
}

/** True when `to` is shaped as a Sloan address on `domain` (the caller still checks it exactly). */
export function isSloanAddress(to: string, domain: string): boolean {
  return parseAgentAddress(to, domain)?.commandName === SLOAN_ADDRESS_NAME;
}

/** The longest text Sloan sends back: four SMS segments' worth, so a long answer costs little. */
export const SLOAN_TEXT_MAX = 600;

const MORE: Record<Locale, string> = {
  en: "The rest is in Mezonas:",
  es: "El resto está en Mezonas:",
  fr: "La suite est dans Mezonas :",
  "pt-BR": "O restante está no Mezonas:",
  it: "Il resto è in Mezonas:",
  de: "Der Rest steht in Mezonas:",
};

/**
 * Sloan's answer as a text: whole when it fits, else cut at a word with a link to the conversation.
 * Line breaks are kept; the cut never splits a word.
 */
// DECISION: the cut is made in code at send time, not asked of the model: Sloan's skill is the same
// for every channel, and the whole answer is always in the portal.
export function sloanTextBody(text: string, link: string, locale: Locale): string {
  const clean = text.trim();
  if (clean.length <= SLOAN_TEXT_MAX) return clean;
  const tail = `… ${MORE[locale]} ${link}`;
  const room = Math.max(0, SLOAN_TEXT_MAX - tail.length);
  let cut = clean.slice(0, room);
  const space = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  if (space > room / 2) cut = cut.slice(0, space);
  return `${cut.trimEnd()}${tail}`;
}

/** The subject of Sloan's email answer: `Re:` the person's subject, else a plain default. */
export function sloanReplySubject(subject: string | null | undefined): string {
  const s = (subject ?? "")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  if (!s) return "Your message to Sloan";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}
