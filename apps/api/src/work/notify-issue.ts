// The client hears back on its requests (docs/plan.md §1.123.1; docs/cases-plan.md B2): each reply
// from Mezonas on an issue's or ask's conversation (audience client) is an `issue_update` notice to
// the person who raised it, or to the client admins when nobody at the client did (an email from
// outside, the back office). Found by the notification pass like the lead thread's messages.

import { dedupeKeys, notificationPath } from "@countersign/core";
import { clientAsk, issue, message, type Tx } from "@countersign/db";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { Candidate } from "../notify/outbox";
import { candidatesFor } from "../notify/outbox";
import type { NotifyPerson, TenantRow } from "../notify/people";

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export async function issueUpdateCandidates(
  tx: Tx,
  t: TenantRow,
  people: NotifyPerson[],
  now: Date,
): Promise<Candidate[]> {
  const clientPeople = people.filter((p) => p.role !== "operator");
  const members = new Set(clientPeople.map((p) => p.userId));
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const msgs = await tx
    .select({
      id: message.id,
      threadId: message.threadId,
      senderId: message.senderId,
      senderType: message.senderType,
    })
    .from(message)
    .where(
      and(
        eq(message.tenantId, t.id),
        eq(message.audience, "client"),
        inArray(message.senderType, ["user", "agent"]),
        gte(message.createdAt, since),
      ),
    )
    .limit(500);
  // Ours: a person who isn't one of the client's, or Reggie.
  const ours = msgs.filter(
    (m) => m.senderType === "agent" || (m.senderId !== null && !members.has(m.senderId)),
  );
  if (ours.length === 0) return [];
  const threads = [...new Set(ours.map((m) => m.threadId))];
  const subjects = [
    ...(await tx
      .select({
        id: issue.id,
        threadId: issue.threadId,
        raisedBy: issue.raisedBy,
        source: issue.source,
      })
      .from(issue)
      .where(and(eq(issue.tenantId, t.id), inArray(issue.threadId, threads)))),
    ...(await tx
      .select({
        id: clientAsk.id,
        threadId: clientAsk.threadId,
        raisedBy: clientAsk.raisedBy,
        source: clientAsk.source,
      })
      .from(clientAsk)
      .where(and(eq(clientAsk.tenantId, t.id), inArray(clientAsk.threadId, threads)))),
  ];
  const out: Candidate[] = [];
  for (const m of ours) {
    const s = subjects.find((x) => x.threadId === m.threadId);
    if (!s) continue;
    // §1.123.4: an issue that came by email is answered by email (backoffice/outbound-email.ts).
    if (s.source === "email") continue;
    const raiser = s.raisedBy ? clientPeople.find((p) => p.userId === s.raisedBy) : undefined;
    const to = raiser ? [raiser] : clientPeople.filter((p) => p.role === "client_admin");
    for (const p of to) {
      out.push(
        ...candidatesFor(p, {
          kind: "issue_update",
          dedupeKey: dedupeKeys.issue(m.id, p.userId),
          path: notificationPath("issue_update", { requestId: s.id }),
          counts: { messages: 1 },
        }),
      );
    }
  }
  return out;
}
