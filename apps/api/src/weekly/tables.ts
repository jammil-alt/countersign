// The Weekly Table (ARCHITECTURE §5.5 `weekly_table`, §11.4; docs/plan.md §1.37). Friday 17:00 in
// the client's time zone a draft is made so the lead can write the note, the decisions and next
// week; Monday 7:00 the stats are computed again for the week just ended, the row is marked
// `sent` and every member is told (client setting `weeklyDigest`). A sent table is not edited
// again (409 `sent`); its decisions take replies, posted in the lead thread (W1-C).

import {
  addDays,
  dedupeKeys,
  draftDueWeek,
  isUuid,
  notificationPath,
  sendDueWeek,
  uuidv7,
  type WeeklyEdit,
  WeeklySetup,
  WeeklyStats,
  type WeeklyTableView,
  weekBounds,
  weekStartOf,
} from "@countersign/core";
import {
  document,
  externalAction,
  inboxItem,
  run,
  type Tx,
  transaction,
  vendor,
  weeklyTable,
} from "@countersign/db";
import { type EmitPosted, leadThread, postMessage } from "@countersign/threads";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HttpError } from "../http";
import { candidatesFor, enqueue, type NotificationRow } from "../notify/outbox";
import { clientPeople, type TenantRow } from "../notify/people";
import type { Platform } from "../platform";
import { notificationsOf } from "../routes/onboarding";
import { setupItems, userName, weeklyStats } from "./stats";

export type WeeklyRow = typeof weeklyTable.$inferSelect;

export async function weeklyRow(
  tx: Tx,
  tenantId: string,
  weekStart: string,
): Promise<WeeklyRow | null> {
  const [row] = await tx
    .select()
    .from(weeklyTable)
    .where(and(eq(weeklyTable.tenantId, tenantId), eq(weeklyTable.weekStart, weekStart)));
  return row ?? null;
}

