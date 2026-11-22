// Receiving a forwarded email (ARCHITECTURE §6.5): the Worker's `email()` handler hands the raw
// message here. Only mail to a client's exact private address, from an allowed sender, is
// accepted; its PDF and image attachments become `document(source='email')` (once per sha256),
// with the headers kept and the body dropped. Everything else is dropped and counted.

import {
  type ContentStore,
  countForwarded,
  forwardingOf,
  MAX_FORWARDED_BYTES,
  matchingSender,
  parseForwardedEmail,
  parseForwardingAddress,
  sameAddress,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { authenticatedSenders, bytesMatchType } from "@countersign/core";
import { connection, type Db, document, type Tx, withTenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq, inArray } from "drizzle-orm";
import { landReport, type ReportIntake } from "./intake";
import { DocumentError, storeDocument } from "./store";

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface SkippedAttachment {
  filename: string;
  reason: string;
}

/**
 * Which of a message's attachments to keep: each whose bytes are what its type says, at most
 * `max`; the rest with why. Shared by every mail entry point (forwarding, an agent's address,
 * Sloan), so one bad part is skipped and the rest kept.
 */
export function attachmentsToKeep<A extends EmailAttachment>(
  attachments: readonly A[],
  max: number,
): { kept: A[]; skipped: SkippedAttachment[] } {
  const kept: A[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const a of attachments) {
    if (!bytesMatchType(a.bytes, a.mimeType)) {
      skipped.push({ filename: a.filename, reason: "the file is not what its type says" });
    } else if (kept.length >= max) {
      skipped.push({ filename: a.filename, reason: `more than ${max} attachments` });
    } else {
      kept.push(a);
    }
  }
  return { kept, skipped };
}

/**
 * Stores each kept attachment as the client's document; one the store refuses (empty, too large,
 * a type it doesn't keep) is skipped with why, never the whole message.
 */
export async function storeEmailAttachments(
  tx: Tx,
  content: ContentStore,
  input: {
    tenantId: string;
    connectionId: string;
    attachments: readonly EmailAttachment[];
    meta: Record<string, unknown>;
  },
): Promise<{
  documents: { id: string; created: boolean; filename: string }[];
  skipped: SkippedAttachment[];
  events: EventRow[];
}> {
  const documents: { id: string; created: boolean; filename: string }[] = [];
  const skipped: SkippedAttachment[] = [];
  const events: EventRow[] = [];
  for (const a of input.attachments) {
    try {
      const stored = await storeDocument(tx, content, {
        tenantId: input.tenantId,
        source: "email",
        connectionId: input.connectionId,
        bytes: a.bytes,
        filename: a.filename,
        mimeType: a.mimeType,
        meta: input.meta,
      });
      documents.push({ id: stored.document.id, created: stored.created, filename: a.filename });
      if (stored.event) events.push(stored.event);
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      skipped.push({ filename: a.filename, reason: error.message });
    }
  }
  return { documents, skipped, events };
}

export interface ForwardedMessage {
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipient: the address it was routed to. */
  to: string;
  raw: Uint8Array;
  /** The message's size, when known before reading it (Email Routing's rawSize). */
  size?: number;
}

export type ForwardingOutcome =
  | {
      status: "accepted";
      tenantId: string;
      documents: { id: string; created: boolean; filename: string }[];
      skipped: { filename: string; reason: string }[];
      /** `document.received` events, for dispatch after commit. */
      events: EventRow[];
      /** §1.213: each table file as a report: landed, a duplicate refused, rejected, or unknown. */
      reports?: ReportIntake[];
    }
  | { status: "dropped"; tenantId: string | null; reason: DropReason };

// DECISION: at most 20 documents from one forwarded message, as from one email to an agent
// (triggers/inbound-email.ts): the first 20 in the message are kept, the rest are listed as
// skipped and counted on each kept document's `meta.email.skippedAttachments`.
export const FORWARDED_DOCUMENTS_MAX = 20;

export type DropReason =
  | "not_our_domain"
  | "unknown_address"
  | "sender_not_allowed"
  // On the list by envelope or From, but Cloudflare's header doesn't prove it (no SPF or DMARC).
  | "sender_unverified"
  | "too_large"
  | "unreadable";

export async function receiveForwardedEmail(
  deps: { db: Db; content: ContentStore },
  message: ForwardedMessage,
  options: { domain: string; now?: () => Date },
): Promise<ForwardingOutcome> {
  const now = options.now ?? (() => new Date());
  const target = parseForwardingAddress(message.to, options.domain);
  if (!target) {
    const ours = message.to.toLowerCase().endsWith(`@${options.domain.toLowerCase()}`);
    return {
      status: "dropped",
      tenantId: null,
      reason: ours ? "unknown_address" : "not_our_domain",
    };
  }
  const { tenantId } = target;
  return withTenant(deps.db, tenantId, async (tx) => {
    const [conn] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.tenantId, tenantId), eq(connection.connector, UPLOAD_CONNECTOR_ID)))
      .orderBy(connection.createdAt)
      .limit(1);
    const forwarding = conn ? forwardingOf(conn) : null;
    if (!conn || !forwarding?.address || !sameAddress(forwarding.address, message.to)) {
      // Not this client's current address (never made, or replaced): nothing to count it on
      // when there is no connection.
      if (conn)
        await countForwarded(tx, conn, { accepted: false, reason: "unknown_address" }, now());
      return { status: "dropped", tenantId: conn ? tenantId : null, reason: "unknown_address" };
    }
    const drop = async (reason: DropReason): Promise<ForwardingOutcome> => {
      await countForwarded(tx, conn, { accepted: false, reason }, now());
      return { status: "dropped", tenantId, reason };
    };
    if ((message.size ?? message.raw.length) > MAX_FORWARDED_BYTES) return drop("too_large");
    let parsed: Awaited<ReturnType<typeof parseForwardedEmail>>;
    try {
      parsed = await parseForwardedEmail(message.raw);
    } catch {
      return drop("unreadable");
    }
    // The envelope sender counts only when SPF passed for its domain, the From header only when
    // DMARC passed for its domain, both per Cloudflare's own header (@countersign/core).
    const senders = authenticatedSenders({
      envelopeFrom: message.from,
      from: parsed.headers.from,
      auth: parsed.headers.auth,
    });
    const matched = matchingSender(forwarding.allowedSenders, senders);
    if (!matched) {
      // DECISION: a sender who is on the list but not proven is told apart from one who isn't on
      // it, so the client sees why (`forwarding.drop.sender_unverified`).
      const claimed = [message.from, ...(parsed.headers.from ? [parsed.headers.from] : [])];
      return drop(
        matchingSender(forwarding.allowedSenders, claimed)
          ? "sender_unverified"
          : "sender_not_allowed",
      );
    }

    // Each attachment's bytes must be what its type says; at most FORWARDED_DOCUMENTS_MAX kept.
    const filtered = attachmentsToKeep(parsed.attachments, FORWARDED_DOCUMENTS_MAX);
    const kept = filtered.kept;
    const skipped = [
      ...parsed.skipped.map((s) => ({ filename: s.filename, reason: s.reason })),
      ...filtered.skipped,
    ];
    const meta = {
      email: {
        // As the message says, for display; `authenticated` says whether anyone proved it.
        from: parsed.headers.from ?? message.from.toLowerCase(),
        envelopeFrom: message.from.toLowerCase(),
        to: message.to.toLowerCase(),
        subject: parsed.headers.subject,
        date: parsed.headers.date,
        messageId: parsed.headers.messageId,
        authenticated: senders.length > 0,
        // The proven address that is on the client's list.
        authenticatedAs: matched,
        ...(skipped.length > parsed.skipped.length
          ? { skippedAttachments: skipped.length - parsed.skipped.length }
          : {}),
      },
    };
    const stored = await storeEmailAttachments(tx, deps.content, {
      tenantId,
      connectionId: conn.id,
      attachments: kept,
      meta,
    });
    await countForwarded(tx, conn, { accepted: true }, now());
    // §1.213: a table file is landed as a report when one of the client's profiles reads it.
    const reports: ReportIntake[] = [];
    const ids = stored.documents.map((d) => d.id);
    const docs =
      ids.length > 0
        ? await tx
            .select()
            .from(document)
            .where(and(eq(document.tenantId, tenantId), inArray(document.id, ids)))
        : [];
    for (const id of ids) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) continue;
      const landed = await landReport(tx, deps.content, {
        connection: conn,
        document: doc,
        from: matched,
        now: now(),
      });
      if (landed) reports.push(landed);
    }
    return {
      status: "accepted",
      tenantId,
      documents: stored.documents,
      skipped: [...skipped, ...stored.skipped],
      events: stored.events,
      reports,
    };
  });
}
