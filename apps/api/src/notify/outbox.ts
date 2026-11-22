// The notification outbox (ARCHITECTURE §5.5 `notification`, §11.3; docs/plan.md §1.37). Candidates
// are inserted `on conflict do nothing` by (client, channel, dedupe key), so a pass run twice sends
// once; then queued rows are claimed, sent and settled (`sendQueued`). A row in the person's quiet
// hours stays queued (held, not dropped); a failed send is tried twice more, then marked
// `failed`; with no sender it is `skipped`. Every query runs inside a withTenant for one client
// (invariant 1).

import {
  complianceOf,
  holdsInQuietHours,
  inQuietHours,
  isOnboardingNotificationKind,
  NOTIFICATION_REASONS,
  NOTIFY_MAX_TRIES,
  type NotificationChannel,
  type NotificationCounts,
  type NotificationKind,
  notificationLink,
  overridesSwitches,
  type Processor,
  renderNotification,
  renderPush,
  retryReason,
  triesOf,
  trimTrailingSlashes,
  weekOfKey,
} from "@countersign/core";
import { type Db, notification, personDevice, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Bindings } from "../env";
import { meter } from "../metering";
import { reportHandled, reportProblem } from "../observability/report";
import {
  leaveUnsentTodo,
  logOnboardingSend,
  type PreparedOnboardingEmail,
  prepareOnboardingEmail,
} from "../onboarding/emails";
import type { WelcomeLinkEnv } from "../onboarding/link";
import type { Mailer, Texter } from "./mailer";
import {
  memberPerson,
  type NotifyPerson,
  type TenantRow,
  tenantRow,
  wantsPush,
  wantsText,
} from "./people";
import { type Pusher, unconfiguredPusher } from "./push";

export type NotificationRow = typeof notification.$inferSelect;

export interface NotifyDeps {
  mailer: Mailer;
  /** §1.149: what signs the onboarding emails' welcome links (the Worker's key). */
  links?: WelcomeLinkEnv;
  texter: Texter;
  /** §1.116: phone notifications (Expo's push service); none means off (rows skipped). */
  pusher?: Pusher;
  /** `BAA_PROCESSORS`: a client in HIPAA mode gets phone notifications only once Expo is here. */
  covered?: ReadonlySet<Processor>;
  /** APP_ORIGIN: links are this plus the page. */
  origin: string;
}

// DECISION: without APP_ORIGIN (every wrangler environment sets it) links point at production.
export const DEFAULT_APP_ORIGIN = "https://app.mezonas.com";

export function originOf(env: Pick<Bindings, "APP_ORIGIN">): string {
  return trimTrailingSlashes(env.APP_ORIGIN?.trim() || DEFAULT_APP_ORIGIN);
}

/** One notification to write: a person, a channel, a kind, its key, page and counts. */
export interface Candidate {
  userId: string;
  contactId: string | null;
  channel: NotificationChannel;
  kind: NotificationKind;
  dedupeKey: string;
  path: string;
  counts: NotificationCounts;
}

/**
 * A person's candidates for one notification: email if they keep email on, a text if they turned
 * texts on and one can reach them. The client's own switches are checked by the caller.
 */
export function candidatesFor(
  person: NotifyPerson,
  base: Omit<Candidate, "userId" | "contactId" | "channel">,
  /** §1.116: false where the caller decides phone notifications itself (items waiting). */
  options: { push?: boolean } = {},
): Candidate[] {
  const out: Candidate[] = [];
  // §1.116: their phones, same kind, same key (the unique key includes the channel).
  if (options.push !== false && wantsPush(person)) {
    out.push({ ...base, userId: person.userId, contactId: null, channel: "push" });
  }
  if (person.prefs.email) {
    out.push({ ...base, userId: person.userId, contactId: null, channel: "email" });
  }
  if (wantsText(person)) {
    out.push({ ...base, userId: person.userId, contactId: person.contactId, channel: "sms" });
  }
  return out;
}

