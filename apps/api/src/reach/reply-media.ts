// P-3: attachments both ways (docs/plan.md §1.65). A text or WhatsApp reply to a reach-out keeps
// its PDFs and images: the webhook starts the capture job for them (`replyMediaJob`, reason
// `reply`: Twilio's or Meta's media fetch with capture's checks, filed as documents of the client
// with the reply's raw record as their origin, read in the background). The reach-out ends as
// `replied` at once (escalation and the timeout stop), with `reply.pending` until every file has an
// outcome; the step waits for that, then hands the document ids on as `reply.documents`. The job,
// the step itself and the minute cron each settle a pending reply; after REPLY_MEDIA_WAIT_MS it is
// settled with what was filed and the rest counted as refused. Files and text stay data
// (invariant 9).

import { mediaSidOf } from "@countersign/connectors";
import {
  attachmentKind,
  REPLY_DOCUMENTS_MAX,
  type ReachReply,
  type ReplyAttachmentRefusal,
  type StoredMedia,
} from "@countersign/core";
import { rawRecord, reachOut, type Tx } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { mediaOutcomes, storedMediaOf } from "../conversations/capture";
import type { CaptureParams } from "../conversations/media";
import type { ReachOutRow } from "./service";

// DECISION (plan §1.65): a reply's files get 15 minutes to arrive (the capture job's five tries a
// minute apart, with room); then the step goes on with what was filed and the rest refused.
export const REPLY_MEDIA_WAIT_MS = 15 * 60_000;

/** A reply's attachments: the PDFs and images to fetch, and the rest refused by type. */
export function replyMediaOf(payload: unknown): {
  wanted: StoredMedia[];
  refused: ReplyAttachmentRefusal[];
} {
  const wanted: StoredMedia[] = [];
  const refused: ReplyAttachmentRefusal[] = [];
  for (const m of storedMediaOf(payload, mediaSidOf)) {
    if (attachmentKind(m.contentType) !== "document") {
      refused.push({ contentType: m.contentType.slice(0, 200), reason: "type_not_allowed" });
    } else if (!m.mediaSid) {
      refused.push({ contentType: m.contentType, reason: "no_media_id" });
    } else {
      wanted.push(m);
    }
  }
  return { wanted, refused };
}

/**
 * At the webhook, in its transaction: the job that fetches a message's PDFs and images when its
 * sender has an open reach-out (whatever the conversation's capture setting: the reach-out asked
 * for a reply). Null when there is nothing to fetch or nobody is waiting. Keywords never count.
 */
// DECISION (plan §1.65): a reply's documents are fetched even where the conversation keeps no
// attachments: the operator's reach-out asked this contact for an answer, and only PDFs and
// images are taken, at the conversation's size limit (20 MB by default).
export async function replyMediaJob(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    rawRecordId: string;
    messageSid: string;
    contactId: string;
    channel: "sms" | "whatsapp";
    media: readonly StoredMedia[];
    keyword: string | null;
  },
): Promise<CaptureParams | null> {
  if (input.keyword) return null;
  const wanted = replyMediaOf({ media: input.media }).wanted;
  if (wanted.length === 0) return null;
  const [open] = await tx
    .select({ id: reachOut.id })
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, input.tenantId),
        eq(reachOut.contactId, input.contactId),
        eq(reachOut.status, "open"),
      ),
    )
    .limit(1);
  if (!open) return null;
  return {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    rawRecordId: input.rawRecordId,
    messageSid: input.messageSid,
    indexes: wanted.map((m) => m.index),
    reason: "reply",
    contactId: input.contactId,
    channel: input.channel,
  };
}

