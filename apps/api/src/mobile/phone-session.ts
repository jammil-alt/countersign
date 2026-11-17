// The phone app's sessions (docs/plan.md §1.116; audit 5.2). A session handed to the app is marked
// in its sealed data (`Session.phone`, with when it signed in). Removing one of the person's phones
// writes a `mobile.phone_removed` audit row; from then on every phone session of that person which
// signed in before it is refused on its next request, in any of their clients (`mount`, the session
// route and the sign-in step's routes all ask `phoneEndedForPerson`).

import type { Session } from "@countersign/auth";
import { auditEvent, type Db, type Tx, userMemberships, withTenants } from "@countersign/db";
import { and, eq, gt, inArray } from "drizzle-orm";

/** What the phone check needs of a session: its phone mark, if any, and whose it is. */
export interface PhoneSessionOf {
  readonly phone?: Session["phone"];
  readonly user: { readonly id: string };
}

/** The audit row a removed phone leaves; phone sessions signed in before it are over. */
export const PHONE_REMOVED_ACTION = "mobile.phone_removed";

/**
 * Whether this phone session was ended by a phone removed since it signed in. Runs in the
 * request's own scope (the audit rows of its clients only); false for a browser's session.
 */
// DECISION: every phone session of the person signed in before the removal ends,
// not only the one on the removed phone. A phone that is already set up signs in again without
// registering (apps/mobile), so the server can't tell which phone a later session is on; ending
// them all is the safe superset, and each other phone signs in again with the second step.
// DECISION: the mark is an append-only audit row, not a setting: nothing a person can edit undoes
// it, and it is read by the actor index over at most one session's 12 hours.
export async function phoneSessionEnded(
  tx: Tx,
  tenantIds: readonly string[],
  session: PhoneSessionOf,
): Promise<boolean> {
  if (!session.phone || tenantIds.length === 0) return false;
  const [row] = await tx
    .select({ id: auditEvent.id })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.actorUserId, session.user.id),
        gt(auditEvent.createdAt, new Date(session.phone.signedInAt * 1000)),
        eq(auditEvent.action, PHONE_REMOVED_ACTION),
        inArray(auditEvent.tenantId, [...tenantIds]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether this phone session was ended by a phone the person removed in any of their clients
 * since it signed in. Its own short reads (the person's clients, then their audit rows), outside any
 * request transaction; false at once for a browser's session.
 */
// DECISION: across every client of the person, not only the client a request names: the session
// is the person's, and a phone removed in one client must not keep working in another.
export async function phoneEndedForPerson(db: Db, session: PhoneSessionOf): Promise<boolean> {
  if (!session.phone) return false;
  const ids = (await userMemberships(db, session.user.id)).map((m) => m.tenantId);
  if (ids.length === 0) return false;
  return withTenants(db, ids, (tx) => phoneSessionEnded(tx, ids, session));
}

/** What a request of an ended phone session is told. */
export const PHONE_ENDED_MESSAGE = "this phone was removed: sign in again";

/** How recently a session must have signed in, or passed its second step, to add a signing key. */
export const KEY_ENROL_FRESH_SEC = 10 * 60;

/**
 * Adding a phone's signing key (audit 5.2): while the second step is on, only a session that
 * signed in or passed the step in the last KEY_ENROL_FRESH_SEC may, so a session taken later
 * can't put its own key on the person's name.
 */
// DECISION: the phone app registers its key right after signing in (apps/mobile setup), well
// inside ten minutes; an older session is asked to sign in again. With the step off (or the dev
// sign-in) a session carries no step, and nothing more is asked than before.
export function keyEnrolRefusal(
  session: Pick<Session, "secondFactor" | "provedAt">,
  now: Date,
): string | null {
  if (session.secondFactor === undefined) return null;
  const proved = session.provedAt ?? 0;
  if (Math.floor(now.getTime() / 1000) - proved <= KEY_ENROL_FRESH_SEC) return null;
  return "sign in again to add this phone's signing key";
}
