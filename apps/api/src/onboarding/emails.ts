// The onboarding emails (docs/cases-plan.md §4.4; docs/plan.md §1.149): the invite, a colleague
// asked, a few more questions. Each is written to the notifications outbox (§1.37) in the caller's
// transaction as its own kind (`intake_invite`, `intake_colleague`, `intake_more_questions`;
// migration 0066), once per person and email (the dedupe key), and sent after the commit by the
// notification pass: rendered then in the person's language from the intake and its person (core
// `renderInviteEmail`…), from `<Lead> at Mezonas <hello@…>` with Reply-To the lead's own address,
// through the mailer with the row's id as the idempotency key; `skipped` without Resend, as today.
// What became of each is logged on the intake (`intake_event`). No open-tracking pixels.
//
// Nothing from the client file goes in beyond names: the intake's own row (the lead's note, what
// it covers, the guide's minutes) and the person's name and address.

import {
  clientLanguage,
  complianceOf,
  dedupeKeys,
  Guide,
  IntakeArea,
  type IntakeSummary,
  intakePersonOfKey,
  isOnboardingNotificationKind,
  type Locale,
  notificationLink,
  ONBOARDING_EMAIL_FEATURE,
  type OnboardingNotificationKind,
  type Processor,
  parseCoveredProcessors,
  parseLocale,
  processingRefusal,
  type RenderedEmail,
  readTenantGuide,
  renderColleagueEmail,
  renderInviteEmail,
  renderMoreQuestionsEmail,
  renderSetupNudgeEmail,
  userLanguage,
} from "@countersign/core";
import {
  appUser,
  type Db,
  intake,
  intakeEvent,
  intakePerson,
  membership,
  notification,
  type Tx,
  tenant as tenantTable,
  withOperator,
} from "@countersign/db";
import { leadDisplayName, leadOf } from "@countersign/threads";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { HELLO_LOCAL_PART, type MailMessage, mailerFromEnv } from "../notify/mailer";
import { originOf } from "../notify/outbox";
import { addTodo } from "../work/todos-store";
import {
  type WelcomeLinkEnv,
  welcomeLinkExpiry,
  welcomeLinksAvailable,
  welcomeLinkUrl,
} from "./link";

/**
 * §1.220: the Resend tags an onboarding email carries, so Resend's webhook finds the client and the
 * outbox row a delivered or bounced event is about (`../routes/resend-hooks.ts`). Ids only: nothing
 * of the client's goes in a tag.
 */
export const ONBOARDING_TAG_TENANT = "mz_tenant";
export const ONBOARDING_TAG_NOTIFICATION = "mz_notification";

export type OnboardingEmailKind = "invite" | "colleague" | "more_questions";

/** The notification kind each email is written as (packages/db ONBOARDING_NOTIFICATION_KINDS). */
export const ONBOARDING_EMAIL_NOTIFICATION = {
  invite: "intake_invite",
  colleague: "intake_colleague",
  more_questions: "intake_more_questions",
} as const satisfies Record<OnboardingEmailKind, OnboardingNotificationKind>;

interface OnboardingEmailBase {
  /** The client. */
  tenantId: string;
  intakeId: string;
  /** Who it goes to (`intake_person.id`). */
  personId: string;
}

export type OnboardingEmail =
  | (OnboardingEmailBase & {
      kind: "invite";
      /** Invite's "Send at": written `scheduled`, sent by the pass from then (`intake.send_at`). */
      sendAt?: Date | null;
    })
  | (OnboardingEmailBase & {
      kind: "colleague";
      /** The client's own person who asked. */
      askedByUserId: string;
      /** Section titles, or one question's label. */
      about: readonly string[];
    })
  | (OnboardingEmailBase & {
      kind: "more_questions";
      /** The cards added: their titles. */
      added: readonly string[];
      /** The lead's note with them, if any. */
      note?: string;
    });