/** The reply's documents from its message's media outcomes; null while one is still to come. */
async function replyDocuments(
  tx: Tx,
  tenantId: string,
  rawRecordId: string,
  force: boolean,
): Promise<{ documents: string[]; refused: ReplyAttachmentRefusal[] } | null> {
  const [raw] = await tx
    .select({
      connectionId: rawRecord.connectionId,
      externalId: rawRecord.externalId,
      payload: rawRecord.payload,
    })
    .from(rawRecord)
    .where(and(eq(rawRecord.id, rawRecordId), eq(rawRecord.tenantId, tenantId)));
  if (!raw) return { documents: [], refused: [] };
  const { wanted, refused } = replyMediaOf(raw.payload);
  if (wanted.length === 0) return { documents: [], refused };
  const outcomes = await mediaOutcomes(tx, tenantId, raw.connectionId, [raw.externalId]);
  const documents: string[] = [];
  for (const m of wanted) {
    const o = outcomes.get(`${raw.externalId}:${m.index}`)?.outcome;
    if (!o) {
      if (!force) return null;
      refused.push({ contentType: m.contentType, reason: "not_fetched" });
    } else if (o.status === "filed" && o.documentId) {
      if (!documents.includes(o.documentId)) documents.push(o.documentId);
    } else {
      refused.push({ contentType: m.contentType, reason: o.reason ?? o.status });
    }
  }
  return { documents: documents.slice(0, REPLY_DOCUMENTS_MAX), refused };
}

/** A text or WhatsApp reply's attachments as the reply first records them: done, or pending. */
export async function replyAttachments(
  tx: Tx,
  tenantId: string,
  rawRecordId: string | null,
): Promise<Pick<ReachReply, "documents" | "refused" | "pending">> {
  if (!rawRecordId) return { documents: [] };
  const now = await replyDocuments(tx, tenantId, rawRecordId, false);
  if (now)
    return { documents: now.documents, ...(now.refused.length ? { refused: now.refused } : {}) };
  return { documents: [], pending: true };
}

export function replyPending(row: Pick<ReachOutRow, "status" | "reply">): boolean {
  return row.status === "ended" && (row.reply as ReachReply | null)?.pending === true;
}

/** Whether a pending reply has waited long enough to be settled with what there is. */
export function replyOverdue(row: Pick<ReachOutRow, "endedAt">, now: Date): boolean {
  return (row.endedAt?.getTime() ?? 0) + REPLY_MEDIA_WAIT_MS <= now.getTime();
}

/**
 * Settles a pending reply on an ended reach-out: its documents and refusals, `pending` gone. Null
 * when it isn't pending, or a file is still to come (and it isn't `force`d).
 */
export async function settlePendingReply(
  tx: Tx,
  row: ReachOutRow,
  force: boolean,
): Promise<ReachOutRow | null> {
  const reply = row.reply as ReachReply | null;
  if (!replyPending(row) || !reply) return null;
  const got = reply.rawRecordId
    ? await replyDocuments(tx, row.tenantId, reply.rawRecordId, force)
    : { documents: [], refused: [] };
  if (!got) return null;
  const { pending: _pending, ...rest } = reply;
  const refused = [...(reply.refused ?? []), ...got.refused];
  const settled: ReachReply = {
    ...rest,
    documents: got.documents,
    ...(refused.length ? { refused } : {}),
  };
  const [updated] = await tx
    .update(reachOut)
    .set({ reply: settled as unknown as Record<string, unknown> })
    .where(
      and(
        eq(reachOut.id, row.id),
        eq(reachOut.tenantId, row.tenantId),
        sql`${reachOut.reply}->>'pending' = 'true'`,
      ),
    )
    .returning();
  return updated ?? null;
}

/** The pending replies a message answered (the job's last step settles them). */
export async function pendingRepliesFor(
  tx: Tx,
  tenantId: string,
  rawRecordId: string,
): Promise<ReachOutRow[]> {
  return tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.status, "ended"),
        sql`${reachOut.reply}->>'pending' = 'true'`,
        sql`${reachOut.reply}->>'rawRecordId' = ${rawRecordId}`,
      ),
    )
    .limit(20);
}

/** One client's pending replies (the cron). */
export async function pendingReplies(tx: Tx, tenantId: string): Promise<ReachOutRow[]> {
  return tx
    .select()
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.status, "ended"),
        sql`${reachOut.reply}->>'pending' = 'true'`,
      ),
    )
    .limit(100);
}
