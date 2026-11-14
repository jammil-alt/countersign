// What the notification pass finds by scanning rows (docs/plan.md §1.37): open Desk items,
// connections in `error`, unread lead-thread messages and agents waiting for their go-live
// sign-off. No other stream's code calls in; the Weekly Table queues its own (weekly/tables.ts),
// and credits are queued by the billing pass (W2-G) through `enqueue`.

import {
  dedupeKeys,
  ITEMS_WAITING_EVERY_MS,
  LEAD_UNREAD_MS,
  type NotificationChannel,
  notificationPath,
  RECONNECT_EVERY_MS,
} from "@countersign/core";
import {
  agent,
  connection,
  inboxItem,
  message,
  notification,
  type Tx,
  thread,
  threadRead,
} from "@countersign/db";
import { and, desc, eq, gt, gte, inArray, isNull, like, lte, ne, or } from "drizzle-orm";
import { notificationsOf } from "../routes/onboarding";
import { type Candidate, candidatesFor } from "./outbox";
import { leadUserId, memberPerson, type NotifyPerson, type TenantRow, wantsPush } from "./people";

/** The lead thread's `subject_type` (ARCHITECTURE §11.2). */
export const LEAD_SUBJECT = "lead";

// ── Items waiting ───────────────────────────────────────────────────────────────────────────────

/**
 * Each person with open Desk items assigned to them, or to their role if they sign (viewers get
 * none for their role's items), at most once an hour, only when an item is new since their last
 * one, and never while one is still held for their quiet hours. Snoozed items are skipped.
 */
// DECISION: the count is every open item waiting on the person; the notification goes only when
// at least one of them is new since their last items-waiting notification (any channel). The
// client's "items waiting" switch turns the kind off for everyone, texts included.
export async function itemsWaitingCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  now: Date,
): Promise<Candidate[]> {
  if (!notificationsOf(t.settings).itemsWaiting) return [];
  const items = await tx
    .select({
      id: inboxItem.id,
      assigneeUserId: inboxItem.assigneeUserId,
      assigneeRole: inboxItem.assigneeRole,
      createdAt: inboxItem.createdAt,
    })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, t.id),
        eq(inboxItem.status, "open"),
        or(isNull(inboxItem.assigneeRole), ne(inboxItem.assigneeRole, "operator")),
        or(isNull(inboxItem.snoozedUntil), lte(inboxItem.snoozedUntil, now)),
      ),
    );
  if (items.length === 0) return [];
  const out: Candidate[] = [];
  for (const p of people) {
    const mine = items.filter(
      (i) =>
        i.assigneeUserId === p.userId ||
        (i.assigneeUserId === null && i.assigneeRole === p.role && p.canSign),
    );
    if (mine.length === 0) continue;
    const counts = { items: mine.length };
    const path = notificationPath("items_waiting");
    // Email and texts: at most once an hour (ARCHITECTURE §11.3).
    if (await due(tx, t.id, p.userId, ["email", "sms"], mine, now, ITEMS_WAITING_EVERY_MS)) {
      out.push(
        ...candidatesFor(
          p,
          {
            kind: "items_waiting",
            dedupeKey: dedupeKeys.itemsWaiting(p.userId, now),
            path,
            counts,
          },
          { push: false },
        ),
      );
    }
    // §1.99: their phones on their own pace: each pass ("right away") or hourly.
    const everyPass = p.push.pushEvery === "now";
    if (
      wantsPush(p) &&
      (await due(tx, t.id, p.userId, ["push"], mine, now, everyPass ? 0 : ITEMS_WAITING_EVERY_MS))
    ) {
      out.push({
        userId: p.userId,
        contactId: null,
        channel: "push",
        kind: "items_waiting",
        dedupeKey: everyPass
          ? dedupeKeys.itemsWaitingPush(p.userId, now)
          : dedupeKeys.itemsWaiting(p.userId, now),
        path,
        counts,
      });
    }
  }
  return out;
}

/**
 * Whether a person is due an items-waiting notification on these channels: none held for their
 * quiet hours, none within `everyMs`, and an item new since the last one.
 */
async function due(
  tx: Tx,
  tenantId: string,
  userId: string,
  channels: NotificationChannel[],
  mine: { createdAt: Date }[],
  now: Date,
  everyMs: number,
): Promise<boolean> {
  const mineSoFar = and(
    eq(notification.tenantId, tenantId),
    eq(notification.userId, userId),
    eq(notification.kind, "items_waiting"),
    inArray(notification.channel, channels),
  );
  const [held] = await tx
    .select({ id: notification.id })
    .from(notification)
    .where(and(mineSoFar, eq(notification.status, "queued")))
    .limit(1);
  if (held) return false;
  const [last] = await tx
    .select({ createdAt: notification.createdAt })
    .from(notification)
    .where(mineSoFar)
    .orderBy(desc(notification.createdAt))
    .limit(1);
  if (!last) return true;
  if (now.getTime() - last.createdAt.getTime() < everyMs) return false;
  return mine.some((i) => i.createdAt > last.createdAt);
}

// ── Reconnect ───────────────────────────────────────────────────────────────────────────────────

