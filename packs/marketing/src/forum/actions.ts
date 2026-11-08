// §1.77: people's actions on the forum watch in the back office (docs/marketing-plan.md §11.3):
// add a thread for the watch to look at (`add-forum-thread`, any https link; a Hacker News link is
// kept as that HN item, so the watch never takes it twice), approve a reply draft naming who will
// post it under their own name, or reject it with a reason (`decide-forum-reply`), and mark an
// approved reply posted once that person has posted it by hand (`mark-forum-posted`). Never an
// agent's: agents only draft. Each runs in the client's own transaction.

import { type Db, membership, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineAction, PackRefusal } from "../pack";
import { forumReply, forumThread } from "../schema";

const HN_ITEM = /^https:\/\/news\.ycombinator\.com\/item\?id=(\d{1,12})(?:[&#].*)?$/;

export const AddForumThreadInput = z.strictObject({
  url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https:\/\/[^\s]+$/, "an https link"),
  title: z.string().trim().min(1).max(500),
});

/** A thread's source and id from its link: an HN item by its id, anything else by its link. */
export function threadKey(url: string): { source: "hackernews" | "pasted"; externalId: string } {
  const hn = HN_ITEM.exec(url);
  if (hn?.[1]) return { source: "hackernews", externalId: hn[1] };
  // DECISION (§1.77): another forum's thread is kept by its link without the fragment (F7: a
  // person can paste any thread); the watch itself reads Hacker News only.
  return { source: "pasted", externalId: url.split("#")[0] ?? url };
}

export async function addForumThread(
  db: Db,
  ctx: { tenantId: string; userId: string; input: z.infer<typeof AddForumThreadInput> },
) {
  const { source, externalId } = threadKey(ctx.input.url);
  const url =
    source === "hackernews" ? `https://news.ycombinator.com/item?id=${externalId}` : externalId;
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: forumThread.id })
      .from(forumThread)
      .where(
        and(
          eq(forumThread.tenantId, ctx.tenantId),
          eq(forumThread.source, source),
          eq(forumThread.externalId, externalId),
        ),
      );
    if (existing) {
      throw new PackRefusal("thread_exists", "That thread is already in the forum watch.");
    }
    const [row] = await tx
      .insert(forumThread)
      .values({
        tenantId: ctx.tenantId,
        source,
        externalId,
        url,
        title: ctx.input.title,
        addedByUserId: ctx.userId,
      })
      .returning();
    if (!row) throw new Error("the thread wasn't added");
    return { id: row.id, source, externalId, url, title: row.title };
  });
}

export const DecideForumReplyInput = z.discriminatedUnion("decision", [
  z.strictObject({
    replyId: z.uuid(),
    decision: z.literal("approve"),
    /** Who will post it, by hand, under their own name: a person of this client's. */
    posterUserId: z.uuid(),
  }),
  z.strictObject({
    replyId: z.uuid(),
    decision: z.literal("reject"),
    reason: z.string().trim().min(1).max(500),
  }),
]);

export async function decideForumReply(
  db: Db,
  ctx: { tenantId: string; userId: string; input: z.infer<typeof DecideForumReplyInput> },
) {
  const { input } = ctx;
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (input.decision === "approve") {
      // The poster is someone who works with this client (its team, or an operator serving it).
      const [member] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(
          and(eq(membership.tenantId, ctx.tenantId), eq(membership.userId, input.posterUserId)),
        );
      if (!member) {
        throw new PackRefusal("unknown_poster", "The poster must be a person of this client's.");
      }
    }
    const now = new Date();
    const [row] = await tx
      .update(forumReply)
      .set(
        input.decision === "approve"
          ? {
              status: "approved",
              posterUserId: input.posterUserId,
              decidedByUserId: ctx.userId,
              decidedAt: now,
            }
          : {
              status: "rejected",
              reason: input.reason,
              decidedByUserId: ctx.userId,
              decidedAt: now,
            },
      )
      .where(
        and(
          eq(forumReply.id, input.replyId),
          eq(forumReply.tenantId, ctx.tenantId),
          eq(forumReply.status, "waiting"),
        ),
      )
      .returning();
    if (!row) throw await refusalFor(db, ctx.tenantId, input.replyId, "waiting");
    return {
      id: row.id,
      status: row.status,
      posterUserId: row.posterUserId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  });
}

export const MarkForumPostedInput = z.strictObject({ replyId: z.uuid() });

export async function markForumPosted(
  db: Db,
  ctx: { tenantId: string; userId: string; input: z.infer<typeof MarkForumPostedInput> },
) {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .update(forumReply)
      .set({ status: "posted", postedAt: new Date() })
      .where(
        and(
          eq(forumReply.id, ctx.input.replyId),
          eq(forumReply.tenantId, ctx.tenantId),
          eq(forumReply.status, "approved"),
        ),
      )
      .returning();
    if (!row) throw await refusalFor(db, ctx.tenantId, ctx.input.replyId, "approved");
    return { id: row.id, status: row.status, postedAt: row.postedAt?.toISOString() ?? null };
  });
}

/** Why a reply couldn't move: not this client's (or none), or not in the state it must be in. */
async function refusalFor(
  db: Db,
  tenantId: string,
  replyId: string,
  needed: "waiting" | "approved",
): Promise<PackRefusal> {
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ status: forumReply.status })
      .from(forumReply)
      .where(and(eq(forumReply.id, replyId), eq(forumReply.tenantId, tenantId))),
  );
  if (!row) return new PackRefusal("unknown_reply", "There is no such reply draft.");
  return new PackRefusal(
    needed === "waiting" ? "already_decided" : "not_approved",
    needed === "waiting"
      ? `This reply was already ${row.status}.`
      : "Only an approved reply can be marked posted.",
  );
}

export const FORUM_ACTIONS = {
  "add-forum-thread": defineAction({
    input: AddForumThreadInput,
    run: async (db, ctx) => ({ thread: await addForumThread(db, ctx) }),
  }),
  "decide-forum-reply": defineAction({
    input: DecideForumReplyInput,
    run: async (db, ctx) => ({ reply: await decideForumReply(db, ctx) }),
  }),
  "mark-forum-posted": defineAction({
    input: MarkForumPostedInput,
    run: async (db, ctx) => ({ reply: await markForumPosted(db, ctx) }),
  }),
};
