// The intake's routes (docs/plan.md §1.125; docs/cases-plan.md §4.4, §4.5): the back office reads a
// client's intake (and a build's Requirements panel reads its card from it); the client's people
// read and answer theirs on Getting started; the public welcome page opens from the signed link.
// Request and response schemas; stream INTAKE mounts the ops and portal handlers, stream EMAIL
// the welcome page's.
//
// The portal's views never carry an `ours` fact, a fact's id, the operator's notes, prompts or
// cost (invariant 11): only the guide's questions, "We think" in words, and their own answers.

import { z } from "zod";
import { Locale } from "../i18n/locale";
import { isUuid } from "../ids";
import {
  AnswerSource,
  Covers,
  Guide,
  GuideField,
  GuideFieldKey,
  GuideSection,
  GuideSectionKey,
  IntakeAnswerView,
  IntakeArea,
  IntakeEventView,
  IntakePersonView,
  IntakeStatus,
  SectionProgress,
  StartMode,
  WeThink,
} from "../onboarding";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;
const IdParams = z.object({ id: Id });
const TokenParams = z.object({ token: z.string().min(10).max(2000) });

// ── The back office ──────────────────────────────────────────────────────────────────────────────

export const OpsIntakeSummary = z.object({
  id: z.string(),
  client: z.object({ id: z.string(), name: z.string() }),
  fileId: z.string().nullable(),
  dealId: z.string().nullable(),
  status: IntakeStatus,
  covers: Covers,
  startMode: StartMode,
  people: z.number().int(),
  /** Fields answered (or confirmed) of those asked, across sections. */
  answered: z.number().int(),
  total: z.number().int(),
  sendAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OpsIntakeSummary = z.infer<typeof OpsIntakeSummary>;

export const OpsIntakeView = z.object({
  intake: OpsIntakeSummary.extend({
    leadNote: z.string(),
    lead: z.object({ id: z.string(), name: z.string() }).nullable(),
  }),
  guide: Guide,
  people: z.array(IntakePersonView),
  /** The latest answer to each field. */
  answers: z.array(IntakeAnswerView),
  progress: z.array(SectionProgress),
  /** Newest first. */
  events: z.array(IntakeEventView),
});
export type OpsIntakeView = z.infer<typeof OpsIntakeView>;

export const opsIntakeRoutes = {
  opsIntakes: defineRoute({
    method: "GET",
    path: "/api/ops/intakes",
    auth: "session",
    roles: OPS,
    summary: "Intakes at the clients the operator serves, by client, file or status",
    query: z.object({
      client: Id.optional(),
      file: Id.optional(),
      status: IntakeStatus.optional(),
    }),
    response: z.object({ intakes: z.array(OpsIntakeSummary) }),
  }),
  opsIntake: defineRoute({
    method: "GET",
    path: "/api/ops/intakes/:id",
    auth: "session",
    roles: OPS,
    summary: "An intake: its guide, people, answers with their sources, progress per card, its log",
    params: IdParams,
    response: OpsIntakeView,
  }),
} as const;

// ── The portal: Getting started ─────────────────────────────────────────────────────────────────

/** "We think" as the client sees it: the value and the words, never the facts behind it. */
export const PortalWeThink = WeThink.omit({ factIds: true });
export const PortalGuideField = GuideField.omit({ origin: true, weThink: true }).extend({
  weThink: PortalWeThink.nullable(),
});
export type PortalGuideField = z.infer<typeof PortalGuideField>;
export const PortalGuideSection = GuideSection.extend({ fields: z.array(PortalGuideField) });
export type PortalGuideSection = z.infer<typeof PortalGuideSection>;

export const PortalIntakeView = z.object({
  intake: z.object({
    id: z.string(),
    status: IntakeStatus,
    startMode: StartMode,
    /** The lead's note, opening the page. */
    leadNote: z.string(),
    /** The client's Mezonas lead, by name. */
    lead: z.object({ name: z.string(), photoUrl: z.string().nullable() }).nullable(),
    createdAt: z.string(),
  }),
  /** The sections this person was asked (all of them for whoever has them all). */
  sections: z.array(PortalGuideSection),
  answers: z.array(IntakeAnswerView),
  progress: z.array(SectionProgress),
  /** Who else is on it, for "who has it". */
  people: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sections: z.array(GuideSectionKey).nullable(),
      isAdmin: z.boolean(),
    }),
  ),
  you: z.object({
    personId: z.string().nullable(),
    sections: z.array(GuideSectionKey).nullable(),
    isAdmin: z.boolean(),
  }),
});
export type PortalIntakeView = z.infer<typeof PortalIntakeView>;

/** One answer from the cards (or voice typing). Each value is checked against its field's kind. */
export const IntakeAnswerInput = z
  .strictObject({
    fieldKey: GuideFieldKey,
    value: z.unknown().optional(),
    state: z.enum(["answered", "not_sure", "later"]),
  })
  .refine((a) => a.state !== "answered" || a.value !== undefined, "an answer needs its value");
export type IntakeAnswerInput = z.infer<typeof IntakeAnswerInput>;

