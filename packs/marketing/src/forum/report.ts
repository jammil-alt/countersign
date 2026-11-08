// §1.77: the `forum` report (docs/marketing-plan.md §11.3), the back office's Forum screen: the
// replies waiting for a person (approve naming who posts it, or reject with a reason), the "To
// post" queue (approved, for that person to post by hand, then mark posted), the threads the
// watch looked at and passed over or a person added, and the client's people a reply can be
// given to. Thread titles and replies are the forum's and the agent's words: shown as text, never
// as markup. One client's threads only (invariant 1).

import { appUser, membership, type Tx } from "@countersign/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { defineReport } from "../pack";
import { FORUM_REPLY_STATUSES, FORUM_SOURCES, forumReply, forumThread } from "../schema";

export const ForumQuery = z.strictObject({
  /** Only replies in this state; absent, every state. */
  status: z.enum(FORUM_REPLY_STATUSES).optional(),
  source: z.enum(FORUM_SOURCES).optional(),
});
export type ForumQuery = z.infer<typeof ForumQuery>;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export async function forumReport(tx: Tx, tenantId: string, q: ForumQuery) {
  const threads = await tx
    .select()
    .from(forumThread)
    .where(
      and(
        eq(forumThread.tenantId, tenantId),
        q.source ? eq(forumThread.source, q.source) : undefined,
      ),
    )
    .orderBy(desc(forumThread.seenAt))
    .limit(200);
  const replies = threads.length
    ? await tx
        .select()
        .from(forumReply)
        .where(
          and(
            eq(forumReply.tenantId, tenantId),
            inArray(
              forumReply.threadId,
              threads.map((t) => t.id),
            ),
            q.status ? eq(forumReply.status, q.status) : undefined,
          ),
        )
        .orderBy(desc(forumReply.createdAt))
    : [];
  const people = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email, role: membership.role })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(eq(membership.tenantId, tenantId))
    .orderBy(appUser.name);
  const nameOf = (u: string | null) => {
    if (!u) return null;
    const p = people.find((x) => x.id === u);
    return p ? p.name || p.email : null;
  };
  const threadOf = (id: string) => threads.find((t) => t.id === id);
  const replyRows = replies.map((r) => {
    const t = threadOf(r.threadId);
    return {
      id: r.id,
      status: r.status,
      body: r.body,
      createdAt: iso(r.createdAt),
      poster: r.posterUserId ? { id: r.posterUserId, name: nameOf(r.posterUserId) } : null,
      decidedBy: nameOf(r.decidedByUserId),
      decidedAt: iso(r.decidedAt),
      postedAt: iso(r.postedAt),
      reason: r.reason,
      runId: r.runId,
      thread: t
        ? { id: t.id, source: t.source, url: t.url, title: t.title, externalId: t.externalId }
        : null,
    };
  });
  const replied = new Set(replies.map((r) => r.threadId));
  return {
    waiting: replyRows.filter((r) => r.status === "waiting"),
    toPost: replyRows.filter((r) => r.status === "approved"),
    done: replyRows.filter((r) => r.status === "posted" || r.status === "rejected").slice(0, 50),
    threads: threads
      .filter((t) => !replied.has(t.id))
      .slice(0, 100)
      .map((t) => ({
        id: t.id,
        source: t.source,
        url: t.url,
        title: t.title,
        seenAt: iso(t.seenAt),
        outcome: t.outcome,
        addedBy: nameOf(t.addedByUserId),
        byAgent: t.agentVersionId !== null,
      })),
    people: people.map((p) => ({ id: p.id, name: p.name || p.email, role: p.role })),
    counts: {
      waiting: replyRows.filter((r) => r.status === "waiting").length,
      toPost: replyRows.filter((r) => r.status === "approved").length,
      threads: threads.length,
    },
  };
}

const cell = (v: string | null) => {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const FORUM_REPORT = defineReport({
  title: "Forum",
  query: ForumQuery,
  json: (tx, tenantId, _today, q) => forumReport(tx, tenantId, q),
  csv: async (tx, tenantId, _today, q) => {
    const f = await forumReport(tx, tenantId, q);
    const rows = [
      ["status", "thread", "url", "poster", "created_at", "posted_at"],
      ...[...f.waiting, ...f.toPost, ...f.done].map((r) => [
        r.status,
        r.thread?.title ?? "",
        r.thread?.url ?? "",
        r.poster?.name ?? "",
        r.createdAt ?? "",
        r.postedAt ?? "",
      ]),
    ];
    return `${rows.map((r) => r.map(cell).join(",")).join("\n")}\n`;
  },
});
