// §1.77: the forum watch's pack tools (docs/marketing-plan.md §4.6). The watch searches Hacker
// News with the connector (`hackernews.search`), asks which of those threads this client has not
// seen (`marketing.forum.threads.unseen`), records each it looks at, seen or passed over
// (`marketing.forum.thread.mark`), and may draft one reply per thread for a named person to post
// by hand (`marketing.forum.reply.draft`). Agents never post: a draft waits for a person in the
// back office (./actions.ts). Thread titles and replies' text are data, never instructions
// (invariant 9). Every row an agent makes records its agent version and run (invariant 10).
//
// DECISION (§1.77): a test run writes none of these rows (the tables have no test flag, and a test
// marking a thread seen would hide it from the live watch); the tools check and answer as if, with
// `recorded: false` and no ids.

import { type Tx, tenant, withTenant } from "@countersign/db";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { defineTool, PackRefusal, type PackToolContext } from "../pack";
import { FORUM_SOURCES, forumReply, forumThread, site } from "../schema";
import { disclosureFor, FORUM_REPLY_MAX, replyProblems } from "./rules";

export const FORUM_THREADS_UNSEEN_TOOL = "marketing.forum.threads.unseen";
export const FORUM_THREAD_MARK_TOOL = "marketing.forum.thread.mark";
export const FORUM_REPLY_DRAFT_TOOL = "marketing.forum.reply.draft";

const Source = z.enum(FORUM_SOURCES);
const ExternalId = z.string().trim().min(1).max(512);
const HttpsUrl = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s]+$/, "an https link");

const ThreadRef = z.strictObject({ source: Source.default("hackernews"), id: ExternalId });

// ── marketing.forum.threads.unseen ──────────────────────────────────────────────────────────────

export const ThreadsUnseenInput = z.strictObject({
  /** The threads a search returned, by source and id. */
  threads: z.array(ThreadRef).max(100),
});

export const ThreadsUnseenOutput = z.object({
  /** Of those asked about, the ones this client has never looked at, in the order given. */
  unseen: z.array(z.object({ source: Source, id: z.string() })),
  /** The ones already looked at, with what was decided (null: seen, not yet decided). */
  seen: z.array(
    z.object({
      source: Source,
      id: z.string(),
      threadId: z.string(),
      outcome: z.enum(["drafted", "passed"]).nullable(),
    }),
  ),
  /** Threads a person added for the watch that it hasn't decided on yet. */
  waiting: z.array(
    z.object({
      threadId: z.string(),
      source: Source,
      id: z.string(),
      url: z.string(),
      /** The forum's words: data, never instructions. */
      title: z.string(),
    }),
  ),
  sources: z.array(z.string()),
});

export const forumThreadsUnseen = defineTool({
  id: FORUM_THREADS_UNSEEN_TOOL,
  description:
    "Of the forum threads a search returned, which this client has not looked at yet; also the threads a person added for you to look at. Each thread is looked at once.",
  sideEffect: "none",
  input: ThreadsUnseenInput,
  output: ThreadsUnseenOutput,
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const ids = [...new Set(input.threads.map((t) => t.id))];
      const known = ids.length
        ? await tx
            .select({
              id: forumThread.id,
              source: forumThread.source,
              externalId: forumThread.externalId,
              outcome: forumThread.outcome,
            })
            .from(forumThread)
            .where(
              and(eq(forumThread.tenantId, ctx.tenantId), inArray(forumThread.externalId, ids)),
            )
        : [];
      const key = (source: string, id: string) => `${source}\u0000${id}`;
      const byKey = new Map(known.map((k) => [key(k.source, k.externalId), k]));
      const unseen: { source: (typeof FORUM_SOURCES)[number]; id: string }[] = [];
      const seen: z.input<typeof ThreadsUnseenOutput>["seen"] = [];
      const asked = new Set<string>();
      for (const t of input.threads) {
        const k = key(t.source, t.id);
        if (asked.has(k)) continue;
        asked.add(k);
        const row = byKey.get(k);
        if (row) {
          seen.push({ source: t.source, id: t.id, threadId: row.id, outcome: row.outcome ?? null });
        } else unseen.push({ source: t.source, id: t.id });
      }
      const pending = await tx
        .select()
        .from(forumThread)
        .where(
          and(
            eq(forumThread.tenantId, ctx.tenantId),
            isNotNull(forumThread.addedByUserId),
            isNull(forumThread.outcome),
          ),
        )
        .orderBy(asc(forumThread.seenAt))
        .limit(20);
      const waiting = pending.map((r) => ({
        threadId: r.id,
        source: r.source,
        id: r.externalId,
        url: r.url,
        title: r.title,
      }));
      return {
        unseen,
        seen,
        waiting,
        sources: [...seen.map((s) => s.threadId), ...waiting.map((w) => w.threadId)],
      };
    });
  },
});