/** Inserts the candidates; returns the rows that are new (a key seen before writes nothing). */
export async function enqueue(
  tx: Tx,
  tenantId: string,
  origin: string,
  candidates: readonly Candidate[],
  /** The pass's time: the rows' `created_at`, which the hourly and daily checks compare. */
  at: Date,
): Promise<NotificationRow[]> {
  if (candidates.length === 0) return [];
  return tx
    .insert(notification)
    .values(
      candidates.map((c) => ({
        tenantId,
        userId: c.userId,
        contactId: c.contactId,
        channel: c.channel,
        kind: c.kind,
        dedupeKey: c.dedupeKey,
        link: notificationLink(origin, c.path),
        counts: c.counts as Record<string, number>,
        createdAt: at,
      })),
    )
    .onConflictDoNothing({
      target: [notification.tenantId, notification.channel, notification.dedupeKey],
    })
    .returning();
}

export interface SendSummary {
  sent: number;
  skipped: number;
  failed: number;
  held: number;
}

/**
 * A queued row claimed by a send pass keeps `queued` and carries the claim in `reason`:
 * `sending:<claimed at, ms>:<its reason before>`. Another pass skips it until the lease runs out.
 */
// DECISION (audit 4.3): the claim is in `reason`, not a `sending` status: the status check allows
// only queued, sent, failed and skipped, and a new value would be a migration. The time is the
// pass's own clock (`now`), as every other check of the outbox reads it.
export const CLAIM_PREFIX = "sending:";
/** A claim older than this was a pass that never settled its row (it crashed or was cut off). */
export const CLAIM_LEASE_MS = 10 * 60_000;

export function claimReason(at: Date, before: string | null): string {
  return `${CLAIM_PREFIX}${at.getTime()}:${before ?? ""}`;
}

/** A row's claim, or null when it has none. */
export function readClaim(reason: string | null): { at: number; before: string | null } | null {
  const m = /^sending:(\d+):(.*)$/s.exec(reason ?? "");
  if (!m) return null;
  return { at: Number(m[1]), before: m[2] ? (m[2] as string) : null };
}

async function settle(
  tx: Tx,
  row: NotificationRow,
  set: Partial<Pick<NotificationRow, "status" | "reason" | "providerId" | "sentAt">>,
  /** Only while the row still holds this claim: a pass whose lease ran out settles nothing. */
  claim?: string,
) {
  await tx
    .update(notification)
    .set(set)
    .where(
      and(
        eq(notification.id, row.id),
        eq(notification.tenantId, row.tenantId),
        ...(claim === undefined ? [] : [eq(notification.reason, claim)]),
      ),
    );
}

/** One row a pass claimed: what goes out, to whom, under which claim. */
interface Claimed {
  row: NotificationRow;
  person: NotifyPerson;
  rendered: ReturnType<typeof renderNotification>;
  claim: string;
  /**
   * §1.149: an onboarding email, rendered from its intake and sent to the intake person (who may
   * have no account yet) from the lead; `person` and `rendered` are unused for it.
   */
  onboarding?: Extract<PreparedOnboardingEmail, { kind: "send" }>;
}

/**
 * Sends the client's queued notifications (oldest first, at most `limit`), in three parts so a
 * row is sent once even when two passes run at once:
 *
 * 1. a short transaction claims the rows (`for update skip locked`, rows another pass claimed and
 *    whose lease is still running left out), settling at once the ones it skips or holds;
 * 2. each claimed row is sent outside it (a text in a transaction of its own, which only reads
 *    the client's Twilio credentials for that one send);
 * 3. each row is settled in its own short transaction, only while it still holds its claim.
 *
 * A claim whose lease ran out (the pass stopped between sending and settling): an email is sent
 * again, which Resend's idempotency key (`notify-<row id>`) makes the same send; a text or a phone
 * notification may already have gone and has no such key, so it is failed, `send_unconfirmed`,
 * and reported, never sent twice.
 */
