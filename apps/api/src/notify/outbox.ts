// The notification outbox (ARCHITECTURE §5.5 `notification`, §11.3; docs/plan.md §1.37). Candidates
// are inserted `on conflict do nothing` by (client, channel, dedupe key), so a pass run twice sends
// once; then queued rows are sent. A row in the person's quiet hours stays queued (held, not
// dropped); a failed send is tried twice more, then marked `failed`; with no sender it is
// `skipped`. Every query runs inside the caller's withTenant for one client (invariant 1).

import {
  holdsInQuietHours,
  inQuietHours,
  NOTIFICATION_REASONS,
  NOTIFY_MAX_TRIES,
  type NotificationChannel,
  type NotificationCounts,
  type NotificationKind,
  notificationLink,
  renderNotification,
  retryReason,
  triesOf,
  trimTrailingSlashes,
  weekOfKey,
} from "@countersign/core";
import { notification, type Tx } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Mailer, Texter } from "./mailer";
import { memberPerson, type NotifyPerson, type TenantRow, wantsText } from "./people";

export type NotificationRow = typeof notification.$inferSelect;

export interface NotifyDeps {
  mailer: Mailer;
  texter: Texter;
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
): Candidate[] {
  const out: Candidate[] = [];
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

async function settle(
  tx: Tx,
  row: NotificationRow,
  set: Partial<Pick<NotificationRow, "status" | "reason" | "providerId" | "sentAt">>,
) {
  await tx
    .update(notification)
    .set(set)
    .where(and(eq(notification.id, row.id), eq(notification.tenantId, row.tenantId)));
}

/** Sends the client's queued notifications (oldest first, at most `limit`). */
export async function sendQueued(
  tx: Tx,
  deps: NotifyDeps,
  t: TenantRow,
  now: Date,
  limit = 200,
): Promise<SendSummary> {
  const out: SendSummary = { sent: 0, skipped: 0, failed: 0, held: 0 };
  const rows = await tx
    .select()
    .from(notification)
    .where(and(eq(notification.tenantId, t.id), eq(notification.status, "queued")))
    .orderBy(asc(notification.createdAt))
    .limit(limit);
  const people = new Map<string, NotifyPerson | null>();
  const personFor = async (userId: string) => {
    if (!people.has(userId)) people.set(userId, await memberPerson(tx, t, userId));
    return people.get(userId) ?? null;
  };
  let from: string | null | undefined;

  for (const row of rows) {
    const skip = async (reason: string) => {
      await settle(tx, row, { status: "skipped", reason });
      out.skipped++;
    };
    const person = row.userId ? await personFor(row.userId) : null;
    // DECISION: someone who left the client (no membership) is told nothing more.
    if (!person) {
      await skip("not_a_member");
      continue;
    }
    if (row.channel === "email" && !person.prefs.email) {
      await skip(NOTIFICATION_REASONS.turnedOff);
      continue;
    }
    if (row.channel === "sms" && !wantsText(person)) {
      await skip(NOTIFICATION_REASONS.turnedOff);
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
    try {
      const providerId =
        row.channel === "email"
          ? await deps.mailer.send({
              to: person.email,
              subject: rendered.subject,
              text: rendered.text,
              ...(rendered.html ? { html: rendered.html } : {}),
              idempotencyKey: row.id,
            })
          : await deps.texter.send(tx, t.id, {
              to: person.phone as string,
              body: rendered.text,
            });
      await settle(tx, row, { status: "sent", reason: null, providerId, sentAt: now });
      out.sent++;
    } catch (error) {
      // Logged without the message: it names a kind and an id, never content.
      console.warn(`notification ${row.id} (${row.kind}, ${row.channel}) failed to send`, error);
      const tries = triesOf(row.reason) + 1;
      if (tries >= NOTIFY_MAX_TRIES) {
        await settle(tx, row, { status: "failed", reason: NOTIFICATION_REASONS.sendFailed });
        out.failed++;
      } else {
        await settle(tx, row, { reason: retryReason(tries) });
      }
    }
  }
  return out;
}