export interface OnboardingEmailDeps {
  /** The caller's transaction, scoped to the email's client. */
  tx: Tx;
  env: Bindings;
  /** The time it is queued (tests); now by default. */
  now?: Date;
}

export interface OnboardingEmailQueued {
  /** The outbox row; null when nothing was written (already queued for this person). */
  notificationId: string | null;
  status: "queued" | "scheduled" | "skipped";
}

type IntakeRow = typeof intake.$inferSelect;
type PersonRow = typeof intakePerson.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;

// DECISION: a title or a note an email carries is kept short: at most 30 titles of 200 characters
// and a note of 2,000 (the lead's note's own limit).
const titles = (items: readonly string[]) =>
  items
    .map((i) => i.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 30);

/**
 * Why a client's onboarding emails can't go to Resend (HIPAA mode without `resend` covered,
 * invariant 14), or null.
 */
export function onboardingEmailRefusal(
  settings: Record<string, unknown> | null | undefined,
  covered: ReadonlySet<Processor>,
): string | null {
  return processingRefusal(
    complianceOf(settings ?? {}),
    covered,
    ONBOARDING_EMAIL_FEATURE.processors,
    ONBOARDING_EMAIL_FEATURE.what,
  );
}

/**
 * Whether the branded email can go from here at all: Resend configured, welcome links signable,
 * and the client not refused it. When it can't, the sign-in provider's own invitation goes
 * instead, so nobody invited is left without an email.
 */
// DECISION (review): the provider's invitation is turned off only when ours will go; a send that
// later fails or bounces leaves the lead a to-do (`leaveUnsentTodo`), since resending is the next
// wave's (reminders).
export function brandedEmailCanGo(
  env: Bindings,
  settings: Record<string, unknown> | null | undefined,
): boolean {
  return (
    mailerFromEnv(env).isConfigured &&
    welcomeLinksAvailable(env) &&
    onboardingEmailRefusal(settings, parseCoveredProcessors(env.BAA_PROCESSORS)) === null
  );
}

/**
 * Queues one onboarding email in the caller's transaction; the notification pass sends it (call
 * `sendNow` after the commit to send it at once). Writes the intake's own record of it: a
 * colleague asked is `colleague_invited` and cards added are `cards_added` (callers don't write
 * those themselves), an invite sent later is `scheduled`, and an email that can't go (no Resend
 * here) is `sent` with `status: skipped`. The invite and a colleague's email go once per person; a
 * few more questions once per set of cards.
 */