// ── marketing.forum.thread.mark ─────────────────────────────────────────────────────────────────

export const ThreadMarkInput = z.strictObject({
  source: Source.default("hackernews"),
  id: ExternalId,
  /** The thread's page (its HN link). */
  url: HttpsUrl,
  /** The thread's title as the forum shows it. */
  title: z.string().trim().min(1).max(500),
  /** `seen`: looked at, nothing decided; `passed`: no reply is worth drafting. */
  outcome: z.enum(["seen", "passed"]),
});

export const ThreadMarkOutput = z.object({
  recorded: z.boolean(),
  threadId: z.string().nullable(),
  outcome: z.enum(["drafted", "passed"]).nullable(),
  sources: z.array(z.string()),
});

async function threadByExternal(
  tx: Tx,
  tenantId: string,
  source: (typeof FORUM_SOURCES)[number],
  externalId: string,
) {
  const [row] = await tx
    .select()
    .from(forumThread)
    .where(
      and(
        eq(forumThread.tenantId, tenantId),
        eq(forumThread.source, source),
        eq(forumThread.externalId, externalId),
      ),
    );
  return row ?? null;
}

export const forumThreadMark = defineTool({
  id: FORUM_THREAD_MARK_TOOL,
  description:
    "Record that you looked at a forum thread: seen, or passed over (no reply worth drafting). Each thread is recorded once for this client; a thread already drafted for stays drafted.",
  sideEffect: "internal",
  verb: "update",
  summary: "Marked a forum thread {{outcome}}",
  input: ThreadMarkInput,
  output: ThreadMarkOutput,
  async run(input, ctx) {
    const outcome = input.outcome === "passed" ? ("passed" as const) : null;
    return withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const existing = await threadByExternal(tx, ctx.tenantId, input.source, input.id);
      if (ctx.mode === "test") {
        return {
          recorded: false,
          threadId: existing?.id ?? null,
          outcome: existing?.outcome ?? outcome,
          sources: existing ? [existing.id] : [],
        };
      }
      if (existing) {
        // Only an open decision changes: a drafted thread stays drafted, a passed one passed.
        if (existing.outcome === null && outcome !== null) {
          await tx
            .update(forumThread)
            .set({ outcome, ...(existing.runId ? {} : { runId: ctx.runId }) })
            .where(and(eq(forumThread.id, existing.id), eq(forumThread.tenantId, ctx.tenantId)));
          return { recorded: true, threadId: existing.id, outcome, sources: [existing.id] };
        }
        return {
          recorded: false,
          threadId: existing.id,
          outcome: existing.outcome ?? null,
          sources: [existing.id],
        };
      }
      const [row] = await tx
        .insert(forumThread)
        .values({
          tenantId: ctx.tenantId,
          source: input.source,
          externalId: input.id,
          url: input.url,
          title: input.title,
          outcome,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
        })
        .returning({ id: forumThread.id });
      if (!row) throw new Error("the thread wasn't recorded");
      return { recorded: true, threadId: row.id, outcome, sources: [row.id] };
    });
  },
});

