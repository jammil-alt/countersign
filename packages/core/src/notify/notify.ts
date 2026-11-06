// Notifications (ARCHITECTURE §11.3, docs/plan.md §1.37): Mezonas tells people that something
// waits for them; it never sends the thing itself. A notification is a count, a short fixed
// sentence in the person's language (i18n/notify.ts) and one link. This module holds the kinds,
// their dedupe keys, counts and links, and the preferences; the Worker scans rows and sends
// (apps/api/src/notify/).

import { z } from "zod";

export const NOTIFICATION_KINDS = [
  "items_waiting",
  "weekly_table",
  "reconnect",
  "credits",
  "lead_message",
  "signoff",
] as const;
export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;

export const NOTIFICATION_STATUSES = ["queued", "sent", "failed", "skipped"] as const;
export const NotificationStatus = z.enum(NOTIFICATION_STATUSES);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

/** Why a row was skipped, or why it is still queued. */
export const NOTIFICATION_REASONS = {
  /** No Resend key or sending domain: Mezonas sends no email here. */
  notConfigured: "not_configured",
  /** The client's Twilio number can't text now (gone, or A2P not approved). */
  noSender: "no_sender",
  /** The person's quiet hours: held, sent once they end. */
  quietHours: "quiet_hours",
  /** The person turned this channel off after the row was queued. */
  turnedOff: "turned_off",
  /** A send failed and will be tried again (`send_failed:<n>`), or failed for good. */
  sendFailed: "send_failed",
} as const;

/** A failed send is retried twice, then marked `failed` (ARCHITECTURE §11.3). */
export const NOTIFY_MAX_TRIES = 3;

/** The cron's notification pass runs on minutes divisible by this. */
export const NOTIFY_PASS_MINUTES = 5;

/** At most one items-waiting notification an hour per person. */
export const ITEMS_WAITING_EVERY_MS = 60 * 60 * 1000;
/** A connection in error asks again only after this long. */
export const RECONNECT_EVERY_MS = 24 * 60 * 60 * 1000;
/** A lead-thread message notifies once it has been unread this long. */
export const LEAD_UNREAD_MS = 10 * 60 * 1000;
/** Credits: the client admin is told again for every block this size beyond the included ones. */
export const CREDITS_BLOCK = 2500;

const utcHour = (at: Date) => at.toISOString().slice(0, 13);
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

// The keys of docs/plan.md §1.37. `notification` is unique on (tenant, channel, dedupe_key), so a
// pass that runs twice sends once.
// DECISION: the keys that name no person (reconnect, credits, signoff) end with `:<user>`, since
// they go to every client admin (and, for reconnect, whoever connected it) and the unique key has
// no user column: without it the second person's row would be dropped as a duplicate.
export const dedupeKeys = {
  itemsWaiting: (userId: string, at: Date) => `items:${userId}:${utcHour(at)}`,
  reconnect: (connectionId: string, at: Date, userId: string) =>
    `reconnect:${connectionId}:${utcDay(at)}:${userId}`,
  weekly: (weekStart: string, userId: string) => `weekly:${weekStart}:${userId}`,
  lead: (messageId: string, userId: string) => `lead:${messageId}:${userId}`,
  credits: (period: string, block: number, userId: string) =>
    `credits:${period}:${block}:${userId}`,
  signoff: (itemId: string, userId: string) => `signoff:${itemId}:${userId}`,
} as const;

/** The prefix every reconnect key of one connection on one UTC day shares (the remind check). */
/** The week a weekly_table key names (`weekly:<week start>:<user>`). */
export function weekOfKey(key: string): string | undefined {
  return /^weekly:(\d{4}-\d{2}-\d{2}):/.exec(key)?.[1];
}

export const reconnectDayPrefix = (connectionId: string, at: Date) =>
  `reconnect:${connectionId}:${utcDay(at)}:`;