export const portalIntakeRoutes = {
  portalCurrentIntake: defineRoute({
    method: "GET",
    path: "/api/intake",
    auth: "session",
    roles: CLIENT,
    summary: "Getting started: the client's open intake, the parts this person was asked, or none",
    response: z.object({ intake: PortalIntakeView.nullable() }),
  }),
  portalIntake: defineRoute({
    method: "GET",
    path: "/api/intake/:id",
    auth: "session",
    roles: CLIENT,
    summary: "One of the client's intakes, the parts this person was asked",
    params: IdParams,
    response: PortalIntakeView,
  }),
  portalIntakeAnswer: defineRoute({
    method: "POST",
    path: "/api/intake/:id/answers",
    auth: "session",
    roles: CLIENT,
    summary: "Answer questions on the cards (or mark them not sure, or later)",
    params: IdParams,
    body: z.strictObject({
      answers: z.array(IntakeAnswerInput).min(1).max(60),
      source: AnswerSource.extract(["form", "voice"]).default("form"),
    }),
    response: PortalIntakeView,
  }),
  portalIntakeConfirm: defineRoute({
    method: "POST",
    path: "/api/intake/:id/confirm",
    auth: "session",
    roles: CLIENT,
    summary: 'Confirm or change a card\'s "We think" lines, and say Start with this or Not now',
    params: IdParams,
    body: z.strictObject({
      sectionKey: GuideSectionKey,
      /** A value given is a change (corrected); none is a yes (confirmed). */
      fields: z
        .array(z.strictObject({ fieldKey: GuideFieldKey, value: z.unknown().optional() }))
        .max(60)
        .default([]),
      decision: z.enum(["start", "not_now"]).optional(),
    }),
    response: PortalIntakeView,
  }),
  portalIntakeAsk: defineRoute({
    method: "POST",
    path: "/api/intake/:id/ask",
    auth: "session",
    roles: CLIENT,
    summary:
      "Ask someone else: a card or one question to a colleague (a new address is the client admin's to invite)",
    params: IdParams,
    body: z
      .strictObject({
        sectionKey: GuideSectionKey.optional(),
        fieldKey: GuideFieldKey.optional(),
        /** A member already in the client, or a new name and address. */
        userId: Id.optional(),
        name: z.string().trim().min(1).max(200).optional(),
        email: z.string().trim().toLowerCase().max(320).email().optional(),
        note: z.string().trim().max(500).optional(),
      })
      .refine((b) => Boolean(b.sectionKey) !== Boolean(b.fieldKey), "a card or one question")
      .refine((b) => Boolean(b.userId) !== Boolean(b.email), "a colleague or a new address")
      .refine((b) => !b.email || Boolean(b.name), "a new address needs a name"),
    response: z.object({ person: IntakePersonView, emailed: z.boolean() }),
  }),
  portalIntakeDifferentProcess: defineRoute({
    method: "POST",
    path: "/api/intake/:id/different-process",
    auth: "session",
    roles: CLIENT,
    summary: "Different process in mind? Goes to the lead as an ask, and into what we know",
    params: IdParams,
    body: z.strictObject({
      text: z.string().trim().min(1).max(4000),
      sectionKey: GuideSectionKey.optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
  }),
} as const;

// ── The welcome page (public) ───────────────────────────────────────────────────────────────────

/**
 * The welcome page at `/start/<token>`, seen without sign-in: the client's name, the lead, the
 * note, what's in it and how long, then sign-in with the invited address filled in. Expired or
 * closed links show the lead's name only ("Ask Jammil for a new one"). Nothing from the file beyond
 * names, and no answers.
 */
export const WelcomePageView = z.object({
  state: z.enum(["open", "expired", "closed"]),
  client: z.string(),
  lead: z.object({ name: z.string(), photoUrl: z.string().nullable() }),
  note: z.string().nullable(),
  summary: z
    .object({
      general: z.boolean(),
      areas: z.array(IntakeArea),
      agents: z.number().int(),
      minutes: z.number().int(),
    })
    .nullable(),
  /** The invited address, filled in on the email sign-in; null once expired or closed. */
  email: z.string().nullable(),
  expiresAt: z.string(),
  language: Locale,
});
export type WelcomePageView = z.infer<typeof WelcomePageView>;

/**
 * After sign-in, the welcome page checks the session against the invite: the same address goes on
 * to Getting started (`next`); any other sees only the invited address, masked ("This invite is
 * for d•••@acme.com"). An expired or closed link goes nowhere.
 */
export const WelcomeSignedInView = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), next: z.string() }),
  z.object({ state: z.literal("wrong_account"), invitedEmail: z.string() }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("closed") }),
]);
export type WelcomeSignedInView = z.infer<typeof WelcomeSignedInView>;

// The roles a person signed in with the invited address may hold, and the ones who may not but
// must still be told so (an operator testing the link, someone of another client).
const ANY_ROLE = ["client_admin", "client_user", "operator"] as const;

export const welcomeRoutes = {
  welcomePage: defineRoute({
    method: "GET",
    path: "/api/start/:token",
    auth: "public",
    roles: [],
    summary: "The welcome page an invite's link opens: who it's from, what's in it, then sign-in",
    params: TokenParams,
    response: WelcomePageView,
  }),
  welcomeSignedIn: defineRoute({
    method: "POST",
    path: "/api/start/:token/signed-in",
    auth: "session",
    roles: ANY_ROLE,
    summary:
      "After sign-in: the invited address goes on to Getting started, any other is told whose invite it is",
    params: TokenParams,
    response: WelcomeSignedInView,
  }),
  welcomeAskNew: defineRoute({
    method: "POST",
    path: "/api/start/:token/ask-new",
    auth: "public",
    roles: [],
    summary: "An expired or closed link: ask the lead for a new one (a to-do on Your call)",
    params: TokenParams,
    response: z.object({ ok: z.literal(true) }),
  }),
} as const;
