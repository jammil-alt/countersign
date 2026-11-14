// Signing up for texts (docs/plan.md §1.98): a page in the client's name where a person enters
// their mobile number, ticks a box and presses "Text me". Two links open it: the client's sign-up
// link, shared with its own people, and a personal link in an invitation email to a vendor or
// customer. What the person agreed to is kept word for word as the consent's evidence, which is
// what US 10DLC review asks to see. The words are fixed here, never written by a model.

import { z } from "zod";
import { EMAIL_COLORS } from "../notify/render";
import { a2pKeywordsOf } from "./a2p";
import { normalizePhone } from "./rules";

export const SMS_TERMS_URL = "https://mezonas.com/sms-terms";
export const PRIVACY_URL = "https://mezonas.com/privacy";
/** The public section that shows carriers how people agree to texts (10DLC opt-in evidence). */
export const SMS_OPT_IN_URL = "https://mezonas.com/sms-terms#opt-in";

/** Bumped whenever the words a person agrees to change; recorded with each sign-up. */
export const TEXT_SIGNUP_WORDING_VERSION = 1;

/** A personal invitation link works this long. */
export const TEXT_INVITE_DAYS = 30;
/** One invitation and at most one reminder per person (§1.98). */
export const TEXT_INVITE_MAX = 2;
/** The reminder can go only this long after the invitation. */
export const TEXT_INVITE_REMINDER_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** At most this many invitations in one request. */
export const TEXT_INVITE_BATCH_MAX = 200;
/** Sign-ups through one client's link in an hour, beyond which the link waits (abuse guard). */
export const TEXT_SIGNUP_LINK_HOURLY_MAX = 20;

/** How the consent's `source` reads for each way in. */
export const TEXT_SIGNUP_SOURCES = {
  link: "signed up on the texting page",
  invitation: "accepted the texting invitation",
} as const;

/**
 * The words beside the box: what the person agrees to, word for word. Every element carriers
 * check is here: who sends, what about, no marketing, frequency, rates, STOP, HELP, terms, privacy.
 */
// DECISION: in English for every person and client: these words go to the carriers as the opt-in,
// and counsel reviews them in English (docs/open.md). The page around them is in the reader's
// language.
export function textSignupTerms(client: string): string {
  const name = client.trim() || "this business";
  return `I agree to get text messages from ${name}, sent through Mezonas, about my work with ${name}: questions, updates, codes and alerts. No marketing. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Terms: ${SMS_TERMS_URL}. Privacy: ${PRIVACY_URL}.`;
}

/**
 * The starting words for "how people agree to texts" in a client's 10DLC registration: the sign-up
 * page (with the client's link when known), the invitation email, START, the exact words beside
 * the box, and the public page that shows it all.
 */
// DECISION: every client's campaign describes the same opt-in, which Mezonas runs and carriers
// can open: the page and the invitation, never a client's own forms (owner, 2026-11-14). In
// English: it goes to Twilio and the carriers.
export function a2pSignupOptIn(business: string, signupUrl?: string | null): string {
  const name = business.trim() || "[Business]";
  const page = signupUrl ? `${name}'s sign-up page (${signupUrl})` : `${name}'s sign-up page`;
  return `${name} texts its own staff and the vendors and customers it works with, about their work together: questions, updates, codes and alerts. No marketing. People choose to get texts on ${page}: staff get the link from ${name}, and vendors and customers get an email invitation from ${name} with a link to the same page. Texting is optional. On the page they enter their mobile number, tick an unticked box beside these words and press "Text me": "${textSignupTerms(name)}" A confirmation text follows. Anyone can also text START to ${name}'s number. How this works, with screenshots: ${SMS_OPT_IN_URL}.`;
}

/** The text that confirms a sign-up, from the client's number: the registered opt-in reply. */
export function textSignupConfirmation(client: string): string {
  return a2pKeywordsOf(client.trim() || "Mezonas").optInMessage;
}

/**
 * A number typed on the page: international form, or a 10-digit US or Canadian number as people
 * write it ("(512) 555-0177").
 */