/** What a notification counts (`notification.counts`): whole numbers only, never a record's field. */
export const NotificationCounts = z.strictObject({
  items: z.number().int().min(0).optional(),
  runs: z.number().int().min(0).optional(),
  changes: z.number().int().min(0).optional(),
  messages: z.number().int().min(0).optional(),
  /** Credits: 0 = the included credits ran out; n = another n × 2,500 beyond them. */
  block: z.number().int().min(0).optional(),
});
export type NotificationCounts = z.infer<typeof NotificationCounts>;

/** The page each kind links to, under APP_ORIGIN (today's web routes where they exist). */
// DECISION: the Desk is today's `/inbox`; the Weekly Table's page is `/weekly?week=` (the owner's
// redesign builds it); the lead thread is the Table (`/`) for the client and the client's page in
// the back office for the lead; credits link to the client's settings.
export function notificationPath(
  kind: NotificationKind,
  input: { weekStart?: string; clientId?: string; forOperator?: boolean } = {},
): string {
  switch (kind) {
    case "items_waiting":
    case "signoff":
      return "/inbox";
    case "weekly_table":
      return input.weekStart ? `/weekly?week=${input.weekStart}` : "/weekly";
    case "reconnect":
      return "/connections";
    case "credits":
      return "/settings";
    case "lead_message":
      return input.forOperator && input.clientId ? `/ops/clients/${input.clientId}` : "/";
  }
}

/** The text without its trailing `/`s; linear in the length (no regular expression). */
export function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

/** APP_ORIGIN + path, without a doubled slash. */
export function notificationLink(origin: string, path: string): string {
  return `${trimTrailingSlashes(origin)}${path}`;
}

// ── Preferences ─────────────────────────────────────────────────────────────────────────────────

/** `tenant.settings.user_notifications[userId]`: each person's own channels (no migration). */
export const USER_NOTIFICATIONS_KEY = "user_notifications";

export const PersonNotificationSettings = z.object({
  email: z.boolean(),
  sms: z.boolean(),
});
export type PersonNotificationSettings = z.infer<typeof PersonNotificationSettings>;

// DECISION: email is on and texts are off until the person turns them on (ARCHITECTURE §11.3:
// texts go "only if the person turned texts on").
export const DEFAULT_PERSON_NOTIFICATIONS: PersonNotificationSettings = { email: true, sms: false };

export function personNotifications(
  settings: Record<string, unknown> | null | undefined,
  userId: string,
): PersonNotificationSettings {
  const map = settings?.[USER_NOTIFICATIONS_KEY];
  const raw =
    map && typeof map === "object" && !Array.isArray(map)
      ? (map as Record<string, unknown>)[userId]
      : undefined;
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    email: typeof r.email === "boolean" ? r.email : DEFAULT_PERSON_NOTIFICATIONS.email,
    sms: typeof r.sms === "boolean" ? r.sms : DEFAULT_PERSON_NOTIFICATIONS.sms,
  };
}

/** Settings with one person's channels written (other people and settings untouched). */
export function withPersonNotifications(
  settings: Record<string, unknown>,
  userId: string,
  value: PersonNotificationSettings,
): Record<string, unknown> {
  const map = settings[USER_NOTIFICATIONS_KEY];
  const current = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  return { ...settings, [USER_NOTIFICATIONS_KEY]: { ...current, [userId]: value } };
}

/** Kinds that wait for the person's quiet hours on email too (texts always do). */
export function holdsInQuietHours(kind: NotificationKind, channel: NotificationChannel): boolean {
  return channel === "sms" || kind === "items_waiting";
}

/** `reason` while a failed send waits for its next try. */
export const retryReason = (tries: number) => `${NOTIFICATION_REASONS.sendFailed}:${tries}`;

/** How many sends failed so far, from a queued row's reason. */
export function triesOf(reason: string | null): number {
  const m = /^send_failed:(\d+)$/.exec(reason ?? "");
  return m ? Number(m[1]) : 0;
}
