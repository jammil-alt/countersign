// Threads over the database (ARCHITECTURE §11.2; docs/plan.md §1.38): finding or opening the lead,
// agent and account threads, listing them with what is unread, posting, and read state. Every
// function takes the caller's transaction, already scoped to the client(s) by RLS, and also names
// the client in its queries (invariant 1). Posting emits `thread.message_posted` in the same
// transaction (ids only, never the text).

import type {
  JsonObject,
  MessageAudience,
  PostedCommand,
  ThreadMessagePostedPayload,
} from "@countersign/core";
import { message, type Tx, thread, threadRead } from "@countersign/db";
import { and, asc, desc, eq, inArray, lt, ne, or, type SQL, sql } from "drizzle-orm";

export type ThreadRow = typeof thread.$inferSelect;
export type MessageRow = typeof message.$inferSelect;

/** One emitted `thread.message_posted`, in the poster's transaction. */
export interface MessagePostedEvent {
  tenantId: string;
  type: "thread.message_posted";
  subjectType: "thread";
  subjectId: string;
  payload: ThreadMessagePostedPayload;
}

/**
 * Emits the event in `tx`. apps/api passes packages/senses' `emit` (and collects the row to
 * dispatch after commit); the agents' port passes the runtime's emitter, which emits nothing for
 * a test run.
 */
export type EmitPosted = (tx: Tx, event: MessagePostedEvent) => Promise<void>;

// ── Finding and opening threads ─────────────────────────────────────────────────────────────────

const LEAD_TITLE = "Lead";

/**
 * The client's one lead thread, opened on first use. Safe under concurrency: the partial unique
 * index `thread_lead_key` lets one insert win, and the others read the winner.
 */
export async function leadThread(tx: Tx, tenantId: string): Promise<ThreadRow> {
  const found = await findLead(tx, tenantId);
  if (found) return found;
  await tx.execute(sql`
    insert into thread (tenant_id, subject_type, subject_id, title)
    values (${tenantId}, 'lead', ${tenantId}, ${LEAD_TITLE})
    on conflict (tenant_id) where subject_type = 'lead' do nothing`);
  const made = await findLead(tx, tenantId);
  if (!made) throw new Error("lead thread missing after insert");
  return made;
}

async function findLead(tx: Tx, tenantId: string): Promise<ThreadRow | undefined> {
  const [row] = await tx
    .select()
    .from(thread)
    .where(and(eq(thread.tenantId, tenantId), eq(thread.subjectType, "lead")));
  return row;
}

/**
 * A client agent's thread ("Message Pia"), opened on first use. One per agent: there is no unique
 * index, so opening takes a transaction lock on the (client, agent) pair first.
 */