export async function sendQueued(
  db: Db,
  deps: NotifyDeps,
  tenantId: string,
  now: Date,
  limit = 200,
  /** C4.10: only these rows (an urgent notice's, sent as soon as they are queued). */
  only?: readonly string[],
): Promise<SendSummary | null> {
  const out: SendSummary = { sent: 0, skipped: 0, failed: 0, held: 0 };
  if (only && only.length === 0) return out;
  const pusher = deps.pusher ?? unconfiguredPusher;
  // §1.149: onboarding emails that didn't go, each left as a to-do for the lead after its settle.
  const unsent: Parameters<typeof leaveUnsentTodo>[1][] = [];
  const claimed = await withTenant(db, tenantId, async (tx) => {
    const t = await tenantRow(tx, tenantId);
    if (!t || t.retiredAt) return null;
    const leaseEnded = now.getTime() - CLAIM_LEASE_MS;
    const rows = await tx
      .select()
      .from(notification)
      .where(
        and(
          eq(notification.tenantId, t.id),
          eq(notification.status, "queued"),
          ...(only ? [inArray(notification.id, [...only])] : []),
          sql`case when ${notification.reason} like 'sending:%' then split_part(${notification.reason}, ':', 2)::bigint < ${leaseEnded} else true end`,
        ),
      )
      .orderBy(asc(notification.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const people = new Map<string, NotifyPerson | null>();
    const personFor = async (userId: string) => {
      if (!people.has(userId)) people.set(userId, await memberPerson(tx, t, userId));
      return people.get(userId) ?? null;
    };
    let from: string | null | undefined;
    const sends: Claimed[] = [];

    for (const stored of rows) {
      let row = stored;
      const lapsed = readClaim(stored.reason);
      if (lapsed) {
        if (row.channel !== "email") {
          await settle(tx, row, { status: "failed", reason: NOTIFICATION_REASONS.unconfirmed });
          out.failed++;
          reportProblem("a notification may have been sent; it was not sent again", {
            job: "notify",
            client: t.id,
            notification: row.id,
            channel: row.channel,
          });
          continue;
        }
        // The same email again, under the same idempotency key: Resend sends it once.
        row = { ...row, reason: lapsed.before };
      }
      const skip = async (reason: string) => {
        await settle(tx, row, { status: "skipped", reason });
        out.skipped++;
      };
      // §1.149: the onboarding emails go to the intake's person, account or not, whatever their
      // notification settings (they asked for none yet), at once rather than in quiet hours.
      if (isOnboardingNotificationKind(row.kind)) {
        const prepared = await prepareOnboardingEmail(
          tx,
          t,
          row,
          {
            mailerConfigured: deps.mailer.isConfigured,
            origin: deps.origin,
            links: deps.links ?? {},
            covered: deps.covered ?? new Set(),
          },
          now,
        );
        if (prepared.kind === "hold") {
          if (row.reason !== prepared.reason) await settle(tx, row, { reason: prepared.reason });
          out.held++;
          continue;
        }
        if (prepared.kind === "skip") {
          await skip(prepared.reason);
          if (prepared.intakeId && prepared.personId) {
            await logOnboardingSend(tx, {
              tenantId: t.id,
              intakeId: prepared.intakeId,
              personId: prepared.personId,
              kind: row.kind,
              notificationId: row.id,
              status: "skipped",
              reason: prepared.reason,
            });
            unsent.push({
              tenantId: t.id,
              intakeId: prepared.intakeId,
              personId: prepared.personId,
              notificationId: row.id,
              kind: row.kind,
              reason: prepared.reason,
              now,
            });
          }
          continue;
        }
        const claim = claimReason(now, row.reason);
        await settle(tx, row, { reason: claim });
        sends.push({
          row,
          // Unused for an onboarding email; the claim's shape is shared.
          person: null as unknown as NotifyPerson,
          rendered: { subject: prepared.message.subject, text: prepared.message.text },
          claim,
          onboarding: prepared,
        });
        continue;
      }
      const person = row.userId ? await personFor(row.userId) : null;
      // DECISION: someone who left the client (no membership) is told nothing more.
      if (!person) {
        await skip("not_a_member");
        continue;
      }
      // C4.10: an urgent notice goes whatever the person's switches say; a text still needs a
      // number that may be texted (their consent, no STOP).
      const switches = !overridesSwitches(row.kind);
      if (row.channel === "email" && switches && !person.prefs.email) {
        await skip(NOTIFICATION_REASONS.turnedOff);
        continue;
      }
      if (row.channel === "sms" && (switches ? !wantsText(person) : person.phone === null)) {
        await skip(NOTIFICATION_REASONS.turnedOff);
        continue;
      }
      // §1.116: phones turned off, or none left.
      if (row.channel === "push" && !wantsPush(person)) {
        await skip(NOTIFICATION_REASONS.turnedOff);
        continue;
      }
      // §1.116: Expo is a vendor of ours; HIPAA mode sends it nothing until its BAA is recorded.
      if (
        row.channel === "push" &&
        complianceOf(t.settings as Record<string, unknown>).hipaa &&
        !deps.covered?.has("expo_push")
      ) {
        await skip("not_covered");
        continue;
      }
      if (row.channel === "push" && !pusher.isConfigured) {
        await skip(NOTIFICATION_REASONS.notConfigured);
        continue;
      }
      if (row.channel === "email" && !deps.mailer.isConfigured) {
        await skip(NOTIFICATION_REASONS.notConfigured);
        continue;
      }
      if (row.channel === "sms") {
        if (from === undefined) from = await deps.texter.from(tx, t.id);
        if (!from) {
          await skip(NOTIFICATION_REASONS.noSender);
          continue;
        }
      }
      if (
        holdsInQuietHours(row.kind, row.channel) &&
        inQuietHours(now, person.hours.timezone, person.hours.quietHours)
      ) {
        if (row.reason !== NOTIFICATION_REASONS.quietHours && triesOf(row.reason) === 0) {
          await settle(tx, row, { reason: NOTIFICATION_REASONS.quietHours });
        } else if (lapsed) {
          await settle(tx, row, { reason: row.reason });
        }
        out.held++;
        continue;
      }
      const weekStart = weekOfKey(row.dedupeKey);
      const rendered = renderNotification({
        kind: row.kind,
        channel: row.channel,
        counts: row.counts,
        link: row.link,
        locale: person.locale,
        toLead: row.kind === "lead_message" && person.role === "operator",
        ...(weekStart ? { weekStart } : {}),
      });
      const claim = claimReason(now, row.reason);
      await settle(tx, row, { reason: claim });
      sends.push({ row, person, rendered, claim });
    }
    return { t, sends };
  });
  if (!claimed) return null;
  const { t } = claimed;
  const leaveUnsent = async () => {
    for (const u of unsent.splice(0)) {
      await leaveUnsentTodo(db, u).catch((error: unknown) =>
        reportHandled("leaving an unsent onboarding email's to-do failed", error, {
          job: "notify",
          client: t.id,
          notification: u.notificationId,
        }),
      );
    }
  };
  await leaveUnsent();

  for (const { row, person, rendered, claim, onboarding } of claimed.sends) {
    let providerId: string | null = null;
    let failure: unknown = null;
    let gone: string[] = [];
    try {
      if (onboarding) {
        // §1.149: from the lead at hello@, Reply-To the lead; the row's id is the idempotency key.
        providerId = await deps.mailer.send({ ...onboarding.message, idempotencyKey: row.id });
      } else if (row.channel === "push") {
        const pushed = await sendPush(pusher, t, person, row);
        gone = pushed.gone;
        if (!pushed.id) throw new Error("no phone took the notification");
        providerId = pushed.id;
      } else if (row.channel === "email") {
        providerId = await deps.mailer.send({
          to: person.email,
          subject: rendered.subject,
          text: rendered.text,
          ...(rendered.html ? { html: rendered.html } : {}),
          idempotencyKey: row.id,
        });
      } else {
        // DECISION (audit 4.3): the texter reads the client's Twilio credentials under the
        // client's scope, so a text's send has a transaction of its own, held for that one call.
        providerId = await withTenant(db, tenantId, async (tx) => {
          const sid = await deps.texter.send(tx, t.id, {
            to: person.phone as string,
            body: rendered.text,
          });
          // §1.210: a text no run sent is the client's own usage.
          await meter(tx, {
            tenantId: t.id,
            measure: "messages",
            source: "notification",
            key: `twilio:${sid}`,
          });
          return sid;
        });
      }
    } catch (error) {
      failure = error;
      // Logged without the message: it names a kind and an id, never content.
      console.warn(`notification ${row.id} (${row.kind}, ${row.channel}) failed to send`, error);
    }
    try {
      await withTenant(db, tenantId, async (tx) => {
        if (gone.length > 0) {
          await tx
            .update(personDevice)
            .set({ pushToken: null })
            .where(
              and(
                eq(personDevice.tenantId, t.id),
                eq(personDevice.userId, person.userId),
                inArray(personDevice.pushToken, gone),
              ),
            );
        }
        // §1.206: the setup nudge goes to a member and is logged on no intake.
        const logged = (status: "sent" | "failed") =>
          onboarding?.intakeId && onboarding.personId
            ? logOnboardingSend(tx, {
                tenantId: t.id,
                intakeId: onboarding.intakeId,
                personId: onboarding.personId,
                kind: row.kind,
                notificationId: row.id,
                status,
              })
            : Promise.resolve();
        if (failure === null) {
          await settle(tx, row, { status: "sent", reason: null, providerId, sentAt: now }, claim);
          // §1.210: an email through Resend (onboarding's too), once per notification.
          if (onboarding || row.channel === "email") {
            await meter(tx, {
              tenantId: t.id,
              measure: "emails",
              source: "notification",
              key: `notify:${row.id}`,
            });
          }
          await logged("sent");
          return;
        }
        const tries = triesOf(row.reason) + 1;
        if (tries >= NOTIFY_MAX_TRIES) {
          await settle(
            tx,
            row,
            { status: "failed", reason: NOTIFICATION_REASONS.sendFailed },
            claim,
          );
          await logged("failed");
          if (onboarding?.intakeId && onboarding.personId) {
            unsent.push({
              tenantId: t.id,
              intakeId: onboarding.intakeId,
              personId: onboarding.personId,
              notificationId: row.id,
              kind: row.kind,
              reason: "failed",
              now,
            });
          }
        } else {
          await settle(tx, row, { reason: retryReason(tries) }, claim);
        }
      });
    } catch (error) {
      // The row keeps its claim; once its lease runs out it is settled as above.
      reportHandled(`settling notification ${row.id} failed`, error, {
        job: "notify",
        client: t.id,
        notification: row.id,
      });
      continue;
    }
    if (failure === null) out.sent++;
    else if (triesOf(row.reason) + 1 >= NOTIFY_MAX_TRIES) out.failed++;
  }
  await leaveUnsent();
  return out;
}

/**
 * §1.116: one notification to each of the person's phones. `id` is the first ticket a phone took
 * (none: no phone took it, to be tried again); `gone` the tokens whose app is gone.
 */
async function sendPush(
  pusher: Pusher,
  t: TenantRow,
  person: NotifyPerson,
  row: NotificationRow,
): Promise<{ id: string | null; gone: string[] }> {
  const weekStart = weekOfKey(row.dedupeKey);
  // §1.149: the onboarding emails are email only; nothing else reaches a phone.
  if (isOnboardingNotificationKind(row.kind)) return { id: null, gone: [] };
  const words = renderPush({
    kind: row.kind,
    counts: row.counts,
    locale: person.locale,
    toLead: row.kind === "lead_message" && person.role === "operator",
    ...(weekStart ? { weekStart } : {}),
    clientName: person.push.pushShowsClient ? t.name : null,
  });
  const path = pathOf(row.link);
  const tickets = await pusher.send(
    person.pushTokens.map((to) => ({
      to,
      title: words.title,
      body: words.body,
      data: { path, kind: row.kind },
      ...(row.kind === "items_waiting" && row.counts.items !== undefined
        ? { badge: row.counts.items }
        : {}),
    })),
  );
  const gone = person.pushTokens.filter((_, i) => {
    const ticket = tickets[i];
    return ticket && !ticket.ok && ticket.gone;
  });
  const sent = tickets.find((ticket): ticket is { ok: true; id: string } => ticket.ok);
  return { id: sent?.id ?? null, gone };
}

/** The page a notification's link names (its path and query), for the app to open. */
function pathOf(link: string): string {
  try {
    const url = new URL(link);
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}
