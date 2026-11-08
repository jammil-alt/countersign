// Replies to reach-outs (docs/plan.md §1.25): a text or WhatsApp message from the contact, a call
// they spoke on, or an email reply ends the open reach-out it answers as `replied`; a STOP ends
// every open one to them as `opted_out`. The reply's words are untrusted data: kept on the
// reach-out and shown in the contact's thread, handed to later steps only as the step's output
// (never instructions, invariants 9 and 12). The run is then woken; the cron re-sends until it
// takes it.

import {
  forwardingOf,
  parseForwardingAddress,
  parseReplyEmail,
  sameAddress,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { isConverseSubject, type ReachChannel, type ReachReply } from "@countersign/core";
import {
  connection,
  contact,
  type Db,
  message,
  rawRecord,
  reachOut,
  type Tx,
  withTenant,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, desc, eq, ne } from "drizzle-orm";
import { type ContactRow, contactThread, type ThreadMessageBody } from "../messaging/contacts";
import { reportHandled } from "../observability/report";
import type { RunInstances } from "../runs/instances";
import { endReachOut, type ReachOutRow, reachOutEventType } from "./service";

interface Wake {
  id: string;
  runId: string;
}

async function openFor(tx: Tx, tenantId: string, contactId: string): Promise<ReachOutRow[]> {
  return tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.contactId, contactId),
        eq(reachOut.status, "open"),
      ),
    )
    .orderBy(desc(reachOut.updatedAt))
    .limit(20);
}

async function replyLine(tx: Tx, row: ReachOutRow, who: ContactRow, reply: ReachReply) {
  const threadId = await contactThread(tx, who);
  const body: ThreadMessageBody = {
    direction: "in",
    channel: reply.channel,
    text: reply.text || "Replied",
    sid: "",
    rawRecordId: reply.rawRecordId ?? "",
    status: "replied",
    reachOut: {
      id: row.id,
      runId: row.runId,
      agentVersionId: row.agentVersionId,
      sources: row.sources ?? [],
    },
  };
  await tx.insert(message).values({
    tenantId: who.tenantId,
    threadId,
    senderType: "contact",
    senderId: who.id,
    body: body as unknown as Record<string, unknown>,
    sources: [...(row.sources ?? []), ...(reply.rawRecordId ? [reply.rawRecordId] : [])],
  });
}

/** Ends `row` as replied with `reply`, writes the reply in the thread; null when already ended. */
export async function recordReply(
  tx: Tx,
  row: ReachOutRow,
  reply: ReachReply,
  now: Date,
): Promise<Wake | null> {
  const ended = await endReachOut(tx, row, { outcome: "replied", reply }, now);
  if (!ended) return null;
  const [who] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, row.tenantId)));
  if (who) await replyLine(tx, ended, who, reply);
  return { id: ended.id, runId: ended.runId };
}

async function rawText(tx: Tx, tenantId: string, id: unknown): Promise<string> {
  if (typeof id !== "string") return "";
  const [r] = await tx
    .select({ payload: rawRecord.payload })
    .from(rawRecord)
    .where(and(eq(rawRecord.id, id), eq(rawRecord.tenantId, tenantId)));
  const p = (r?.payload ?? {}) as { text?: unknown; summary?: unknown };
  const t = typeof p.text === "string" ? p.text : typeof p.summary === "string" ? p.summary : "";
  return t.slice(0, 4000);
}

/** One client's events: the replies and opt-outs among them, in that client's transaction. */
export async function matchReplies(
  db: Db,
  tenantId: string,
  events: readonly Pick<EventRow, "type" | "payload" | "tenantId">[],
  now: Date,
): Promise<Wake[]> {
  const relevant = events.filter(
    (e) =>
      e.tenantId === tenantId && (e.type === "message.received" || e.type === "call.completed"),
  );
  if (relevant.length === 0) return [];
  return withTenant(db, tenantId, (tx) => matchRepliesIn(tx, tenantId, relevant, now));
}