// DECISION: unlike normalizePhone, the page reads a bare 10-digit number as +1: the person is
// typing their own number on a page for US texting (10DLC), not a business filing someone else's.
export function normalizeSignupPhone(raw: string): string | null {
  const strict = normalizePhone(raw);
  if (strict) return strict;
  const digits = raw.replace(/\D/g, "");
  if (/^[2-9]\d{9}$/.test(digits)) return `+1${digits}`;
  if (/^1[2-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

// ── Links ───────────────────────────────────────────────────────────────────────────────────────

/**
 * What a sign-up link carries, signed by the Worker: the client's link (`l`, with the client's
 * current link key, so a new link retires the old one) or one person's invitation (`i`, which
 * expires).
 */
export const TextSignupToken = z.discriminatedUnion("k", [
  z.object({ k: z.literal("l"), t: z.uuid(), n: z.string().min(8).max(64) }),
  z.object({ k: z.literal("i"), t: z.uuid(), c: z.uuid(), e: z.number().int() }),
]);
export type TextSignupToken = z.infer<typeof TextSignupToken>;

/** The web app's page for a token. */
export function textSignupPath(token: string): string {
  return `/texts/${token}`;
}

// ── The invitation email ────────────────────────────────────────────────────────────────────────

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface TextInvitationInput {
  client: string;
  /** The person's name, as the client has it. */
  name: string;
  signUpUrl: string;
  declineUrl: string;
  /** The second (and last) one. */
  reminder: boolean;
}

/**
 * The invitation: who would like to text them and why, that texting is their choice and email
 * keeps working, the sign-up button, the elements carriers check, and "don't ask me again".
 */
// DECISION: a fixed platform email from Mezonas in the client's name (`<client> via Mezonas`), not
// an agent's message: no model writes it, and no agent reaches a person outside its approvals.
// Texting is offered, never required: carriers and the CTIA refuse consent that looks required.
export function textInvitationEmail(input: TextInvitationInput): {
  subject: string;
  text: string;
  html: string;
} {
  const client = input.client.trim() || "A business you work with";
  const first = input.name.trim().split(/\s+/)[0] || "there";
  const subject = input.reminder
    ? `Reminder: ${client} would like to text you`
    : `${client} would like to text you`;
  const lines = [
    `Hi ${first},`,
    `${client} would like to send you text messages about your work together: quick questions, order and delivery updates, and invoices. It uses Mezonas to send them.`,
    "Texting is your choice. Email keeps working either way.",
  ];
  const small = [
    `If you sign up, texts come from ${client}'s number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out at any time, HELP for help. No marketing.`,
    `Text message terms: ${SMS_TERMS_URL}. Privacy: ${PRIVACY_URL}.`,
  ];
  const action = "Choose to get texts";
  const decline = "Don't ask me again";
  const text = [
    ...lines.flatMap((l) => [l, ""]),
    `${action}: ${input.signUpUrl}`,
    "",
    ...small.flatMap((l) => [l, ""]),
    `${decline}: ${input.declineUrl}`,
  ].join("\n");
  const c = EMAIL_COLORS;
  const p = (s: string, color: string = c.ink, size = 15) =>
    `<p style="margin:0 0 12px;color:${color};font:${size}px/1.5 Helvetica,Arial,sans-serif">${escapeHtml(s)}</p>`;
  const html = [
    `<div style="background:${c.paper};padding:24px">`,
    `<div style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid ${c.line};border-radius:8px;padding:24px">`,
    ...lines.map((l) => p(l)),
    `<p style="margin:16px 0 20px"><a href="${escapeHtml(input.signUpUrl)}" style="display:inline-block;background:${c.slate};color:${c.paper};text-decoration:none;padding:10px 16px;border-radius:6px;font:600 14px Helvetica,Arial,sans-serif">${escapeHtml(action)}</a></p>`,
    ...small.map((l) => p(l, c.muted, 13)),
    `<p style="margin:0;font:13px/1.5 Helvetica,Arial,sans-serif"><a href="${escapeHtml(input.declineUrl)}" style="color:${c.muted}">${escapeHtml(decline)}</a></p>`,
    "</div></div>",
  ].join("");
  return { subject, text, html };
}
