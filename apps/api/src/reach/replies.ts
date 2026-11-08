// Replies to reach-outs (docs/plan.md §1.25): a text or WhatsApp message from the contact, a call
// they spoke on, or an email reply ends the open reach-out it answers as `replied`; a STOP ends
// every open one to them as `opted_out`. The reply's words are untrusted data: kept on the
// reach-out and shown in the contact's thread, handed to later steps only as the step's output
// (never instructions, invariants 9 and 12). The run is then woken; the cron re-sends until it
// takes it.

import {
  type ContentStore,
  forwardingOf,
  parseForwardedEmail,
  parseForwardingAddress,
  parseReplyEmail,
  type ReplyEmail,
  sameAddress,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  bytesMatchType,
  isConverseSubject,
  REPLY_DOCUMENTS_MAX,
  type ReachChannel,
  type ReachReply,
  type ReplyAttachmentRefusal,
  redactCardNumbers,
  uuidv7,
} from "@countersign/core";
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
import { DocumentError, storeDocument } from "@countersign/documents";
import type { EventRow } from "@countersign/senses";
import { and, desc, eq, ne } from "drizzle-orm";
import { type ContactRow, contactThread, type ThreadMessageBody } from "../messaging/contacts";
import { reportHandled } from "../observability/report";
import type { RunInstances } from "../runs/instances";
// P-3: attachments both ways
import { replyAttachments } from "./reply-media";
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
    sources: [
      ...(row.sources ?? []),
      ...(reply.rawRecordId ? [reply.rawRecordId] : []),
      // P-3: the documents it came with (a text's, once fetched, are on the reach-out's reply).
      ...(reply.documents ?? []),
    ],
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
      const rawRecordId = typeof p.rawRecordId === "string" ? p.rawRecordId : null;
      const reply: ReachReply = {
        channel,
        text: await rawText(tx, tenantId, p.rawRecordId),
        untrusted: true,
        rawRecordId,
        at: now.toISOString(),
        // P-3: its PDFs and images, filed by the reply's job; pending until each has an outcome.
        ...(await replyAttachments(tx, tenantId, rawRecordId)),
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
      documents: [],
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
    // P-3: where the reply's PDFs and images are stored (docs/plan.md §1.65); without it, none are.
    content?: ContentStore;
  },
): Promise<{
  tenantId: string;
  woken: Wake[];
  // P-3: `document.received` for the reply's new documents, and their ids to read.
  events: EventRow[];
  fresh: string[];
} | null> {
  const to = mail.to.trim().toLowerCase();
  const plus = /^([^@+]+)\+([a-z0-9]{6,40})@(.+)$/.exec(to);
  if (!plus) return null;
  const target = parseForwardingAddress(to, options.domain);
  if (!target) return null;
  const tag = plus[2] as string;
  const bare = `${plus[1]}@${plus[3]}`;
  const parsed = await parseReplyEmail(mail.raw).catch(() => null);
  if (!parsed) return null;
  const filed: { events: EventRow[]; fresh: string[] } = { events: [], fresh: [] };
  const woken = await withTenant(db, target.tenantId, async (tx) => {
    const stored = await options.forwardingAddress(tx, target.tenantId);
    if (!stored || !sameAddress(stored, bare)) return null;
    if (!/^[0-9a-f]{32}$/.test(tag)) return null;
    const id = `${tag.slice(0, 8)}-${tag.slice(8, 12)}-${tag.slice(12, 16)}-${tag.slice(16, 20)}-${tag.slice(20)}`;
    let [row] = await tx
      .select()
      .from(reachOut)
      .where(
        and(
          eq(reachOut.id, id),
          eq(reachOut.tenantId, target.tenantId),
          ne(reachOut.status, "ended"),
        ),
      );
    // P-9: an email conversation's later messages carry its first message's tag (§1.66), so a
    // reply to any of them goes to the conversation's message waiting now (docs/plan.md §1.71).
    if (!row) {
      const [tagged] = await tx
        .select({ subject: reachOut.subject, contactId: reachOut.contactId })
        .from(reachOut)
        .where(and(eq(reachOut.id, id), eq(reachOut.tenantId, target.tenantId)));
      if (tagged?.subject.startsWith("converse:")) {
        [row] = await tx
          .select()
          .from(reachOut)
          .where(
            and(
              eq(reachOut.tenantId, target.tenantId),
              eq(reachOut.contactId, tagged.contactId),
              eq(reachOut.subject, tagged.subject),
              eq(reachOut.status, "open"),
            ),
          )
          .orderBy(desc(reachOut.createdAt))
          .limit(1);
      }
    }
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
    // P-3: the reply is a raw record (its origin), and its PDFs and images documents of this
    // client, in this transaction: a second delivery finds the reach-out ended and keeps nothing.
    const kept = await keepEmailReply(tx, {
      tenantId: target.tenantId,
      row,
      mail,
      parsed,
      content: options.content,
      now: options.now,
    });
    const w = await recordReply(
      tx,
      row,
      {
        channel: "email",
        // A card number in a reply is never stored (PCI DSS 3.3, docs/plan.md §1.35).
        text: redactCardNumbers(parsed.text),
        untrusted: true,
        rawRecordId: kept.rawRecordId,
        at: options.now.toISOString(),
        documents: kept.documents,
        ...(kept.refused.length ? { refused: kept.refused } : {}),
      },
      options.now,
    );
    // Ended meanwhile by another delivery or the cron: roll back what was kept here.
    if (!w) throw new ReplyTaken();
    filed.events = kept.events;
    filed.fresh = kept.fresh;
    return [w];
  }).catch((error: unknown) => {
    if (error instanceof ReplyTaken) return [] as Wake[];
    throw error;
  });
  if (woken === null) return null;
  return { tenantId: target.tenantId, woken, ...filed };
}