/** Whether a reconnect was queued for this connection in the last 24 hours. */
export async function reconnectedRecently(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: notification.id })
    .from(notification)
    .where(
      and(
        eq(notification.tenantId, tenantId),
        eq(notification.kind, "reconnect"),
        like(notification.dedupeKey, `reconnect:${connectionId}:%`),
        gt(notification.createdAt, new Date(now.getTime() - RECONNECT_EVERY_MS)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The client admins and whoever connected it (if still a member). */
export async function reconnectPeople(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  connectedBy: string | null,
): Promise<NotifyPerson[]> {
  const out = people.filter((p) => p.role === "client_admin");
  if (connectedBy && !out.some((p) => p.userId === connectedBy)) {
    const p =
      people.find((x) => x.userId === connectedBy) ?? (await memberPerson(tx, t, connectedBy));
    if (p && p.role !== "operator") out.push(p);
  }
  return out;
}

export function reconnectCandidates(
  recipients: NotifyPerson[],
  connectionId: string,
  now: Date,
): Candidate[] {
  return recipients.flatMap((p) =>
    candidatesFor(p, {
      kind: "reconnect",
      dedupeKey: dedupeKeys.reconnect(connectionId, now, p.userId),
      path: notificationPath("reconnect"),
      counts: {},
    }),
  );
}

/** Connections in `error`: asked again only after 24 hours. */
export async function connectionErrorCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  now: Date,
): Promise<Candidate[]> {
  const rows = await tx
    .select({ id: connection.id, connectedBy: connection.connectedBy })
    .from(connection)
    .where(and(eq(connection.tenantId, t.id), eq(connection.status, "error")));
  const out: Candidate[] = [];
  for (const c of rows) {
    if (await reconnectedRecently(tx, t.id, c.id, now)) continue;
    out.push(
      ...reconnectCandidates(await reconnectPeople(tx, t, people, c.connectedBy), c.id, now),
    );
  }
  return out;
}

// ── Lead messages ───────────────────────────────────────────────────────────────────────────────

/** How far back the pass looks for unread lead messages. */
const LEAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Lead-thread messages unread for 10 minutes: the lead's to client members (client-visible ones),
 * a client member's to the lead. One notification per person and newest unread message, counting
 * every unread one.
 */
// DECISION: a "lead message" is one a person posted (sender type `user`): from someone who isn't a
// member of the client's people, it is the lead side's and goes to the client's members; from a
// client member, it goes to the lead (`tenant.settings.lead.userId`; no lead, no notification).
export async function leadMessageCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  now: Date,
): Promise<Candidate[]> {
  const [lead] = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.tenantId, t.id),
        eq(thread.subjectType, LEAD_SUBJECT),
        eq(thread.subjectId, t.id),
      ),
    )
    .limit(1);
  if (!lead) return [];
  const msgs = await tx
    .select({
      id: message.id,
      senderId: message.senderId,
      audience: message.audience,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(
      and(
        eq(message.tenantId, t.id),
        eq(message.threadId, lead.id),
        eq(message.senderType, "user"),
        gte(message.createdAt, new Date(now.getTime() - LEAD_LOOKBACK_MS)),
        lte(message.createdAt, new Date(now.getTime() - LEAD_UNREAD_MS)),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id));
  if (msgs.length === 0) return [];
  const reads = await tx
    .select({ userId: threadRead.userId, lastReadAt: threadRead.lastReadAt })
    .from(threadRead)
    .where(and(eq(threadRead.tenantId, t.id), eq(threadRead.threadId, lead.id)));
  const lastRead = new Map(reads.map((r) => [r.userId, r.lastReadAt]));
  const members = new Set(people.map((p) => p.userId));

  const forPerson = (p: NotifyPerson, wanted: (m: (typeof msgs)[number]) => boolean) => {
    const since = lastRead.get(p.userId);
    const unread = msgs.filter(
      (m) => m.senderId !== p.userId && wanted(m) && (!since || m.createdAt > since),
    );
    const newest = unread[0];
    if (!newest) return [];
    return candidatesFor(p, {
      kind: "lead_message",
      dedupeKey: dedupeKeys.lead(newest.id, p.userId),
      path: notificationPath("lead_message", {
        clientId: t.id,
        forOperator: p.role === "operator",
      }),
      counts: { messages: unread.length },
    });
  };

  const out: Candidate[] = [];
  for (const p of people) {
    out.push(
      ...forPerson(
        p,
        (m) => m.audience === "client" && m.senderId !== null && !members.has(m.senderId),
      ),
    );
  }
  const leadId = leadUserId(t);
  const leadPerson = leadId ? await memberPerson(tx, t, leadId) : null;
  if (leadPerson && leadPerson.role === "operator") {
    out.push(...forPerson(leadPerson, (m) => m.senderId !== null && members.has(m.senderId)));
  }
  return out;
}

// ── Sign-off ────────────────────────────────────────────────────────────────────────────────────

/** Agents waiting for their go-live sign-off: the client admins, once per item. */
export async function signoffCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
): Promise<Candidate[]> {
  const agents = await tx
    .select({ stageState: agent.stageState })
    .from(agent)
    .where(and(eq(agent.tenantId, t.id), eq(agent.kind, "client"), eq(agent.stage, "signoff")));
  const itemIds = agents
    .map((a) => a.stageState.signoff?.inboxItemId)
    .filter((v): v is string => typeof v === "string");
  if (itemIds.length === 0) return [];
  const open = await tx
    .select({ id: inboxItem.id })
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, t.id),
        inArray(inboxItem.id, itemIds),
        eq(inboxItem.status, "open"),
      ),
    );
  const admins = people.filter((p) => p.role === "client_admin");
  return open.flatMap((i) =>
    admins.flatMap((p) =>
      candidatesFor(p, {
        kind: "signoff",
        dedupeKey: dedupeKeys.signoff(i.id, p.userId),
        path: notificationPath("signoff"),
        counts: {},
      }),
    ),
  );
}

/** Every candidate the pass finds for one client. */
export async function scanCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  now: Date,
): Promise<Candidate[]> {
  return [
    ...(await itemsWaitingCandidates(tx, t, people, now)),
    ...(await connectionErrorCandidates(tx, t, people, now)),
    ...(await leadMessageCandidates(tx, t, people, now)),
    ...(await signoffCandidates(tx, t, people)),
  ];
}
