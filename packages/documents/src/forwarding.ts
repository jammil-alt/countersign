// Receiving a forwarded email (ARCHITECTURE §6.5): the Worker's `email()` handler hands the raw
// message here. Only mail to a client's exact private address, from an allowed sender, is
// accepted; its PDF and image attachments become `document(source='email')` (once per sha256),
// with the headers kept and the body dropped. Everything else is dropped and counted.

import {
  type ContentStore,
  countForwarded,
  forwardingOf,
  MAX_FORWARDED_BYTES,
  parseForwardedEmail,
  parseForwardingAddress,
  sameAddress,
  senderAllowed,
  trustedFromHeader,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import { connection, type Db, withTenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import { storeDocument } from "./store";

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
    }
  | { status: "dropped"; tenantId: string | null; reason: DropReason };

export type DropReason =
  | "not_our_domain"
  | "unknown_address"
  | "sender_not_allowed"
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
    // The envelope sender always counts; the From header only when its domain passed DMARC.
    const fromHeader = trustedFromHeader(parsed.headers.from, parsed.headers.dmarcPassFrom)
      ? [parsed.headers.from as string]
      : [];
    const senders = [message.from, ...fromHeader];
    if (!senderAllowed(forwarding.allowedSenders, senders)) return drop("sender_not_allowed");

    const meta = {
      email: {
        from: parsed.headers.from ?? message.from.toLowerCase(),
        envelopeFrom: message.from.toLowerCase(),
        to: message.to.toLowerCase(),
        subject: parsed.headers.subject,
        date: parsed.headers.date,
        messageId: parsed.headers.messageId,
      },
    };
    const documents: { id: string; created: boolean; filename: string }[] = [];
    const events: EventRow[] = [];
    for (const a of parsed.attachments) {
      const stored = await storeDocument(tx, deps.content, {
        tenantId,
        source: "email",
        connectionId: conn.id,
        bytes: a.bytes,
        filename: a.filename,
        mimeType: a.mimeType,
        meta,
      });
      documents.push({ id: stored.document.id, created: stored.created, filename: a.filename });
      if (stored.event) events.push(stored.event);
    }
    await countForwarded(tx, conn, { accepted: true }, now());
    return {
      status: "accepted",
      tenantId,
      documents,
      skipped: parsed.skipped.map((s) => ({ filename: s.filename, reason: s.reason })),
      events,
    };
  });
}
