// The onboarding emails (docs/cases-plan.md §4.4; docs/plan.md §1.125), each in the branded layout
// (`./layout`) in the person's language: the invite, a colleague asked, a few more questions. The
// reminder, "Your scope is ready" and "What happens next" are next wave's. Nothing from the client
// file beyond names, and no answers: the inputs below are all an email may carry.
//
// Each email has one button, who it's from, a line on Mezonas, "We'll never ask for a password by
// email" and when the link stops working. No tracking pixel: the welcome page tells us it was
// opened.

import type { Locale } from "../i18n/locale";
import { ONBOARDING_WORDS } from "../i18n/onboarding";
import { AREA_OWNER_WORDS } from "../i18n/owners";
import type { IntakeArea } from "../onboarding/starts";
import { type BrandedBlock, type RenderedEmail, renderBrandedEmail } from "./layout";

/** What's in an intake, in one line: "Two agents and a few questions about …; about 15 minutes". */
export interface IntakeSummary {
  general: boolean;
  areas: readonly IntakeArea[];
  agents: number;
  /** About how long it takes, from the guide's totals. */
  minutes: number;
}

export interface OnboardingEmailBase {
  locale: Locale;
  /** The client's name, as the account has it. */
  client: string;
  /** The person it goes to (their first name is used in the greeting). */
  to: { name: string; email: string };
  /** The lead it's from: name and photo (an https URL or null). */
  lead: { name: string; photoUrl: string | null };
  /** The welcome page's full URL (`APP_ORIGIN` + `welcomePagePath(token)`). */
  link: string;
  /** When the link stops working. */
  expiresAt: Date;
  /** The app's origin, for the hosted logo. */
  origin: string;
}

export interface InviteEmailInput extends OnboardingEmailBase {
  /** The lead's note, as edited and sent. */
  note: string;
  summary: IntakeSummary;
}

export interface ColleagueEmailInput extends OnboardingEmailBase {
  /** Who asked: the client's own person. */
  askedBy: { name: string };
  /** What they're asked: section titles, or one question's label. */
  about: readonly string[];
}

export interface MoreQuestionsEmailInput extends OnboardingEmailBase {
  note: string;
  /** What was added: the cards' titles. */
  added: readonly string[];
  summary: IntakeSummary;
}

/** The first word of a name, for the greeting. */
export function firstNameOf(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first || name.trim();
}

/**
 * What's in an intake in one line, in the reader's language: "A few questions about how Acme
 * works and purchasing, and what we need to set up one agent; about 15 minutes". The email and the
 * welcome page both read it from here.
 */
export function intakeSummaryLine(locale: Locale, client: string, summary: IntakeSummary): string {
  return ONBOARDING_WORDS[locale].summary({
    client,
    general: summary.general,
    areas: summary.areas.map((a) => AREA_OWNER_WORDS[locale].functionOf[a]),
    agents: Math.max(0, Math.floor(summary.agents)),
    minutes: Math.max(0, Math.round(summary.minutes)),
  });
}

/** A date as the reader writes it ("December 1, 2026"), in UTC. */
export function emailDate(locale: Locale, at: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(at);
}

// DECISION: at most ten titles are named in one email; the page shows the rest.
const list = (locale: Locale, items: readonly string[]) =>
  new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    items
      .map((i) => i.trim())
      .filter(Boolean)
      .slice(0, 10),
  );

function render(
  input: OnboardingEmailBase,
  subject: string,
  preheader: string,
  body: readonly BrandedBlock[],
  sentBy: string,
): RenderedEmail {
  const w = ONBOARDING_WORDS[input.locale];
  return renderBrandedEmail({
    locale: input.locale,
    subject,
    preheader,
    from: { name: input.lead.name, photoUrl: input.lead.photoUrl, role: w.leadRole },
    origin: input.origin,
    blocks: [
      { kind: "paragraph", text: w.greeting(firstNameOf(input.to.name)) },
      ...body,
      { kind: "small", text: `${sentBy} ${w.aboutMezonas}` },
      {
        kind: "small",
        text: `${w.neverPassword} ${w.expires(emailDate(input.locale, input.expiresAt))}`,
      },
    ],
  });
}

const noteBlock = (note: string, from: string): BrandedBlock[] =>
  note.trim() ? [{ kind: "note", text: note.trim(), from }] : [];

/** The invite (Invite or Sign up now), from the lead. */
export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const w = ONBOARDING_WORDS[input.locale];
  const line = intakeSummaryLine(input.locale, input.client, input.summary);
  return render(
    input,
    w.inviteSubject(input.client),
    line,
    [
      { kind: "paragraph", text: w.inviteIntro(input.client) },
      ...noteBlock(input.note, input.lead.name),
      { kind: "paragraph", text: w.whatsIn(line) },
      { kind: "button", label: w.getStarted, href: input.link },
    ],
    w.sentBy(input.lead.name),
  );
}

/** A colleague asked (extra people, or "Ask someone else"), from the lead, naming who asked. */
export function renderColleagueEmail(input: ColleagueEmailInput): RenderedEmail {
  const w = ONBOARDING_WORDS[input.locale];
  const intro = w.colleagueIntro(input.askedBy.name, input.client, list(input.locale, input.about));
  return render(
    input,
    w.colleagueSubject(input.askedBy.name, input.client),
    intro,
    [
      { kind: "paragraph", text: intro },
      { kind: "button", label: w.getStarted, href: input.link },
    ],
    w.sentByFor(input.lead.name, input.askedBy.name),
  );
}

/** A few more questions (cards added to an open intake), from the lead. */
export function renderMoreQuestionsEmail(input: MoreQuestionsEmailInput): RenderedEmail {
  const w = ONBOARDING_WORDS[input.locale];
  const line = intakeSummaryLine(input.locale, input.client, input.summary);
  return render(
    input,
    w.moreQuestionsSubject(input.client),
    line,
    [
      {
        kind: "paragraph",
        text: w.moreQuestionsIntro(input.client, list(input.locale, input.added)),
      },
      ...noteBlock(input.note, input.lead.name),
      { kind: "paragraph", text: w.whatsIn(line) },
      { kind: "button", label: w.answerThem, href: input.link },
    ],
    w.sentBy(input.lead.name),
  );
}