/** The table as both surfaces read it. */
export async function weeklyView(tx: Tx, row: WeeklyRow): Promise<WeeklyTableView> {
  return {
    id: row.id,
    weekStart: row.weekStart,
    status: row.status,
    stats: WeeklyStats.parse(row.stats),
    note: row.note,
    noteBy: row.noteBy ? { id: row.noteBy, name: await userName(tx, row.noteBy) } : null,
    decisions: row.decisions,
    nextWeek: row.nextWeek,
    setup: WeeklySetup.parse(row.setup),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A week the client existed in (it was set up before the week ended). */
function clientHad(t: TenantRow, weekStart: string): boolean {
  return t.createdAt < weekBounds(weekStart, t.timezone).to;
}

/** Makes the week's draft with its stats and setup so far; null if it exists already. */
export async function makeDraft(
  tx: Tx,
  t: TenantRow,
  platform: Platform,
  weekStart: string,
  now: Date,
): Promise<WeeklyRow | null> {
  const stats = await weeklyStats(tx, { tenantId: t.id, timezone: t.timezone, weekStart, now });
  const setup = await setupItems(tx, t.id, platform);
  const [row] = await tx
    .insert(weeklyTable)
    .values({ tenantId: t.id, weekStart, status: "draft", stats, setup })
    .onConflictDoNothing({ target: [weeklyTable.tenantId, weeklyTable.weekStart] })
    .returning();
  return row ?? null;
}

/**
 * Sends the week: stats and setup computed again, the row marked `sent` (made if no draft exists),
 * and a `weekly_table` notification queued for every member. Returns the new notification rows;
 * nothing when it was sent already.
 */
export async function sendWeek(
  tx: Tx,
  t: TenantRow,
  platform: Platform,
  weekStart: string,
  now: Date,
  origin: string,
): Promise<{ row: WeeklyRow; queued: NotificationRow[] } | null> {
  const existing = await weeklyRow(tx, t.id, weekStart);
  if (existing?.status === "sent") return null;
  const stats = await weeklyStats(tx, { tenantId: t.id, timezone: t.timezone, weekStart, now });
  const setup = await setupItems(tx, t.id, platform);
  const [row] = existing
    ? await tx
        .update(weeklyTable)
        .set({ status: "sent", stats, setup, sentAt: now })
        .where(and(eq(weeklyTable.id, existing.id), eq(weeklyTable.status, "draft")))
        .returning()
    : await tx
        .insert(weeklyTable)
        .values({ tenantId: t.id, weekStart, status: "sent", stats, setup, sentAt: now })
        .onConflictDoNothing({ target: [weeklyTable.tenantId, weeklyTable.weekStart] })
        .returning();
  if (!row) return null;
  if (!notificationsOf(t.settings).weeklyDigest) return { row, queued: [] };
  const people = await clientPeople(tx, t);
  const queued = await enqueue(
    tx,
    t.id,
    origin,
    people.flatMap((p) =>
      candidatesFor(p, {
        kind: "weekly_table",
        dedupeKey: dedupeKeys.weekly(weekStart, p.userId),
        path: notificationPath("weekly_table", { weekStart }),
        counts: { runs: stats.runs.done, changes: stats.changes.automatic + stats.changes.signed },
      }),
    ),
    now,
  );
  return { row, queued };
}

/**
 * The minute cron's check for one client: the draft from Friday 17:00, the send from Monday 7:00,
 * in its time zone. The Sandbox (no client people) and retired clients get none. Returns whether
 * anything was queued to send.
 */
export async function weeklyTick(
  tx: Tx,
  t: TenantRow,
  platform: Platform,
  now: Date,
  origin: string,
): Promise<boolean> {
  if (t.retiredAt || t.settings.sandbox === true) return false;
  const draft = draftDueWeek(now, t.timezone);
  if (draft && clientHad(t, draft) && !(await weeklyRow(tx, t.id, draft))) {
    await makeDraft(tx, t, platform, draft, now);
  }
  const due = sendDueWeek(now, t.timezone);
  if (!due || !clientHad(t, due)) return false;
  const sent = await sendWeek(tx, t, platform, due, now, origin);
  return (sent?.queued.length ?? 0) > 0;
}

// ── The lead's edits ────────────────────────────────────────────────────────────────────────────

/** Record ids a decision may cite: this client's runs, documents, transactions, vendors, items. */
// DECISION: a decision's sources are checked like an alert's (invariant 10): each must be the id
// of one of this client's runs, documents, transactions, vendors, inbox items or external actions.
async function unknownSources(tx: Tx, tenantId: string, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => isUuid(id));
  if (wanted.length === 0) return ids.filter((id) => !isUuid(id));
  const found = new Set<string>();
  for (const table of [run, document, transaction, vendor, inboxItem, externalAction] as const) {
    const rows = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), inArray(table.id, wanted)));
    for (const r of rows) found.add(r.id);
  }
  return ids.filter((id) => !found.has(id));
}

/**
 * The lead's note, decisions and next week. A week with no row yet gets its draft first (this
 * week or last week only). 409 `sent` once it has gone.
 */