// DECISION: an advisory lock instead of a unique index keeps migration 0021 to what §5.5 lists.
export async function agentThread(
  tx: Tx,
  tenantId: string,
  agent: { id: string; name: string },
): Promise<ThreadRow> {
  const where = and(
    eq(thread.tenantId, tenantId),
    eq(thread.subjectType, "agent"),
    eq(thread.subjectId, agent.id),
  );
  const [found] = await tx
    .select()
    .from(thread)
    .where(where)
    .orderBy(asc(thread.createdAt))
    .limit(1);
  if (found) return found;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`thread:agent:${tenantId}:${agent.id}`}, 0))`,
  );
  const [again] = await tx
    .select()
    .from(thread)
    .where(where)
    .orderBy(asc(thread.createdAt))
    .limit(1);
  if (again) return again;
  const [made] = await tx
    .insert(thread)
    .values({
      tenantId,
      subjectType: "agent",
      subjectId: agent.id,
      title: `Messages with ${agent.name}`.slice(0, 200),
    })
    .returning();
  if (!made) throw new Error("thread insert returned nothing");
  return made;
}

/** A new account thread (a conversation with Sloan), started by one person. Several per person. */
export async function startAccountThread(
  tx: Tx,
  tenantId: string,
  userId: string,
  // v0.17 (§10.15 "Talking to an owner"): a conversation with one of the client's area owners.
  owner?: { id: string; name: string },
): Promise<ThreadRow> {
  const [made] = await tx
    .insert(thread)
    .values({
      tenantId,
      subjectType: "account",
      subjectId: owner?.id ?? null,
      title: owner?.name ?? "Account",
      createdBy: userId,
    })
    .returning();
  if (!made) throw new Error("thread insert returned nothing");
  return made;
}

/** A thread of one of the given clients, or undefined. */
export async function findThread(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
): Promise<ThreadRow | undefined> {
  if (tenantIds.length === 0) return undefined;
  const [row] = await tx
    .select()
    .from(thread)
    .where(and(eq(thread.id, id), inArray(thread.tenantId, [...tenantIds])));
  return row;
}

export interface ListThreadsFilter {
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  /** Account threads only of this person (a client user's own conversations). */
  accountCreatedBy?: string | undefined;
  /** Only these subject types (the portal's kinds). */
  subjectTypes?: readonly string[] | undefined;
  limit?: number | undefined;
}

/** A client's threads, newest first. */
export async function listThreads(
  tx: Tx,
  tenantId: string,
  filter: ListThreadsFilter = {},
): Promise<ThreadRow[]> {
  const where: SQL[] = [eq(thread.tenantId, tenantId)];
  if (filter.subjectType) where.push(eq(thread.subjectType, filter.subjectType));
  if (filter.subjectId) where.push(eq(thread.subjectId, filter.subjectId));
  if (filter.subjectTypes) where.push(inArray(thread.subjectType, [...filter.subjectTypes]));
  if (filter.accountCreatedBy) {
    const own = or(
      ne(thread.subjectType, "account"),
      eq(thread.createdBy, filter.accountCreatedBy),
    );
    if (own) where.push(own);
  }
  return tx
    .select()
    .from(thread)
    .where(and(...where))
    .orderBy(desc(thread.createdAt), desc(thread.id))
    .limit(filter.limit ?? 500);
}

// ── Messages ────────────────────────────────────────────────────────────────────────────────────

export interface MessagePage {
  audiences: readonly MessageAudience[];
  /** Messages before this instant (older pages). */
  before?: Date | undefined;
  limit?: number | undefined;
}

/** A thread's messages the audiences may see, oldest first (the newest `limit` of them). */
export async function listMessages(
  tx: Tx,
  t: Pick<ThreadRow, "id" | "tenantId">,
  page: MessagePage,
): Promise<MessageRow[]> {
  const where: SQL[] = [
    eq(message.tenantId, t.tenantId),
    eq(message.threadId, t.id),
    inArray(message.audience, [...page.audiences]),
  ];
  if (page.before) where.push(lt(message.createdAt, page.before));
  const rows = await tx
    .select()
    .from(message)
    .where(and(...where))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(page.limit ?? 100);
  return rows.reverse();
}

/** The text a message shows: `body.text` when it is a string (people, agents, texts, notices). */
export function messageText(row: Pick<MessageRow, "body">): string {
  const text = (row.body as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

export interface PostInput {
  tenantId: string;
  thread: Pick<ThreadRow, "id" | "tenantId" | "subjectType" | "subjectId">;
  senderType: "user" | "agent" | "system";
  /** The user, or the agent (agents' messages also carry `agentVersionId`). */
  senderId: string | null;
  agentVersionId?: string | null | undefined;
  kind: "text" | "command";
  /** The command's resolved target, for a `command` message. */
  command?: PostedCommand | undefined;
  /** The message's body: at least `text`. */
  body: JsonObject & { text: string };
  sources: readonly string[];
  audience: MessageAudience;
}

/** Inserts the message and emits `thread.message_posted` in the same transaction. */
export async function postMessage(
  tx: Tx,
  input: PostInput,
  emitPosted?: EmitPosted,
): Promise<MessageRow> {
  if (input.thread.tenantId !== input.tenantId) throw new Error("the thread is another client's");
  const [row] = await tx
    .insert(message)
    .values({
      tenantId: input.tenantId,
      threadId: input.thread.id,
      senderType: input.senderType,
      senderId: input.senderId,
      agentVersionId: input.agentVersionId ?? null,
      kind: input.kind,
      command: input.command?.name ?? null,
      body: input.body,
      sources: [...input.sources],
      audience: input.audience,
    })
    .returning();
  if (!row) throw new Error("message insert returned nothing");
  if (emitPosted) {
    const payload: ThreadMessagePostedPayload = {
      threadId: input.thread.id,
      subjectType: input.thread.subjectType,
      subjectId: input.thread.subjectId,
      messageId: row.id,
      senderType: input.senderType,
      senderId: input.senderId,
      audience: input.audience,
      ...(input.command ? { command: input.command } : {}),
    };
    await emitPosted(tx, {
      tenantId: input.tenantId,
      type: "thread.message_posted",
      subjectType: "thread",
      subjectId: input.thread.id,
      payload,
    });
  }
  return row;
}

// ── Read state ──────────────────────────────────────────────────────────────────────────────────

/** Marks the thread read up to now for the person. The mark only moves forward. */
export async function markRead(
  tx: Tx,
  t: Pick<ThreadRow, "id" | "tenantId">,
  userId: string,
): Promise<void> {
  await tx
    .insert(threadRead)
    .values({ tenantId: t.tenantId, threadId: t.id, userId, lastReadAt: sql`now()` })
    .onConflictDoUpdate({
      target: [threadRead.threadId, threadRead.userId],
      set: { lastReadAt: sql`greatest(${threadRead.lastReadAt}, excluded.last_read_at)` },
    });
}

export interface ThreadActivity {
  /** Messages the person may see, newer than their read mark and not their own. */
  unread: number;
  lastMessageAt: Date | null;
}

/** Unread counts and last message times for the person, per thread of one client. */
export async function threadActivity(
  tx: Tx,
  tenantId: string,
  threadIds: readonly string[],
  userId: string,
  audiences: readonly MessageAudience[],
): Promise<Map<string, ThreadActivity>> {
  const out = new Map<string, ThreadActivity>();
  if (threadIds.length === 0) return out;
  const rows = await tx
    .select({
      threadId: message.threadId,
      last: sql<Date | string | null>`max(${message.createdAt})`,
      unread:
        sql<number>`count(*) filter (where (${threadRead.lastReadAt} is null or ${message.createdAt} > ${threadRead.lastReadAt}) and not (${message.senderType} = 'user' and ${message.senderId} is not distinct from ${userId}::uuid))`.mapWith(
          Number,
        ),
    })
    .from(message)
    .leftJoin(
      threadRead,
      and(
        eq(threadRead.threadId, message.threadId),
        eq(threadRead.tenantId, message.tenantId),
        eq(threadRead.userId, userId),
      ),
    )
    .where(
      and(
        eq(message.tenantId, tenantId),
        inArray(message.threadId, [...threadIds]),
        inArray(message.audience, [...audiences]),
      ),
    )
    .groupBy(message.threadId);
  for (const r of rows) {
    out.set(r.threadId, {
      unread: r.unread,
      lastMessageAt: r.last === null ? null : new Date(r.last),
    });
  }
  return out;
}