export async function sendOnboardingEmail(
  deps: OnboardingEmailDeps,
  email: OnboardingEmail,
): Promise<OnboardingEmailQueued> {
  const { tx, env } = deps;
  const now = deps.now ?? new Date();
  const [person] = await tx
    .select()
    .from(intakePerson)
    .where(
      and(
        eq(intakePerson.id, email.personId),
        eq(intakePerson.tenantId, email.tenantId),
        eq(intakePerson.intakeId, email.intakeId),
      ),
    );
  if (!person) throw new HttpError(404, "not_found", "that person is not on this intake");
  const [row] = await tx
    .select()
    .from(intake)
    .where(and(eq(intake.id, email.intakeId), eq(intake.tenantId, email.tenantId)));
  if (!row) throw new HttpError(404, "not_found", "intake not found");

  const kind = ONBOARDING_EMAIL_NOTIFICATION[email.kind];
  const event = async (
    eventKind: (typeof intakeEvent.$inferInsert)["kind"],
    meta: Record<string, unknown>,
  ) => {
    const [made] = await tx
      .insert(intakeEvent)
      .values({
        tenantId: email.tenantId,
        intakeId: row.id,
        kind: eventKind,
        personId: person.id,
        meta,
      })
      .returning({ id: intakeEvent.id });
    return made?.id ?? null;
  };

  // What the email is about, kept on the intake: the pass renders it from there.
  let ref: string | undefined;
  if (email.kind === "colleague") {
    // Keyed per ask, so a second ask of the same colleague emails them again.
    ref =
      (await event("colleague_invited", {
        askedByUserId: email.askedByUserId,
        about: titles(email.about),
      })) ?? undefined;
  } else if (email.kind === "more_questions") {
    ref =
      (await event("cards_added", {
        added: titles(email.added),
        ...(email.note?.trim() ? { note: email.note.trim().slice(0, 2000) } : {}),
      })) ?? undefined;
  } else if (email.sendAt !== undefined && email.sendAt?.getTime() !== row.sendAt?.getTime()) {
    await tx
      .update(intake)
      .set({ sendAt: email.sendAt })
      .where(and(eq(intake.id, row.id), eq(intake.tenantId, row.tenantId)));
  }

  const sendAt = email.kind === "invite" ? (email.sendAt ?? row.sendAt) : null;
  const scheduled = !!sendAt && sendAt.getTime() > now.getTime();
  const configured = mailerFromEnv(env).isConfigured;
  const [made] = await tx
    .insert(notification)
    .values({
      tenantId: email.tenantId,
      userId: person.userId,
      contactId: null,
      channel: "email",
      kind,
      dedupeKey: dedupeKeys.intake(kind, person.id, ref),
      // The welcome link is signed when the email is sent; the row keeps where it leads.
      link: notificationLink(originOf(env), "/start"),
      counts: {},
      status: configured ? "queued" : "skipped",
      reason: configured ? (scheduled ? "scheduled" : null) : "not_configured",
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [notification.tenantId, notification.channel, notification.dedupeKey],
    })
    .returning({ id: notification.id });
  // Already queued for this person (the invite goes once): nothing new goes.
  if (!made) return { notificationId: null, status: "skipped" };
  if (!configured) {
    await event("sent", {
      email: email.kind,
      notificationId: made.id,
      status: "skipped",
      reason: "not_configured",
    });
    return { notificationId: made.id, status: "skipped" };
  }
  if (scheduled) {
    await event("scheduled", {
      email: email.kind,
      notificationId: made.id,
      at: (sendAt as Date).toISOString(),
    });
    return { notificationId: made.id, status: "scheduled" };
  }
  return { notificationId: made.id, status: "queued" };
}

// ── At send (the notification pass) ────────────────────────────────────────────────────────────

/** What an intake covers, as the email's and the welcome page's one line read it. */
export function intakeSummaryOf(row: Pick<IntakeRow, "covers" | "guide">): IntakeSummary {
  const covers = row.covers ?? { general: false, areas: [], templateIds: [] };
  const guide = Guide.safeParse(row.guide);
  return {
    general: covers.general === true,
    areas: (covers.areas ?? []).filter((a): a is IntakeArea => IntakeArea.safeParse(a).success),
    agents: (covers.templateIds ?? []).length,
    minutes: guide.success ? guide.data.totals.minutes : 0,
  };
}

/** The person's language: their own on the intake, else their account's, else the client's. */
export function personLocale(
  person: Pick<PersonRow, "language" | "userId">,
  settings: Record<string, unknown>,
): Locale {
  return (
    parseLocale(person.language) ??
    (person.userId ? userLanguage(settings, person.userId) : null) ??
    clientLanguage(settings) ??
    "en"
  );
}

/** The lead an intake is from: their name and address, or Mezonas when it names none. */
export async function intakeLead(
  tx: Tx,
  row: Pick<IntakeRow, "leadUserId">,
): Promise<{ name: string; email: string | null }> {
  if (!row.leadUserId) return { name: "Mezonas", email: null };
  const [u] = await tx
    .select({ name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, row.leadUserId));
  return u ? { name: leadDisplayName(u), email: u.email } : { name: "Mezonas", email: null };
}

export type PreparedOnboardingEmail =
  /** Settled `skipped` with this reason. */
  | { kind: "skip"; reason: string; intakeId: string | null; personId: string | null }
  /** Left queued (an invite sent later): the reason the row keeps. */
  | { kind: "hold"; reason: string }
  | {
      kind: "send";
      message: Omit<MailMessage, "idempotencyKey">;
      /** Null for the setup nudge, which goes to a member, not an intake's person (§1.206). */
      intakeId: string | null;
      personId: string | null;
    };

