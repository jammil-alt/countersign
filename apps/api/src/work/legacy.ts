// Folding in (docs/plan.md §1.124.1; docs/cases-plan.md B4): a client's portal Feedback becomes an
// issue as it is sent, and what was raised before Build existed is adopted: every change request
// (§1.11) and every open portal Feedback item gets an issue, once (the unique `legacy_item_id` and
// `feedback_id`). The old rows are left as they are, so the previous Worker keeps working.
// DECISION: legacy rows are never changed; their issue carries the history from here on.

import { isUuid } from "@countersign/core";
import {
  activeClient,
  agent,
  appUser,
  type Db,
  feedback,
  inboxItem,
  issue,
  type Tx,
  tenant,
  withOperator,
} from "@countersign/db";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import { createIssue, type IssueRow, issueTitle, postOnThread } from "./issues";

type FeedbackRow = typeof feedback.$inferSelect;

/** The issue a portal Feedback item (or error report) becomes. */
export async function issueFromFeedback(
  tx: Tx,
  row: Pick<
    FeedbackRow,
    "id" | "tenantId" | "userId" | "comment" | "source" | "path" | "createdAt"
  >,
): Promise<IssueRow | null> {
  if (!row.tenantId) return null;
  const [made] = await tx.select().from(issue).where(eq(issue.feedbackId, row.id));
  if (made) return made;
  return createIssue(tx, {
    tenantId: row.tenantId,
    title: issueTitle(null, row.comment),
    description: `${row.comment}\n\nOn ${row.path}`.slice(0, 4000),
    source: row.source === "error_page" ? "error_report" : "feedback",
    raisedBy: row.userId,
    feedbackId: row.id,
    actor: "client",
    userId: row.userId,
    openingText: row.comment,
    now: row.createdAt,
  });
}

interface RequestPayload {
  text?: unknown;
  subject?: unknown;
  raisedBy?: unknown;
}

/** Adopts one client's change requests and open Feedback. Returns how many issues it made. */
export async function adoptLegacyFor(tx: Tx, tenantId: string): Promise<number> {
  let made = 0;
  const items = await tx
    .select()
    .from(inboxItem)
    .where(
      and(
        eq(inboxItem.tenantId, tenantId),
        eq(inboxItem.kind, "change_request"),
        notExists(
          tx.select({ one: sql`1` }).from(issue).where(eq(issue.legacyItemId, inboxItem.id)),
        ),
      ),
    )
    .limit(200);
  const raisers = items
    .map((i) => (i.payload as RequestPayload).raisedBy)
    .filter((v): v is string => typeof v === "string" && isUuid(v));
  const known = raisers.length
    ? new Set(
        (await tx.select({ id: appUser.id }).from(appUser).where(inArray(appUser.id, raisers))).map(
          (u) => u.id,
        ),
      )
    : new Set<string>();
  for (const item of items) {
    const p = item.payload as RequestPayload;
    const text = typeof p.text === "string" ? p.text : item.title;
    const raisedBy = typeof p.raisedBy === "string" && known.has(p.raisedBy) ? p.raisedBy : null;
    // The service it was about, kept as the issue's agent when it is still this client's.
    const [service] = item.agentId
      ? await tx
          .select({ id: agent.id })
          .from(agent)
          .where(
            and(eq(agent.id, item.agentId), eq(agent.tenantId, tenantId), eq(agent.kind, "client")),
          )
      : [];
    const row = await createIssue(tx, {
      tenantId,
      title: typeof p.subject === "string" && p.subject ? p.subject : item.title,
      description: text,
      agentId: service?.id ?? null,
      source: "legacy_request",
      raisedBy,
      legacyItemId: item.id,
      actor: "system",
      userId: null,
      openingText: text,
      now: item.createdAt,
    });
    if (item.status === "resolved") {
      const r = (item.resolution ?? {}) as { note?: unknown };
      const note = typeof r.note === "string" && r.note.trim() ? r.note.trim() : null;
      if (note) {
        await postOnThread(tx, {
          tenantId,
          threadId: row.threadId,
          senderType: item.resolvedBy ? "user" : "system",
          senderId: item.resolvedBy,
          text: note,
          audience: "client",
        });
      }
      const at = item.resolvedAt ?? new Date();
      await tx
        .update(issue)
        .set({
          stage: "closed",
          closedAt: at,
          stageAt: at,
          needsReadAt: null,
          firstReplyAt: note ? at : null,
        })
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, tenantId)));
    } else {
      // An open request already waited in the queue: Reggie reads it like a new one.
      await tx
        .update(issue)
        .set({ needsReadAt: new Date() })
        .where(and(eq(issue.id, row.id), eq(issue.tenantId, tenantId)));
    }
    made++;
  }
  const open = await tx
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.tenantId, tenantId),
        eq(feedback.status, "open"),
        notExists(tx.select({ one: sql`1` }).from(issue).where(eq(issue.feedbackId, feedback.id))),
      ),
    )
    .limit(200);
  for (const f of open) {
    if (await issueFromFeedback(tx, f)) made++;
  }
  return made;
}

/** The minute past each hour the adoption runs. */
export const ADOPT_MINUTE = 23;

/** Hourly from the cron: each live client's change requests and open Feedback, adopted. */
export async function adoptLegacy(db: Db, scheduledTime: Date): Promise<void> {
  if (scheduledTime.getUTCMinutes() !== ADOPT_MINUTE) return;
  const clients = await db.select({ id: tenant.id }).from(tenant).where(activeClient());
  for (const c of clients) {
    try {
      await withOperator(db, [c.id], (tx) => adoptLegacyFor(tx, c.id));
    } catch (error) {
      reportHandled(`adopting requests for client ${c.id} failed`, error, {
        job: "work_adopt",
        client: c.id,
      });
    }
  }
}