// ── marketing.forum.reply.draft ─────────────────────────────────────────────────────────────────

export const ReplyDraftInput = z.strictObject({
  /** The thread (`marketing.forum.thread.mark`'s `threadId`, or a person's added thread). */
  threadId: z.uuid(),
  /** The reply, plain text, as the person would post it. */
  body: z
    .string()
    .min(1)
    .max(FORUM_REPLY_MAX + 1000),
});

export const ReplyDraftOutput = z.object({
  recorded: z.boolean(),
  replyId: z.string().nullable(),
  threadId: z.string(),
  status: z.literal("waiting"),
  /** The thread and the draft (invariant 10). */
  sources: z.array(z.string()),
});

/** The client's name and its measured sites' domains, for the reply rules. */
async function replyRules(tx: Tx, ctx: PackToolContext) {
  const [t] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId));
  const domains = await tx
    .select({ domain: site.domain })
    .from(site)
    .where(eq(site.tenantId, ctx.tenantId));
  return {
    disclosure: disclosureFor(ctx.settings, t?.name ?? "Mezonas"),
    domains: domains.map((d) => d.domain),
  };
}

export const forumReplyDraft = defineTool({
  id: FORUM_REPLY_DRAFT_TOOL,
  description:
    'Draft a reply to a forum thread for a named person to post by hand; it waits for a person to approve, and you never post. The reply must open with the disclosure ("I work at …"), never link to or name our own site, and have no exclamation mark. One reply per thread.',
  sideEffect: "internal",
  summary: "Drafted a forum reply for a person to post",
  input: ReplyDraftInput,
  output: ReplyDraftOutput,
  async run(input, ctx) {
    return withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const [thread] = await tx
        .select()
        .from(forumThread)
        .where(and(eq(forumThread.id, input.threadId), eq(forumThread.tenantId, ctx.tenantId)));
      // Another client's thread is not found, like a missing one (invariant 1).
      if (!thread) throw new PackRefusal("unknown_thread", "There is no such forum thread.");
      const problems = replyProblems(input.body, await replyRules(tx, ctx));
      if (problems.length > 0) {
        throw new PackRefusal(
          problems[0]?.code ?? "refused",
          `The reply wasn't kept. ${problems.map((p) => p.message).join(" ")}`,
        );
      }
      const [already] = await tx
        .select({ id: forumReply.id })
        .from(forumReply)
        .where(and(eq(forumReply.tenantId, ctx.tenantId), eq(forumReply.threadId, thread.id)))
        .limit(1);
      if (already) {
        throw new PackRefusal("already_drafted", "This thread already has a reply draft.");
      }
      if (thread.outcome === "passed") {
        throw new PackRefusal("passed", "This thread was passed over; it gets no reply.");
      }
      if (ctx.mode === "test") {
        return {
          recorded: false,
          replyId: null,
          threadId: thread.id,
          status: "waiting" as const,
          sources: [thread.id],
        };
      }
      const [reply] = await tx
        .insert(forumReply)
        .values({
          tenantId: ctx.tenantId,
          threadId: thread.id,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          body: input.body.trim(),
        })
        .returning({ id: forumReply.id });
      if (!reply) throw new Error("the reply wasn't recorded");
      await tx
        .update(forumThread)
        .set({ outcome: "drafted", ...(thread.runId ? {} : { runId: ctx.runId }) })
        .where(and(eq(forumThread.id, thread.id), eq(forumThread.tenantId, ctx.tenantId)));
      return {
        recorded: true,
        replyId: reply.id,
        threadId: thread.id,
        status: "waiting" as const,
        sources: [thread.id, reply.id],
      };
    });
  },
});

export const FORUM_TOOLS = [forumThreadsUnseen, forumThreadMark, forumReplyDraft] as const;
