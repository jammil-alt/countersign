// Wave 2c (ARCHITECTURE §10.14 "Notify"; docs/plan.md §1.86): an urgent notice's "Seen" card is
// told to its person at once, whatever the hours (quiet hours and business hours included), by
// email and by text where they have a number that may be texted. Like every notification
// (ARCHITECTURE §11.3) it is the kind's fixed sentence, a count and one link, never the notice's
// own words: the card in the inbox carries those. Every query runs inside the caller's withTenant
// for the item's client (invariant 1).

import {
  isPlainObject,
  type NotificationChannel,
  notificationLink,
  notificationPath,
  renderNotification,
} from "@countersign/core";
import { inboxItem, type Tx } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import type { NotifyDeps } from "./outbox";
import { clientPeople, memberPerson, type NotifyPerson, tenantRow } from "./people";

type ItemRow = typeof inboxItem.$inferSelect;

/** Who an item is told to: its person, or everyone who may answer for its role. */
async function peopleOf(tx: Tx, item: ItemRow): Promise<NotifyPerson[]> {
  const t = await tenantRow(tx, item.tenantId);
  if (!t || t.retiredAt) return [];
  if (item.assigneeUserId) {
    const p = await memberPerson(tx, t, item.assigneeUserId);
    return p ? [p] : [];
  }
  // DECISION: an operator's card with no person named is the back office's to see; nobody of
  // Mezonas is texted for it (the lead is named when it is theirs).
  if (item.assigneeRole === "operator") return [];
  const role = item.assigneeRole ?? "client_admin";
  return (await clientPeople(tx, t)).filter(
    (p) => p.canSign && (p.role === role || (role === "client_user" && p.role === "client_admin")),
  );
}

/**
 * Tells the people an urgent notice's Seen card is for, now: email, and a text where the person
 * has a number that may be texted (consent given, no STOP). Each (person, channel) is told once,
 * kept on the card (`payload.toldAt`), so a retried step sends nothing twice. A send that fails is
 * reported and left: the card stays in their inbox, and the outbox's items-waiting pass tells
 * them as it tells any open card. Returns how many were sent.
 */
// DECISION (wave 2c): sent from the notify step itself, through the outbox's own email and text
// senders, rather than as a new notification kind: that needs a migration of `notification`'s kind
// check, which this stream leaves out (docs/open.md). Urgent means at once: neither the person's
// quiet hours nor their own email or text switches hold it; their consent for texts does.
export async function tellUrgentNow(
  tx: Tx,
  deps: NotifyDeps,
  item: ItemRow,
  now: Date,
): Promise<number> {
  const payload = isPlainObject(item.payload) ? item.payload : {};
  const toldAt: Record<string, string> = isPlainObject(payload.toldAt)
    ? { ...(payload.toldAt as Record<string, string>) }
    : {};
  const link = notificationLink(deps.origin, notificationPath("items_waiting"));
  let from: string | null | undefined;
  let sent = 0;
  for (const person of await peopleOf(tx, item)) {
    const channels: NotificationChannel[] = [];
    if (deps.mailer.isConfigured) channels.push("email");
    if (person.phone) channels.push("sms");
    for (const channel of channels) {
      const key = `${person.userId}:${channel}`;
      if (toldAt[key]) continue;
      const rendered = renderNotification({
        kind: "items_waiting",
        channel,
        counts: { items: 1 },
        link,
        locale: person.locale,
      });
      try {
        if (channel === "email") {
          await deps.mailer.send({
            to: person.email,
            subject: rendered.subject,
            text: rendered.text,
            ...(rendered.html ? { html: rendered.html } : {}),
            idempotencyKey: `urgent-${item.id}-${person.userId}`,
          });
        } else {
          if (from === undefined) from = await deps.texter.from(tx, item.tenantId);
          if (!from) continue;
          await deps.texter.send(tx, item.tenantId, {
            to: person.phone as string,
            body: rendered.text,
          });
        }
        toldAt[key] = now.toISOString();
        sent++;
      } catch (error) {
        // Logged without the message: it names the card and the channel, never content.
        reportHandled(`urgent notice ${item.id} (${channel}) failed to send`, error, {
          job: "notify",
          client: item.tenantId,
        });
      }
    }
  }
  if (sent > 0) {
    await tx
      .update(inboxItem)
      .set({ payload: { ...payload, toldAt } })
      .where(and(eq(inboxItem.id, item.id), eq(inboxItem.tenantId, item.tenantId)));
  }
  return sent;
}