export interface OnboardingSendDeps {
  mailerConfigured: boolean;
  origin: string;
  links: WelcomeLinkEnv;
  /** `BAA_PROCESSORS`: a client in HIPAA mode gets these emails only once Resend is here. */
  covered: ReadonlySet<Processor>;
}

/**
 * One queued onboarding row, ready to send (or why not), read inside the client's transaction.
 * The welcome link expires 14 days after the email was due (its row's time, or the invite's "Send
 * at"), so a retried send renders the same email under the same idempotency key.
 */
export async function prepareOnboardingEmail(
  tx: Tx,
  t: typeof tenantTable.$inferSelect,
  row: NotificationRow,
  deps: OnboardingSendDeps,
  now: Date,
): Promise<PreparedOnboardingEmail> {
  const skip = (reason: string, intakeId: string | null = null, personId: string | null = null) =>
    ({ kind: "skip", reason, intakeId, personId }) as const;
  if (!isOnboardingNotificationKind(row.kind)) return skip("not_onboarding");
  if (row.kind === "intake_reminder") return prepareSetupNudge(tx, t, row, deps);
  if (
    row.kind !== "intake_invite" &&
    row.kind !== "intake_colleague" &&
    row.kind !== "intake_more_questions"
  ) {
    // "Your scope is ready" and "What happens next" are next wave's.
    return skip("unsupported");
  }
  const personId = intakePersonOfKey(row.dedupeKey);
  const [person] = personId
    ? await tx
        .select()
        .from(intakePerson)
        .where(and(eq(intakePerson.id, personId), eq(intakePerson.tenantId, t.id)))
    : [];
  if (!person) return skip("not_found");
  const [it] = await tx
    .select()
    .from(intake)
    .where(and(eq(intake.id, person.intakeId), eq(intake.tenantId, t.id)));
  if (!it) return skip("not_found");
  if (it.status === "cancelled" || it.status === "done") return skip("closed", it.id, person.id);
  if (row.kind === "intake_invite" && it.sendAt && it.sendAt.getTime() > now.getTime()) {
    return { kind: "hold", reason: "scheduled" };
  }
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  // HIPAA mode (§1.35): the email names the client and its person to Resend.
  if (onboardingEmailRefusal(settings, deps.covered)) return skip("hipaa", it.id, person.id);
  if (!deps.mailerConfigured) return skip("not_configured", it.id, person.id);

  const locale = personLocale(person, settings);
  const lead = await intakeLead(tx, it);
  const due =
    row.kind === "intake_invite" && it.sendAt && it.sendAt.getTime() > row.createdAt.getTime()
      ? it.sendAt
      : row.createdAt;
  const expiresAt = welcomeLinkExpiry(due);
  let link: string;
  try {
    link = await welcomeLinkUrl(
      { origin: deps.origin, env: deps.links },
      { tenantId: t.id, intakeId: it.id, personId: person.id, expiresAt },
    );
  } catch {
    // Production without ENCRYPTION_KEY makes no links, so no invite goes.
    return skip("no_link_key", it.id, person.id);
  }
  const base = {
    locale,
    client: t.name,
    to: { name: person.name, email: person.email },
    lead: { name: lead.name, photoUrl: null },
    link,
    expiresAt,
    origin: deps.origin,
  };

  let rendered: RenderedEmail;
  if (row.kind === "intake_invite") {
    rendered = renderInviteEmail({ ...base, note: it.leadNote, summary: intakeSummaryOf(it) });
  } else {
    const wanted = row.kind === "intake_colleague" ? "colleague_invited" : "cards_added";
    // The key's ref names the event (more questions); else the person's latest of the kind.
    const ref = row.dedupeKey.split(":")[2];
    const [ev] = await tx
      .select({ meta: intakeEvent.meta })
      .from(intakeEvent)
      .where(
        and(
          eq(intakeEvent.tenantId, t.id),
          eq(intakeEvent.intakeId, it.id),
          eq(intakeEvent.personId, person.id),
          eq(intakeEvent.kind, wanted),
          ...(ref ? [eq(intakeEvent.id, ref)] : []),
        ),
      )
      .orderBy(desc(intakeEvent.createdAt))
      .limit(1);
    if (!ev) return skip("not_found", it.id, person.id);
    const meta = (ev.meta ?? {}) as Record<string, unknown>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    if (row.kind === "intake_colleague") {
      const askedById = typeof meta.askedByUserId === "string" ? meta.askedByUserId : null;
      const [asker] = askedById
        ? await tx
            .select({ name: appUser.name, email: appUser.email })
            .from(appUser)
            .where(eq(appUser.id, askedById))
        : [];
      rendered = renderColleagueEmail({
        ...base,
        askedBy: { name: asker ? leadDisplayName(asker) : t.name },
        about: strings(meta.about),
      });
    } else {
      rendered = renderMoreQuestionsEmail({
        ...base,
        note: typeof meta.note === "string" ? meta.note : "",
        added: strings(meta.added),
        summary: intakeSummaryOf(it),
      });
    }
  }
  return {
    kind: "send",
    intakeId: it.id,
    personId: person.id,
    message: {
      to: person.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      from: { name: lead.name, localPart: HELLO_LOCAL_PART },
      ...(lead.email ? { replyTo: lead.email } : {}),
      tags: { [ONBOARDING_TAG_TENANT]: t.id, [ONBOARDING_TAG_NOTIFICATION]: row.id },
    },
  };
}

