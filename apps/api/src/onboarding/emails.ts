// The onboarding emails (docs/cases-plan.md §4.4; docs/plan.md §1.125): the invite, a colleague
// asked, a few more questions. Each is written to the notifications outbox (§1.37) in the caller's
// transaction as its own kind (`intake_invite`, `intake_colleague`, `intake_more_questions`;
// migration 0064), once per person and email (the dedupe key), and sent after the commit by the
// notification pass: rendered then in the person's language from the intake and its person (core
// `renderInviteEmail`…), from `<Lead> at Mezonas <hello@…>` with Reply-To the lead's own address,
// through the mailer with the row's id as the idempotency key; `skipped` without Resend, as today.
// Delivery and bounces are logged on the intake (`intake_event`). No open-tracking pixels.
//
// Stream EMAIL builds this (cases-plan O1); until then it throws.

import type { Tx } from "@countersign/db";
import type { Bindings } from "../env";
import { notBuilt } from "./not-built";

export type OnboardingEmailKind = "invite" | "colleague" | "more_questions";

/** The notification kind each email is written as (packages/db ONBOARDING_NOTIFICATION_KINDS). */
export const ONBOARDING_EMAIL_NOTIFICATION: Record<OnboardingEmailKind, string> = {
  invite: "intake_invite",
  colleague: "intake_colleague",
  more_questions: "intake_more_questions",
};

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
      /** Invite's "Send at": written `scheduled`, sent by the pass from then. */
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
    });

export interface OnboardingEmailDeps {
  /** The caller's transaction, scoped to the email's client. */
  tx: Tx;
  env: Bindings;
}

export interface OnboardingEmailQueued {
  /** The outbox row; null when nothing was written (already queued for this person). */
  notificationId: string | null;
  status: "queued" | "scheduled" | "skipped";
}

/** Queues one onboarding email in the caller's transaction; the notification pass sends it. */
// Stream EMAIL builds this.
export async function sendOnboardingEmail(
  _deps: OnboardingEmailDeps,
  _email: OnboardingEmail,
): Promise<OnboardingEmailQueued> {
  throw notBuilt("EMAIL", "sendOnboardingEmail");
}
