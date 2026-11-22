// What became of an onboarding email (docs/plan.md §1.220, C7): Resend's webhook says an email was
// delivered or bounced. Each onboarding email carries two tags (`emails.ts`): the client and its
// outbox row. The event is applied only to that row, in that client, and only when the row is an
// onboarding email Resend sent under the event's id; anything else is acknowledged and dropped.
// What it is about is logged on the intake once per email and kind (`delivered`, `bounced`), and
// a bounce leaves the lead the same to-do as an email that didn't go out (`leaveUnsentTodo`), so
// they can send it again.

import {
  isHandledResendEvent,
  type ResendWebhookEvent,
  resendEventTags,
} from "@countersign/connectors";
import { intakePersonOfKey, isOnboardingNotificationKind, isUuid } from "@countersign/core";
import { type Db, intakeEvent, intakePerson, notification, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import {
  leaveUnsentTodo,
  ONBOARDING_TAG_NOTIFICATION,
  ONBOARDING_TAG_TENANT,
  onboardingEmailOf,
} from "./emails";

export interface DeliveryAnswer {
  handled: boolean;
  duplicate: boolean;
}

/** A bounce's kind as Resend names it (`Permanent`, `Transient`…), short; nothing else of it. */
const bounceWord = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z _-]{1,40}$/.test(v) ? v : undefined;

/** Applies one verified Resend event to the onboarding email it is about, if any. */
export async function applyResendEvent(
  db: Db,
  event: ResendWebhookEvent,
  now: Date = new Date(),
): Promise<DeliveryAnswer> {
  const none = { handled: false, duplicate: false };
  if (!isHandledResendEvent(event.type)) return none;
  const tags = resendEventTags(event);
  const tenantId = tags[ONBOARDING_TAG_TENANT];
  const notificationId = tags[ONBOARDING_TAG_NOTIFICATION];
  const emailId = event.data.email_id;
  if (!tenantId || !notificationId || !isUuid(tenantId) || !isUuid(notificationId)) return none;
  const kind = event.type === "email.bounced" ? "bounced" : "delivered";

  const applied = await withTenant(db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(notification)
      .where(and(eq(notification.id, notificationId), eq(notification.tenantId, tenantId)));
    if (!row || !isOnboardingNotificationKind(row.kind) || !onboardingEmailOf(row.kind)) {
      return null;
    }
    // DECISION: the row must be the one Resend sent under this id. A row with no provider id yet
    // (the event came before the send was settled) is matched by its tag alone: the event is
    // signed, and only we tag.
    if (row.providerId && row.providerId !== emailId) return null;
    const personId = intakePersonOfKey(row.dedupeKey);
    if (!personId) return null;
    const [person] = await tx
      .select({ id: intakePerson.id, intakeId: intakePerson.intakeId })
      .from(intakePerson)
      .where(and(eq(intakePerson.id, personId), eq(intakePerson.tenantId, tenantId)));
    if (!person) return null;
    // Once per email and kind: Resend retries a delivery until it is answered.
    const [seen] = await tx
      .select({ id: intakeEvent.id })
      .from(intakeEvent)
      .where(
        and(
          eq(intakeEvent.tenantId, tenantId),
          eq(intakeEvent.intakeId, person.intakeId),
          eq(intakeEvent.kind, kind),
          sql`${intakeEvent.meta} ->> 'notificationId' = ${notificationId}`,
        ),
      )
      .limit(1);
    if (seen) return { duplicate: true, row, person } as const;
    const bounce = event.data.bounce;
    const type = bounceWord(bounce?.type);
    const subType = bounceWord(bounce?.subType);
    await tx.insert(intakeEvent).values({
      tenantId,
      intakeId: person.intakeId,
      personId: person.id,
      kind,
      meta: {
        email: onboardingEmailOf(row.kind),
        notificationId,
        ...(type ? { bounceType: type } : {}),
        ...(subType ? { bounceSubType: subType } : {}),
      },
    });
    return { duplicate: false, row, person } as const;
  });
  if (!applied) return none;
  // DECISION: every bounce leaves the lead a to-do, a soft one too: Resend has already retried a
  // soft bounce before it says bounced, and the lead can send it again (§1.220).
  if (kind === "bounced" && !applied.duplicate) {
    await leaveUnsentTodo(db, {
      tenantId,
      intakeId: applied.person.intakeId,
      personId: applied.person.id,
      notificationId,
      kind: applied.row.kind,
      reason: "bounced",
      now,
    });
  }
  return { handled: true, duplicate: applied.duplicate };
}
