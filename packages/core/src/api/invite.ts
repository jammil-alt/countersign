// Invite and Sign up now (docs/plan.md §1.126; docs/cases-plan.md §4.2, §4.3): from a lead record,
// make the client (or use the one there is), invite its people, add the agents chosen on the bench
// with a build each at Requirements request, open the intake and move the deal, in one
// transaction, then email the people. Both are always a person's confirm (cases-plan §6): the
// preview shows the confirmation's words and nothing changes until the send. Operator only.
// Request and response schemas; stream SALES mounts the handlers (`runInvite`).

import { z } from "zod";
import { isUuid } from "../ids";
import { DecimalString } from "../money";
import {
  Covers,
  Guide,
  GuideEdits,
  GuideTotals,
  IntakePersonDraft,
  LEAD_NOTE_MAX,
  StartMode,
} from "../onboarding";
import { defineRoute } from "./contract";
import { WelcomePageView } from "./intake";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const Currency = z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code");
/** A month's price: a non-negative decimal string (invariant 6). */
const Mrr = DecimalString.refine((v) => !v.startsWith("-"), "not below zero");
const Website = z.string().trim().min(1).max(300);

/** At most this many people on one invite. */
export const INVITE_PEOPLE_MAX = 10;

/**
 * Who the invite is for: a client file (a prospect), an existing client (skips making the account:
 * more people, or an intake for an expansion or a new area), or a new company (a file is made).
 * A deal named here moves; else the company's open deal, else a new one.
 */
const Target = {
  fileId: Id.optional(),
  clientId: Id.optional(),
  company: z.string().trim().min(1).max(200).optional(),
  website: Website.optional(),
  dealId: Id.optional(),
};

function oneTarget(v: {
  fileId?: string | undefined;
  clientId?: string | undefined;
  company?: string | undefined;
}): boolean {
  return Boolean(v.fileId || v.clientId || v.company);
}

/** Invite's whole flow, as the side panel sends it (steps 1–4). */
export const InviteDraft = z
  .strictObject({
    ...Target,
    /** The account's name when one is made; else the file's or the company's. */
    clientName: z.string().trim().min(1).max(200).optional(),
    timezone: z.string().trim().max(64).optional(),
    people: z.array(IntakePersonDraft).min(1).max(INVITE_PEOPLE_MAX),
    covers: Covers,
    /** The start it began from, if any (Sign up now's "Review first", or picked at step 2). */
    startId: Id.optional(),
    edits: GuideEdits.optional(),
    startMode: StartMode.default("point"),
    /** The lead's note, as edited. */
    note: z.string().trim().max(LEAD_NOTE_MAX).default(""),
    /** Send at a time; omitted: now. */
    sendAt: z.iso.datetime({ offset: true }).optional(),
    /** The agreed price a month, if known (recorded on the deal as terms). */
    agreedMrr: Mrr.optional(),
    currency: Currency.optional(),
  })
  .refine(oneTarget, "name a client file, a client or a company")
  .refine(
    (v) => new Set(v.people.map((p) => p.email)).size === v.people.length,
    "a person is named twice",
  )
  .refine((v) => v.people.filter((p) => p.isAdmin).length <= 1, "only one person is the admin")
  .refine(
    (v) => Boolean(v.clientId) || v.people.filter((p) => p.isAdmin).length === 1,
    "a new account needs one admin",
  );
export type InviteDraft = z.infer<typeof InviteDraft>;
export type InviteDraftInput = z.input<typeof InviteDraft>;

/** Sign up now's one small form: company, person, a start, optionally the agreed price. */
export const SignUpNowDraft = z
  .strictObject({
    ...Target,
    person: z.strictObject({
      name: z.string().trim().min(1).max(200),
      email: z.string().trim().toLowerCase().max(320).email(),
      language: IntakePersonDraft.shape.language,
    }),
    /** Every sign-up names a start; "Just the account" is a start that covers nothing. */
    startId: Id,
    agreedMrr: Mrr.optional(),
    currency: Currency.optional(),
  })
  .refine(oneTarget, "name a client file, a client or a company");