// DECISION: the lead may start writing before Friday's draft: an edit to this week (or last week,
// until Monday's send) makes the draft then. Decisions keep their id, and a kept id keeps its reply.
export async function editWeek(
  tx: Tx,
  input: {
    t: TenantRow;
    platform: Platform;
    weekStart: string;
    body: WeeklyEdit;
    by: string;
    now: Date;
  },
): Promise<WeeklyRow> {
  const { t, weekStart, now } = input;
  let row = await weeklyRow(tx, t.id, weekStart);
  if (!row) {
    const current = weekStartOf(now, t.timezone);
    if (weekStart > current) {
      throw new HttpError(422, "future_week", "that week hasn't started yet");
    }
    if (weekStart !== current && weekStart !== addDays(current, -7)) {
      throw new HttpError(404, "not_found", "no weekly summary for that week");
    }
    row =
      (await makeDraft(tx, t, input.platform, weekStart, now)) ??
      (await weeklyRow(tx, t.id, weekStart));
    if (!row) throw new HttpError(409, "conflict", "try again");
  }
  if (row.status === "sent") throw new HttpError(409, "sent", "this week's summary was sent");
  const set: Partial<typeof weeklyTable.$inferInsert> = {};
  const body = input.body;
  if (body.note !== undefined) {
    set.note = body.note || null;
    set.noteBy = body.note ? input.by : null;
  }
  if (body.nextWeek !== undefined) set.nextWeek = body.nextWeek || null;
  if (body.decisions !== undefined) {
    const bad = await unknownSources(
      tx,
      t.id,
      body.decisions.flatMap((d) => d.sources),
    );
    if (bad.length > 0) {
      throw new HttpError(422, "unknown_sources", `not records of this client: ${bad.join(", ")}`);
    }
    const before = new Map(row.decisions.map((d) => [d.id, d]));
    set.decisions = body.decisions.map((d) => {
      const kept = d.id ? before.get(d.id) : undefined;
      return {
        id: kept?.id ?? uuidv7(),
        title: d.title,
        body: d.body,
        options: d.options,
        sources: d.sources,
        ...(kept?.reply ? { reply: kept.reply } : {}),
      };
    });
  }
  if (Object.keys(set).length === 0) return row;
  const [updated] = await tx
    .update(weeklyTable)
    .set(set)
    .where(and(eq(weeklyTable.id, row.id), eq(weeklyTable.status, "draft")))
    .returning();
  if (!updated) throw new HttpError(409, "sent", "this week's summary was sent");
  return updated;
}

/**
 * The client's answer to a decision of a sent table (ARCHITECTURE §11.4): a message in the
 * client's lead thread, linked from the decision's `reply` (who, when, the message). Returns the
 * message's id.
 */
// DECISION: one reply per decision (409 `replied` after; the conversation goes on in the lead
// thread). The text is posted as written, never read as a `/command`; the message's body names
// the week and decision, and the decision's sources go with it so the lead sees what it rests on.
export async function replyToDecision(
  tx: Tx,
  input: {
    tenantId: string;
    weekStart: string;
    decisionId: string;
    userId: string;
    text: string;
    now: Date;
    emitPosted?: EmitPosted | undefined;
  },
): Promise<string> {
  const [row] = await tx
    .select()
    .from(weeklyTable)
    .where(
      and(eq(weeklyTable.tenantId, input.tenantId), eq(weeklyTable.weekStart, input.weekStart)),
    )
    .for("update");
  // Drafts are the back office's: the client sees (and answers) sent tables only.
  if (row?.status !== "sent") throw new HttpError(404, "not_found", "weekly summary not found");
  const decision = row.decisions.find((d) => d.id === input.decisionId);
  if (!decision) throw new HttpError(404, "not_found", "decision not found");
  if (decision.reply) throw new HttpError(409, "replied", "this decision has its answer");
  const lead = await leadThread(tx, input.tenantId);
  if (lead.status !== "open") throw new HttpError(409, "closed", "this conversation is closed");
  const posted = await postMessage(
    tx,
    {
      tenantId: input.tenantId,
      thread: lead,
      senderType: "user",
      senderId: input.userId,
      kind: "text",
      body: {
        text: input.text,
        weeklyDecision: { weekStart: row.weekStart, decisionId: decision.id },
      },
      sources: decision.sources,
      audience: "client",
    },
    input.emitPosted,
  );
  const reply = { by: input.userId, at: input.now.toISOString(), messageId: posted.id };
  await tx
    .update(weeklyTable)
    .set({ decisions: row.decisions.map((d) => (d.id === decision.id ? { ...d, reply } : d)) })
    .where(and(eq(weeklyTable.id, row.id), eq(weeklyTable.tenantId, input.tenantId)));
  return posted.id;
}

/** A client's tables, newest first. */
export async function weeklyRows(
  tx: Tx,
  tenantId: string,
  input: { status?: "sent"; limit: number },
): Promise<WeeklyRow[]> {
  return tx
    .select()
    .from(weeklyTable)
    .where(
      and(
        eq(weeklyTable.tenantId, tenantId),
        ...(input.status ? [eq(weeklyTable.status, input.status)] : []),
      ),
    )
    .orderBy(desc(weeklyTable.weekStart))
    .limit(input.limit);
}