/**
 * The setup nudge (docs/setup-plan.md §8; §1.206, SU6), written by Nudge on the Setup tab as an
 * `intake_reminder` row for one of the client's members: from the client's lead (else its newest
 * intake's, else Mezonas),
 * in the member's language, listing what the nudge listed (`setupGuide.nudgeItems`), with a link
 * to Getting started. A member who left, or a nudge with nothing left to list, gets nothing.
 */
// DECISION: the nudge goes to a member, not an intake's person: who a setup waits on is anyone
// asked (a seat, a tool), on the intake or not. So it carries no welcome link (they sign in) and
// nothing is logged on an intake.
async function prepareSetupNudge(
  tx: Tx,
  t: typeof tenantTable.$inferSelect,
  row: NotificationRow,
  deps: OnboardingSendDeps,
): Promise<PreparedOnboardingEmail> {
  const skip = (reason: string) =>
    ({ kind: "skip", reason, intakeId: null, personId: null }) as const;
  if (!row.userId) return skip("not_found");
  const [member] = await tx
    .select({ name: appUser.name, email: appUser.email })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, t.id),
        eq(membership.userId, row.userId),
        inArray(membership.role, ["client_admin", "client_user"]),
      ),
    );
  if (!member) return skip("not_a_member");
  const settings = (t.settings ?? {}) as Record<string, unknown>;
  if (onboardingEmailRefusal(settings, deps.covered)) return skip("hipaa");
  if (!deps.mailerConfigured) return skip("not_configured");
  const items = readTenantGuide(settings).nudgeItems?.[row.userId] ?? [];
  if (items.length === 0) return skip("nothing_left");
  // The client's lead, else the lead on its newest intake, else Mezonas.
  const lead = await leadOf(tx, t.id);
  let from: { name: string; email: string | null } | null = lead
    ? { name: leadDisplayName(lead), email: lead.email }
    : null;
  if (!from) {
    const [it] = await tx
      .select({ leadUserId: intake.leadUserId })
      .from(intake)
      .where(eq(intake.tenantId, t.id))
      .orderBy(desc(intake.createdAt))
      .limit(1);
    if (it?.leadUserId) from = await intakeLead(tx, it);
  }
  const rendered = renderSetupNudgeEmail({
    locale: userLanguage(settings, row.userId) ?? clientLanguage(settings) ?? "en",
    client: t.name,
    to: { name: member.name?.trim() || member.email, email: member.email },
    lead: { name: from?.name ?? "Mezonas", photoUrl: null },
    items,
    link: row.link,
    origin: deps.origin,
  });
  return {
    kind: "send",
    intakeId: null,
    personId: null,
    message: {
      to: member.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      from: { name: from?.name ?? "Mezonas", localPart: HELLO_LOCAL_PART },
      ...(from?.email ? { replyTo: from.email } : {}),
    },
  };
}

