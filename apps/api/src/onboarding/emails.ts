// The onboarding emails (docs/cases-plan.md §4.4; docs/plan.md §1.125): the invite, a colleague
// asked, a few more questions. Each is written to the notifications outbox (§1.37) in the caller's
// transaction as its own kind (`intake_invite`, `intake_colleague`, `intake_more_questions`;
// migration 0064), once per person and email (the dedupe key), and sent after the commit by the
// notification pass: rendered then in the person's language from the intake and its person (core
// `renderInviteEmail`…), from `<Lead> at Mezonas <hello@…>` with Reply-To the lead's own address,
// through the mailer with the row's id as the idempotency key; `skipped` without Resend, as today.
// What became of each is logged on the intake (`intake_event`). No open-tracking pixels.
//
// Nothing from the client file goes in beyond names: the intake's own row (the lead's note, what
// it covers, the guide's minutes) and the person's name and address.

import {
  clientLanguage,
  dedupeKeys,
  Guide,
  IntakeArea,
  type IntakeSummary,
  intakePersonOfKey,
  isOnboardingNotificationKind,
  type Locale,
  notificationLink,
  type OnboardingNotificationKind,
  parseLocale,
  type RenderedEmail,
  renderColleagueEmail,
  renderInviteEmail,
  renderMoreQuestionsEmail,
  userLanguage,
} from "@countersign/core";
import {
  appUser,
  intake,
  intakeEvent,
  intakePerson,
  notification,
  type Tx,
  type tenant,
} from "@countersign/db";
import { leadDisplayName } from "@countersign/threads";
import { and, desc, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import { HttpError } from "../http";
import { HELLO_LOCAL_PART, type MailMessage, mailerFromEnv } from "../notify/mailer";
import { originOf } from "../notify/outbox";
import { type WelcomeLinkEnv, welcomeLinkExpiry, welcomeLinkUrl } from "./link";

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
    await event("colleague_invited", {
      askedByUserId: email.askedByUserId,
      about: titles(email.about),
    });
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
  if (!made) return { notificationId: null, status: "queued" };
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
      intakeId: string;
      personId: string;
    };

export interface OnboardingSendDeps {
  mailerConfigured: boolean;
  origin: string;
  links: WelcomeLinkEnv;
}

/**
 * One queued onboarding row, ready to send (or why not), read inside the client's transaction.
 * The welcome link expires 14 days after the email was due (its row's time, or the invite's "Send
 * at"), so a retried send renders the same email under the same idempotency key.
 */
export async function prepareOnboardingEmail(
  tx: Tx,
  t: typeof tenant.$inferSelect,
  row: NotificationRow,
  deps: OnboardingSendDeps,
  now: Date,
): Promise<PreparedOnboardingEmail> {
  const skip = (reason: string, intakeId: string | null = null, personId: string | null = null) =>
    ({ kind: "skip", reason, intakeId, personId }) as const;
  if (!isOnboardingNotificationKind(row.kind)) return skip("not_onboarding");
  if (
    row.kind !== "intake_invite" &&
    row.kind !== "intake_colleague" &&
    row.kind !== "intake_more_questions"
  ) {
    // The reminder, "Your scope is ready" and "What happens next" are next wave's.
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
  if (!deps.mailerConfigured) return skip("not_configured", it.id, person.id);

  const settings = (t.settings ?? {}) as Record<string, unknown>;
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
