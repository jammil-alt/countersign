// Wave 2c (ARCHITECTURE §10.14 "Notify"; docs/plan.md §1.86): an urgent notice's "Seen" card is
// told to its person at once, whatever the hours (quiet hours and business hours included), by
// email and by text where they have a number that may be texted. Like every notification
// (ARCHITECTURE §11.3) it is the kind's fixed sentence, a count and one link, never the notice's
// own words: the card in the inbox carries those. Every query runs inside the caller's withTenant
// for the item's client (invariant 1).
//
// Work plan C4.10 (migration 0079): it goes through the notification outbox as a kind of its own,
// `urgent`, so each send has its row (retries, the notification counts, once per person and
// channel by its key). The notify step queues the rows here and sends them at once
// (`sendQueued` with their ids); a send that fails is tried again by the outbox's next pass.

import { dedupeKeys, notificationPath } from "@countersign/core";
import type { inboxItem, Tx } from "@countersign/db";
import { type Candidate, enqueue } from "./outbox";
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
 * Queues an urgent notice's Seen card for the people it is for: an email to each, and a text to
 * each who has a number that may be texted (consent given, no STOP). Each (person, channel) is
 * queued once by its key (`urgent:<item>:<person>`), so a retried step queues nothing twice.
 * Returns the ids of the rows this call wrote, for the caller to send once it commits.
 */
// DECISION (C4.10): the same channels as the direct sends had, email and text, not phone
// notifications: what changes is the path (the outbox), not who is told or how. Urgent means at
// once: neither quiet hours (`holdsInQuietHours`) nor the person's own email or text switches
// (`overridesSwitches`) hold it; their consent for texts does. An email is queued even where
// Mezonas sends none (no Resend key): the row is skipped `not_configured`, and counted.
export async function queueUrgent(
  tx: Tx,
  origin: string,
  item: ItemRow,
  now: Date,
): Promise<string[]> {
  const candidates: Candidate[] = [];
  for (const person of await peopleOf(tx, item)) {
    const base = {
      userId: person.userId,
      kind: "urgent" as const,
      dedupeKey: dedupeKeys.urgent(item.id, person.userId),
      path: notificationPath("urgent"),
      counts: { items: 1 },
    };
    candidates.push({ ...base, contactId: null, channel: "email" });
    if (person.phone) candidates.push({ ...base, contactId: person.contactId, channel: "sms" });
  }
  const rows = await enqueue(tx, item.tenantId, origin, candidates, now);
  return rows.map((r) => r.id);
}
