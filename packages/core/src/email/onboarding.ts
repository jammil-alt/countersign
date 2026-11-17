// The onboarding emails (docs/cases-plan.md §4.4; docs/plan.md §1.125), each in the branded layout
// (`./layout`) in the person's language: the invite, a colleague asked, a few more questions. The
// reminder, "Your scope is ready" and "What happens next" are next wave's. Nothing from the client
// file beyond names, and no answers: the inputs below are all an email may carry.
//
// Stream EMAIL builds these (cases-plan O1); until then each throws.

import type { Locale } from "../i18n/locale";
import type { IntakeArea } from "../onboarding/starts";
import type { RenderedEmail } from "./layout";

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

const notBuilt = (what: string): never => {
  throw new Error(`${what} is not built yet (stream EMAIL, docs/plan.md §1.125)`);
};

/** The invite (Invite or Sign up now), from the lead. */
// Stream EMAIL builds this (cases-plan O1).
export function renderInviteEmail(_input: InviteEmailInput): RenderedEmail {
  return notBuilt("renderInviteEmail");
}

/** A colleague asked (extra people, or "Ask someone else"), from the lead, naming who asked. */
// Stream EMAIL builds this (cases-plan O1).
export function renderColleagueEmail(_input: ColleagueEmailInput): RenderedEmail {
  return notBuilt("renderColleagueEmail");
}

/** A few more questions (cards added to an open intake), from the lead. */
// Stream EMAIL builds this (cases-plan O1).
export function renderMoreQuestionsEmail(_input: MoreQuestionsEmailInput): RenderedEmail {
  return notBuilt("renderMoreQuestionsEmail");
}