/** matchReplies inside the caller's transaction (the dispatcher's, which claimed the events). */
export async function matchRepliesIn(
  tx: Tx,
  tenantId: string,
  events: readonly Pick<EventRow, "type" | "payload" | "tenantId">[],
  now: Date,
): Promise<Wake[]> {
  const relevant = events.filter(
    (e) =>
      e.tenantId === tenantId && (e.type === "message.received" || e.type === "call.completed"),
  );
  const woken: Wake[] = [];
  for (const e of relevant) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const contactId = typeof p.contactId === "string" ? p.contactId : null;
    if (!contactId) continue;
    const open = await openFor(tx, tenantId, contactId);
    if (open.length === 0) continue;
    if (e.type === "message.received") {
      if (p.keyword === "stop") {
        // An opt-out stops everything at once.
        for (const row of open) {
          const ended = await endReachOut(
            tx,
            row,
            { outcome: "opted_out", reason: "the contact texted STOP" },
            now,
          );
          if (ended) woken.push({ id: ended.id, runId: ended.runId });
        }
        continue;
      }
      const channel = (p.channel === "whatsapp" ? "whatsapp" : "sms") as ReachChannel;
      // P-4: an open conversation message on the reply's channel takes it first (§1.66); else
      // the most recently updated open reach-out, as before.
      const talking = open.find(
        (r) =>
          isConverseSubject(r.subject) &&
          ((r.plan as { channels?: string[] } | null)?.channels ?? [])[0] === channel,
      );
      // DECISION (P-4): in a conversation, "YES" (an opt-in word) or "HELP" is also their answer
      // to the question asked; STOP still stops everything, above.
      if (p.keyword && !talking) continue;
      const row = (talking ?? open[0]) as ReachOutRow;
      const reply: ReachReply = {
        channel,
        text: await rawText(tx, tenantId, p.rawRecordId),
        untrusted: true,
        rawRecordId: typeof p.rawRecordId === "string" ? p.rawRecordId : null,
        at: now.toISOString(),
      };
      const w = await recordReply(tx, row, reply, now);
      if (w) woken.push(w);
      continue;
    }
    // call.completed: they spoke with the voice agent, on our call or theirs.
    if (p.outcome !== "answered") continue;
    const ours = open.find((r) =>
      ((r.attempts ?? []) as { ref?: string }[]).some((a) => a.ref === p.callSid),
    );
    const row = ours ?? (p.direction === "in" ? open[0] : undefined);
    if (!row) continue;
    const reply: ReachReply = {
      channel: "voice",
      text: await rawText(tx, tenantId, p.rawRecordId),
      untrusted: true,
      rawRecordId: typeof p.rawRecordId === "string" ? p.rawRecordId : null,
      at: now.toISOString(),
    };
    const w = await recordReply(tx, row, reply, now);
    if (w) woken.push(w);
  }
  return woken;
}

export async function wakeAll(instances: RunInstances | undefined, woken: readonly Wake[]) {
  if (!instances) return;
  for (const w of woken) {
    try {
      await instances.sendEvent(w.runId, {
        type: reachOutEventType(w.id),
        payload: { reachOutId: w.id },
      });
    } catch (error) {
      reportHandled(`waking run ${w.runId} for reach-out ${w.id} failed`, error, { job: "reach" });
    }
  }
}

// ── Email replies ───────────────────────────────────────────────────────────────────────────────

/** The client's forwarding address (its upload connection's), where reach-out replies come back. */
export async function forwardingAddress(tx: Tx, tenantId: string): Promise<string | null> {
  const [conn] = await tx
    .select()
    .from(connection)
    .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
    .orderBy(connection.createdAt)
    .limit(1);
  return conn ? (forwardingOf(conn).address ?? null) : null;
}

/**
 * An email to `<client forwarding address>+<tag>`: a reply to a reach-out email. Matched when the
 * tag names an open reach-out of that client and the sender is its contact (the envelope sender, or
 * the From header when DMARC passed). Returns null when it isn't one (the caller then treats it as
 * forwarded mail).
 */
export async function receiveReachOutReply(
  db: Db,
  mail: { from: string; to: string; raw: Uint8Array },
  options: {
    domain: string;
    now: Date;
    forwardingAddress: (tx: Tx, tenantId: string) => Promise<string | null>;
  },
): Promise<{ tenantId: string; woken: Wake[] } | null> {
  const to = mail.to.trim().toLowerCase();
  const plus = /^([^@+]+)\+([a-z0-9]{6,40})@(.+)$/.exec(to);
  if (!plus) return null;
  const target = parseForwardingAddress(to, options.domain);
  if (!target) return null;
  const tag = plus[2] as string;
  const bare = `${plus[1]}@${plus[3]}`;
  const parsed = await parseReplyEmail(mail.raw).catch(() => null);
  if (!parsed) return null;
  const woken = await withTenant(db, target.tenantId, async (tx) => {
    const stored = await options.forwardingAddress(tx, target.tenantId);
    if (!stored || !sameAddress(stored, bare)) return null;
    if (!/^[0-9a-f]{32}$/.test(tag)) return null;
    const id = `${tag.slice(0, 8)}-${tag.slice(8, 12)}-${tag.slice(12, 16)}-${tag.slice(16, 20)}-${tag.slice(20)}`;
    const [row] = await tx
      .select()
      .from(reachOut)
      .where(
        and(
          eq(reachOut.id, id),
          eq(reachOut.tenantId, target.tenantId),
          ne(reachOut.status, "ended"),
        ),
      );
    if (!row) return [];
    const [who] = await tx
      .select()
      .from(contact)
      .where(and(eq(contact.id, row.contactId), eq(contact.tenantId, target.tenantId)));
    const senders = [mail.from.toLowerCase()];
    if (parsed.from && parsed.dmarcPassFrom && parsed.from.endsWith(`@${parsed.dmarcPassFrom}`)) {
      senders.push(parsed.from);
    }
    // DECISION: only the contact's own address counts as their reply; anyone else writing to the
    // tagged address is dropped, so a stranger can't answer for them.
    if (!who?.email || !senders.includes(who.email.toLowerCase())) return [];
    const w = await recordReply(
      tx,
      row,
      {
        channel: "email",
        text: parsed.text,
        untrusted: true,
        rawRecordId: null,
        at: options.now.toISOString(),
      },
      options.now,
    );
    return w ? [w] : [];
  });
  if (woken === null) return null;
  return { tenantId: target.tenantId, woken };
}