export type SignUpNowDraft = z.infer<typeof SignUpNowDraft>;
export type SignUpNowDraftInput = z.input<typeof SignUpNowDraft>;

/** An email as it will be sent, for the preview. */
export const OnboardingEmailPreview = z.object({
  to: z.string(),
  kind: z.enum(["invite", "colleague", "more_questions"]),
  /** `<Lead> at Mezonas <hello@…>`. */
  from: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  text: z.string(),
  html: z.string(),
  sendAt: z.string().nullable(),
});
export type OnboardingEmailPreview = z.infer<typeof OnboardingEmailPreview>;

/** Why someone can't be invited (§1.14's refusals): an operator's address, a person in another client. */
export const InviteProblem = z.object({
  email: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});
export type InviteProblem = z.infer<typeof InviteProblem>;

/** What Invite or Sign up now will do, before anything changes. */
export const InvitePreview = z.object({
  /**
   * The confirmation, one line each: "Makes Acme a client in Mezonas, with you serving it.",
   * "Invites Dana Ruiz as its admin…", "Adds … and opens its build.", "Opens the intake (…).",
   * "Moves the deal to Set up the account.", "Emails Dana and Mark."
   */
  confirm: z.array(z.string()),
  account: z.object({ clientId: z.string().nullable(), name: z.string() }),
  /** Null: "Just the account", no intake. */
  intake: z
    .object({ covers: Covers, startMode: StartMode, guide: Guide, totals: GuideTotals })
    .nullable(),
  emails: z.array(OnboardingEmailPreview),
  /** The welcome page as the first person will see it. */
  welcome: WelcomePageView,
  /** What a later stage wants and wasn't given: to-dos on Your call ("Record Acme's agreed price"). */
  todos: z.array(z.object({ title: z.string(), dueOn: z.string() })),
  /** Refusals: the send answers 422 while any is left. */
  problems: z.array(InviteProblem),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

/** What the send did. */
export const InviteSent = z.object({
  clientId: z.string(),
  fileId: z.string(),
  /** Null: only people invited to an existing client, no deal moved. */
  dealId: z.string().nullable(),
  /** Null: "Just the account". */
  intakeId: z.string().nullable(),
  agentIds: z.array(z.string()),
  buildIds: z.array(z.string()),
  people: z.array(
    z.object({
      personId: z.string().nullable(),
      userId: z.string(),
      email: z.string(),
      isAdmin: z.boolean(),
    }),
  ),
  emails: z.array(z.object({ to: z.string(), status: z.enum(["queued", "scheduled", "skipped"]) })),
  todoIds: z.array(z.string()),
});
export type InviteSent = z.infer<typeof InviteSent>;

export const inviteRoutes = {
  opsInvitePreview: defineRoute({
    method: "POST",
    path: "/api/ops/onboarding/invite/preview",
    auth: "session",
    roles: OPS,
    summary:
      "Invite, before sending: the confirmation's words, the guide and its totals, the emails and the welcome page as they'll be seen",
    body: InviteDraft,
    response: InvitePreview,
  }),
  opsInviteSend: defineRoute({
    method: "POST",
    path: "/api/ops/onboarding/invite",
    auth: "session",
    roles: OPS,
    summary:
      "Send an invite: make the client (or use it), invite its people, add the agents with their builds, open the intake, move the deal; then the emails",
    body: InviteDraft,
    response: InviteSent,
  }),
  opsSignUpPreview: defineRoute({
    method: "POST",
    path: "/api/ops/onboarding/sign-up/preview",
    auth: "session",
    roles: OPS,
    summary: "Sign up now, before sending: the same confirmation as Invite's, from a saved start",
    body: SignUpNowDraft,
    response: InvitePreview,
  }),
  opsSignUp: defineRoute({
    method: "POST",
    path: "/api/ops/onboarding/sign-up",
    auth: "session",
    roles: OPS,
    summary:
      "Sign up now: Invite with a saved start's defaults, the deal at Set up the account with the stages before it skipped",
    body: SignUpNowDraft,
    response: InviteSent,
  }),
} as const;
