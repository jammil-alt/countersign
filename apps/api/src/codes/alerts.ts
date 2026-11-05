// Alerts from the code service become inbox items (ARCHITECTURE §6.9): a code nobody asked for or a
// password-reset message for an agent identity means someone else may be trying that account, so
// the operator and the client admin each get an item. Run by the every-minute cron, one client at a
// time, inside that client's withTenant() scope.

import type { CodeAlert, CodeAlertKind } from "@countersign/core";
import { type Db, inboxItem, withTenant } from "@countersign/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CodesClient } from "./client";

/** `inbox_item.subject_type` of a code service alert; `subject_id` is the alert's id. */
export const CODE_ALERT_SUBJECT = "code_alert";
/** How far back a client's first read looks (the code service keeps alerts 30 days). */
export const FIRST_READ_DAYS = 30;
/**
 * Each read starts this long before the newest alert already raised: an alert written by one
 * identity while another's newer one was being read is still picked up (duplicates are skipped).
 */
const OVERLAP_MS = 5 * 60_000;
const ROLES = ["operator", "client_admin"] as const;

const TITLES: Record<CodeAlertKind, (label: string) => string> = {
  unsolicited_code: (label) => `Unexpected sign-in code for ${label}`,
  reset_attempt: (label) => `Password reset message for ${label}`,
  unexpected_message: (label) => `Unexpected message for ${label}`,
};

const EXPLAIN: Record<CodeAlertKind, string> = {
  unsolicited_code:
    "A sign-in code arrived when none of our agents was signing in. Someone else may be trying this account. We did not use the code.",
  reset_attempt:
    "A password reset message arrived for this agent account. Someone else may be trying to take it over. We did not open any link.",
  unexpected_message:
    "A message arrived for this agent account when none was expected. We kept only who sent it.",
};

/**
 * Reads the client's alerts since the newest one already in its inbox and raises an item for the
 * operator and one for the client admin per alert. Safe to run twice: an alert that already has
 * its item for a role gets no second one. Answers how many items were made.
 */
// DECISION: kind `review` (no migration: inbox kinds are a checked list) with subject type
// `code_alert` and the alert's id as subject; the payload holds metadata only (who sent it, how,
// when), never a code or message text.
export async function raiseCodeAlerts(
  db: Db,
  codes: CodesClient,
  tenantId: string,
  now: Date,
): Promise<number> {
  const [last] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ at: sql<string | null>`max(${inboxItem.payload}->'alert'->>'createdAt')` })
      .from(inboxItem)
      .where(and(eq(inboxItem.tenantId, tenantId), eq(inboxItem.subjectType, CODE_ALERT_SUBJECT))),
  );
  const since = new Date(
    last?.at ? Date.parse(last.at) - OVERLAP_MS : now.getTime() - FIRST_READ_DAYS * 86_400_000,
  ).toISOString();
  const { alerts } = await codes.alerts({ tenantId, since });
  const mine = alerts.filter((a) => a.tenantId === tenantId);
  if (mine.length === 0) return 0;
  return withTenant(db, tenantId, async (tx) => {
    const existing = await tx
      .select({ subjectId: inboxItem.subjectId, role: inboxItem.assigneeRole })
      .from(inboxItem)
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.subjectType, CODE_ALERT_SUBJECT),
          inArray(
            inboxItem.subjectId,
            mine.map((a) => a.id),
          ),
        ),
      );
    const have = new Set(existing.map((e) => `${e.subjectId}:${e.role}`));
    let made = 0;
    for (const alert of mine) {
      for (const role of ROLES) {
        if (have.has(`${alert.id}:${role}`)) continue;
        await tx.insert(inboxItem).values({
          tenantId,
          kind: "review",
          subjectType: CODE_ALERT_SUBJECT,
          subjectId: alert.id,
          assigneeRole: role,
          title: TITLES[alert.kind](alert.identityLabel).slice(0, 200),
          payload: {
            kind: CODE_ALERT_SUBJECT,
            explanation: EXPLAIN[alert.kind],
            alert: view(alert),
          },
        });
        made++;
      }
    }
    return made;
  });
}

/** The alert as kept in the inbox: metadata only. */
function view(a: CodeAlert) {
  return {
    id: a.id,
    kind: a.kind,
    identityId: a.identityId,
    identityLabel: a.identityLabel,
    channel: a.channel,
    sender: a.sender,
    receivedAt: a.receivedAt,
    createdAt: a.createdAt,
  };
}