/** The email an onboarding row is (`invite`, `colleague`, `more_questions`), for the intake's log. */
export function onboardingEmailOf(kind: string): OnboardingEmailKind | null {
  for (const [k, v] of Object.entries(ONBOARDING_EMAIL_NOTIFICATION)) {
    if (v === kind) return k as OnboardingEmailKind;
  }
  return null;
}

/** Logs what became of an onboarding email on its intake (`sent`, with its status). */
export async function logOnboardingSend(
  tx: Tx,
  input: {
    tenantId: string;
    intakeId: string;
    personId: string;
    kind: string;
    notificationId: string;
    status: "sent" | "skipped" | "failed";
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(intakeEvent).values({
    tenantId: input.tenantId,
    intakeId: input.intakeId,
    personId: input.personId,
    kind: "sent",
    meta: {
      email: onboardingEmailOf(input.kind),
      notificationId: input.notificationId,
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

/** Why an onboarding email didn't go, in the lead's to-do. Others (closed, not found) need none. */
const UNSENT_WHY: Record<string, string> = {
  hipaa: "The client is in HIPAA mode and our email service isn't covered yet.",
  not_configured: "Email isn't set up here.",
  no_link_key: "Welcome links can't be signed here (no ENCRYPTION_KEY).",
  failed: "Our email service didn't take it after several tries.",
  // §1.220: Resend's webhook said it came back.
  bounced: "It bounced: the address may be wrong, or their mail server refused it.",
};

const UNSENT_WORDS: Record<OnboardingEmailKind, string> = {
  invite: "invite",
  colleague: "colleague's email",
  more_questions: "email about more questions",
};

/**
 * An onboarding email the pass skipped or gave up on: a to-do on the lead's Your call (every
 * operator's when the intake names no lead), due now, once per email. The person was told nothing,
 * and the sign-in provider sent nothing either (§1.149, `brandedEmailCanGo`).
 */
export async function leaveUnsentTodo(
  db: Db,
  input: {
    tenantId: string;
    intakeId: string;
    personId: string;
    notificationId: string;
    kind: string;
    reason: string;
    now?: Date;
  },
): Promise<void> {
  const why = UNSENT_WHY[input.reason];
  const email = onboardingEmailOf(input.kind);
  if (!why || !email) return;
  await withOperator(db, [input.tenantId], async (tx) => {
    const [person] = await tx
      .select({ name: intakePerson.name })
      .from(intakePerson)
      .where(and(eq(intakePerson.id, input.personId), eq(intakePerson.tenantId, input.tenantId)));
    const [it] = await tx
      .select({ leadUserId: intake.leadUserId })
      .from(intake)
      .where(and(eq(intake.id, input.intakeId), eq(intake.tenantId, input.tenantId)));
    const [client] = await tx
      .select({ name: tenantTable.name })
      .from(tenantTable)
      .where(eq(tenantTable.id, input.tenantId));
    if (!person || !it) return;
    await addTodo(tx, {
      title: `The ${UNSENT_WORDS[email]} to ${person.name} at ${client?.name ?? "the client"} didn't go out`,
      owner: "operator",
      ownerUserId: it.leadUserId,
      clientId: input.tenantId,
      about: { kind: "client", id: input.tenantId },
      source: "system",
      why,
      dueAt: input.now ?? new Date(),
      dedupeKey: `intake-unsent:${input.notificationId}`,
    });
  });
}