// ── P-3: an email reply's attachments (docs/plan.md §1.65) ─────────────────────────────────────

/** An email reply, as a raw record on the client's upload connection (the address it came to). */
export const REACH_REPLY_EMAIL_ENTITY = "ReachOutReply";

class ReplyTaken extends Error {
  override name = "ReplyTaken";
}

/**
 * Keeps an email reply: a raw record (headers, the reply's own words, what each attachment
 * became) and its PDFs and images as documents of this client (`source: email`, the raw record as
 * their origin), at most REPLY_DOCUMENTS_MAX. Checks as for forwarded mail and capture: the type
 * (declared, and the bytes' own), the documents' 32 MB, inline images left out. Each refusal is
 * counted on the reply and the raw record, never dropped silently.
 */
async function keepEmailReply(
  tx: Tx,
  input: {
    tenantId: string;
    row: ReachOutRow;
    mail: { from: string; to: string; raw: Uint8Array };
    parsed: ReplyEmail;
    content: ContentStore | undefined;
    now: Date;
  },
): Promise<{
  rawRecordId: string | null;
  documents: string[];
  refused: ReplyAttachmentRefusal[];
  events: EventRow[];
  fresh: string[];
}> {
  const [upload] = await tx
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(eq(connection.tenantId, input.tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)),
    )
    .orderBy(connection.createdAt)
    .limit(1);
  const out = {
    rawRecordId: null as string | null,
    documents: [] as string[],
    refused: [] as ReplyAttachmentRefusal[],
    events: [] as EventRow[],
    fresh: [] as string[],
  };
  if (!upload) return out;
  const rawRecordId = uuidv7();
  const files = await parseForwardedEmail(input.mail.raw).catch(() => null);
  const attachments: Record<string, unknown>[] = [];
  for (const s of files?.skipped ?? []) {
    const reason = s.reason === "an inline image" ? "inline_image" : "type_not_allowed";
    out.refused.push({ contentType: s.mimeType.slice(0, 200), reason });
    attachments.push({ contentType: s.mimeType.slice(0, 200), status: "refused", reason });
  }
  for (const a of files?.attachments ?? []) {
    const refuse = (reason: string) => {
      out.refused.push({ contentType: a.mimeType, reason });
      attachments.push({
        contentType: a.mimeType,
        sizeBytes: a.bytes.length,
        status: "refused",
        reason,
      });
    };
    if (!input.content) {
      refuse("not_stored");
      continue;
    }
    if (out.documents.length >= REPLY_DOCUMENTS_MAX) {
      refuse("too_many");
      continue;
    }
    if (!bytesMatchType(a.bytes, a.mimeType)) {
      refuse("type_mismatch");
      continue;
    }
    try {
      const stored = await storeDocument(tx, input.content, {
        tenantId: input.tenantId,
        source: "email",
        connectionId: upload.id,
        bytes: a.bytes,
        // The sender's name for the file, as forwarded mail keeps it (card numbers never kept).
        filename: redactCardNumbers(a.filename),
        mimeType: a.mimeType,
        meta: {
          email: {
            from: input.parsed.from ?? input.mail.from.toLowerCase(),
            envelopeFrom: input.mail.from.toLowerCase(),
            to: input.mail.to.toLowerCase(),
            subject: input.parsed.subject,
            messageId: input.parsed.messageId,
          },
          rawRecordId,
          reachOutId: input.row.id,
          reachOutReply: true,
        },
      });
      if (!out.documents.includes(stored.document.id)) out.documents.push(stored.document.id);
      if (stored.created) out.fresh.push(stored.document.id);
      if (stored.event) out.events.push(stored.event);
      attachments.push({
        contentType: a.mimeType,
        sizeBytes: a.bytes.length,
        status: "filed",
        documentId: stored.document.id,
      });
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      refuse(error.code === "too_large" ? "too_large" : "type_not_allowed");
    }
  }
  const [made] = await tx
    .insert(rawRecord)
    .values({
      id: rawRecordId,
      tenantId: input.tenantId,
      connectionId: upload.id,
      connector: UPLOAD_CONNECTOR_ID,
      entityType: REACH_REPLY_EMAIL_ENTITY,
      externalId: input.row.id,
      externalVersion: null,
      payload: {
        direction: "in",
        channel: "email",
        reachOutId: input.row.id,
        from: input.parsed.from ?? input.mail.from.toLowerCase(),
        subject: input.parsed.subject,
        messageId: input.parsed.messageId,
        // The reply's own words (quoted history cut), as the reach-out keeps them: data only.
        text: redactCardNumbers(input.parsed.text),
        attachments,
      },
      syncedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  // Another delivery of this reply got here first: everything here rolls back.
  if (!made) throw new ReplyTaken();
  out.rawRecordId = rawRecordId;
  return out;
}
