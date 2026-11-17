// A client's intake (docs/cases-plan.md §4.2, §4.5; docs/plan.md §1.125): the client's own record
// of what we asked and what they said (tenant tables, forced RLS). It holds only `theirs` facts,
// copied into the guide when sent; answers and its log are insert only, the latest answer to a
// field wins. Sloan's conversation about it is a `thread` with `subject_type = 'intake'`.

import { z } from "zod";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import { GuideFieldKey, GuideSectionKey } from "./guide";

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const INTAKE_STATUSES = [
  "sent",
  "open",
  "scope_ready",
  "signed",
  "done",
  "cancelled",
] as const;
export const IntakeStatus = z.enum(INTAKE_STATUSES);
export type IntakeStatus = z.infer<typeof IntakeStatus>;

/** Intakes the client still works on (Getting started shows the newest of these). */
export const OPEN_INTAKE_STATUSES: readonly IntakeStatus[] = ["sent", "open", "scope_ready"];

/**
 * An answer's state: answered, a "We think" line confirmed or corrected, not sure (an open item,
 * never a blocker) or later.
 */
export const ANSWER_STATES = ["answered", "confirmed", "corrected", "not_sure", "later"] as const;
export const AnswerState = z.enum(ANSWER_STATES);
export type AnswerState = z.infer<typeof AnswerState>;

/** Where an answer came from: the cards' form, Sloan's chat, voice, a call, a connected tool, the lead. */
export const ANSWER_SOURCES = ["form", "chat", "voice", "call", "tool", "lead"] as const;
export const AnswerSource = z.enum(ANSWER_SOURCES);
export type AnswerSource = z.infer<typeof AnswerSource>;

/**
 * The intake's log (`intake_event`, insert only). Delivery from the mailer; `opened` when the
 * welcome page is read (no tracking pixels); a section's Start with this / Not now are events.
 */
// DECISION: a section's decision is an event (`section_started`, `section_not_now`, meta
// `{sectionKey}`), not an answer: answers are per field.
export const INTAKE_EVENT_KINDS = [
  "sent",
  "scheduled",
  "delivered",
  "bounced",
  "opened",
  "signed_in",
  "wrong_account",
  "answered",
  "asked",
  "colleague_invited",
  "different_process",
  "section_started",
  "section_not_now",
  "cards_added",
  "reminded",
  "scope_ready",
  "signed",
  "done",
  "cancelled",
] as const;
export const IntakeEventKind = z.enum(INTAKE_EVENT_KINDS);
export type IntakeEventKind = z.infer<typeof IntakeEventKind>;

export const IntakePersonView = z.object({
  id: z.string(),
  /** Their user once invited (set when the account is made, or when they first sign in). */
  userId: z.string().nullable(),
  email: z.string(),
  name: z.string(),
  /** The sections they were asked; null for all of them. */
  sections: z.array(GuideSectionKey).nullable(),
  isAdmin: z.boolean(),
  invitedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type IntakePersonView = z.infer<typeof IntakePersonView>;

export const IntakeAnswerView = z.object({
  fieldKey: GuideFieldKey,
  value: z.unknown(),
  state: AnswerState,
  source: AnswerSource,
  /** Who answered, by name; null for a tool's own reading. */
  by: z.object({ id: z.string(), name: z.string() }).nullable(),
  at: z.string(),
});
export type IntakeAnswerView = z.infer<typeof IntakeAnswerView>;

export const IntakeEventView = z.object({
  id: z.string(),
  kind: IntakeEventKind,
  personId: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
  at: z.string(),
});
export type IntakeEventView = z.infer<typeof IntakeEventView>;

/** A person as Invite and Ask someone else name them. */
export const IntakePersonDraft = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().max(320).email(),
  /** The sections they're asked; omitted or null for all. */
  sections: z.array(GuideSectionKey).max(30).nullable().optional(),
  isAdmin: z.boolean().default(false),
  /** Their language for the email and the welcome page; else the client's. */
  language: Locale.optional(),
});
export type IntakePersonDraft = z.infer<typeof IntakePersonDraft>;
export type IntakePersonDraftInput = z.input<typeof IntakePersonDraft>;

// ── The welcome link (cases-plan §4.4) ──────────────────────────────────────────────────────────

/**
 * What the signed welcome link carries: the client, the intake, the person and the expiry. Signed
 * like the form link (§1.121) under its own label (apps/api/src/onboarding/link.ts). Never a way
 * in on its own: the page leads to sign-in, and the signed-in address must be the invited one.
 */
export const WelcomeLinkToken = z.object({
  /** The client. */
  t: Id,
  /** The intake. */
  i: Id,
  /** The person (`intake_person.id`). */
  p: Id,
  /** Seconds since the epoch. */
  e: z.number().int(),
});
export type WelcomeLinkToken = z.infer<typeof WelcomeLinkToken>;

// DECISION: a welcome link works for 14 days; an expired one offers "Ask <lead> for a new one".
export const WELCOME_LINK_TTL_DAYS = 14;

/** The web app's welcome page for a token: `app.mezonas.com/start/<token>`. */
export function welcomePagePath(token: string): string {
  return `/start/${token}`;
}

// The wrong-account message ("This invite is for d•••@acme.com") masks with `maskEmail`
// (permissions/release.ts).
