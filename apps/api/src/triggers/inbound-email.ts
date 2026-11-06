// Email to an agent's own address (ARCHITECTURE §10.8; docs/plan.md §1.48 "Inbound messages"):
// `<agent>.<client label>-<client id>@<EMAIL_FORWARDING_DOMAIN>`. The address names the client, so
// the work happens in that client's transaction only, and the agent is found among that client's
// agents by its command name; the whole address must be the one we compute for that client, so a
// forged address (another client's label, an agent it doesn't have) is dropped.
//
// The sender counts only by a From address whose domain passed DMARC (an unauthenticated From is
// anyone). A sender one of the agent's email message triggers takes: the message's own words are
// kept as a raw record `InboundMessage` on the upload connection (4,000 characters, quoted history
// cut, card numbers redacted; read by agents only through `inbound.get`), its PDF and image
// attachments as documents, and `inbound.message` is emitted. Anyone else: nothing is stored; a
// polite fixed reply (only with DMARC pass) and a note to the lead.

import {
  type ContentStore,
  ensureUploadConnection,
  MAX_FORWARDED_BYTES,
  parseForwardedEmail,
  parseReplyEmail,
  trustedFromHeader,
  UPLOAD_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  acceptingTriggers,
  agentAddress,
  agentCommandNames,
  INBOUND_MESSAGE_ENTITY,
  INBOUND_MESSAGE_EVENT,
  type InboundMessagePayload,
  inboundText,
  messageTriggersOn,
  parseAgentAddress,
  type SenderFacts,
  sameAgentAddress,
} from "@countersign/core";
import { agent, agentVersion, type Db, rawRecord, tenant, withTenant } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { commandCandidates } from "@countersign/threads";
import { and, eq } from "drizzle-orm";
import { tenantLocale } from "../routes/language";
import { confirmReply, type InboundReply, noteStranger, strangerReply } from "./replies";
import { contactByEmail, contactFacts } from "./senders";

export interface AgentEmail {
  from: string;
  to: string;
  raw: Uint8Array;
  size: number;
}

export type AgentEmailOutcome =
  | {
      status: "accepted";
      tenantId: string;
      agentId: string;
      rawRecordId: string;
      /** Documents made from this message, for background reading. */
      fresh: string[];
      events: EventRow[];
      replies: InboundReply[];
    }
  | {
      status: "refused" | "dropped";
      tenantId: string | null;
      reason: string;
      events: EventRow[];
      replies: InboundReply[];
    };

const MAX_ATTACHMENTS = 20;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Null when `to` isn't an agent address on `domain` (the caller tries the other kinds of mail). */
export async function receiveAgentEmail(
  deps: { db: Db; content: ContentStore; registry: EventTypeRegistry },
  message: AgentEmail,
  options: { domain: string; now?: Date },
): Promise<AgentEmailOutcome | null> {
  const target = parseAgentAddress(message.to, options.domain);
  if (!target) return null;
  const now = options.now ?? new Date();
  const { tenantId } = target;
  const dropped = (reason: string, known = true): AgentEmailOutcome => ({
    status: "dropped",
    tenantId: known ? tenantId : null,
    reason,
    events: [],
    replies: [],
  });
  return withTenant(deps.db, tenantId, async (tx) => {
    const [client] = await tx
      .select({ name: tenant.name, retiredAt: tenant.retiredAt })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!client || client.retiredAt) return dropped("unknown_address", false);
    const candidates = await commandCandidates(tx, tenantId);
    const names = agentCommandNames(candidates);
    const found = candidates.find((c) => names.get(c.agentId) === target.commandName);
    const expected = found
      ? agentAddress({
          commandName: target.commandName,
          clientName: client.name,
          tenantId,
          domain: options.domain,
        })
      : null;
    if (!found || !expected || !sameAgentAddress(expected, message.to)) {
      return dropped("unknown_address");
    }
    const [row] = await tx
      .select({ bundle: agentVersion.bundle, name: agent.name })
      .from(agent)
      .innerJoin(
        agentVersion,
        and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
      )
      .where(and(eq(agent.id, found.agentId), eq(agent.tenantId, tenantId)));
    const bundle = row?.bundle;
    // DECISION: an agent with no email message trigger has no inbox: mail to it is dropped
    // (counted nowhere, answered never), as an unknown address is.
    if (!bundle || messageTriggersOn(bundle, "email").length === 0) {
      return dropped("no_email_trigger");
    }
    if (message.size > MAX_FORWARDED_BYTES) return dropped("too_large");
    let headers: Awaited<ReturnType<typeof parseForwardedEmail>>;
    let reply: Awaited<ReturnType<typeof parseReplyEmail>>;
    try {
      headers = await parseForwardedEmail(message.raw);
      reply = await parseReplyEmail(message.raw);
    } catch {
      return dropped("unreadable");
    }
    const agentName = bundle.definition.identity.name;
    const locale = await tenantLocale(tx, tenantId);
    // The From header names the sender only when its domain passed DMARC.
    const from = headers.headers.from;
    const proven = trustedFromHeader(from, headers.headers.dmarcPassFrom) ? from : null;
    const sender = proven ? await contactByEmail(tx, tenantId, proven) : null;
    const facts: SenderFacts = sender ? contactFacts(sender) : { kind: "stranger" };
    const accepting = acceptingTriggers(bundle, "email", facts);
    const messageKey = headers.headers.messageId?.slice(0, 300) || (await sha256Hex(message.raw));
    const key = `${found.agentId}:${messageKey}`;

    if (accepting.length === 0) {
      const events: EventRow[] = [];
      await noteStranger(tx, {
        tenantId,
        agentName,
        channel: "email",
        from: proven ?? message.from,
        locale,
        registry: deps.registry,
        collect: events,
      });
      const polite = strangerReply({ channel: "email", agentName, locale, to: proven, key });
      return {
        status: "refused",
        tenantId,
        reason: "sender_not_allowed",
        events,
        replies: polite ? [polite] : [],
      };
    }

    const conn = await ensureUploadConnection(tx, tenantId);
    // The same message twice (Email Routing retries, a resend): one record, one run.
    const [seen] = await tx
      .select({ id: rawRecord.id })
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.tenantId, tenantId),
          eq(rawRecord.connectionId, conn.id),
          eq(rawRecord.entityType, INBOUND_MESSAGE_ENTITY),
          eq(rawRecord.externalId, key),
        ),
      )
      .limit(1);
    if (seen) return dropped("duplicate");

    const events: EventRow[] = [];
    const documents: string[] = [];
    const fresh: string[] = [];
    const meta = {
      email: {
        from,
        envelopeFrom: message.from.toLowerCase(),
        to: message.to.toLowerCase(),
        subject: headers.headers.subject,
        date: headers.headers.date,
        messageId: headers.headers.messageId,
        agentId: found.agentId,
      },
    };
    for (const a of headers.attachments.slice(0, MAX_ATTACHMENTS)) {
      const stored = await storeDocument(tx, deps.content, {
        tenantId,
        source: "email",
        connectionId: conn.id,
        bytes: a.bytes,
        filename: a.filename,
        mimeType: a.mimeType,
        meta,
      });
      documents.push(stored.document.id);
      if (stored.created) fresh.push(stored.document.id);
      if (stored.event) events.push(stored.event);
    }
    const [stored] = await tx
      .insert(rawRecord)
      .values({
        tenantId,
        connectionId: conn.id,
        connector: UPLOAD_CONNECTOR_ID,
        entityType: INBOUND_MESSAGE_ENTITY,
        externalId: key,
        externalVersion: null,
        payload: {
          agentId: found.agentId,
          channel: "email",
          from,
          contactId: sender?.id ?? null,
          subject: headers.headers.subject?.slice(0, 300) ?? null,
          date: headers.headers.date,
          messageId: headers.headers.messageId,
          // The sender's words: data for `inbound.get`, never instructions (invariant 9).
          text: inboundText(reply.text),
          documents,
        },
        syncedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: rawRecord.id });
    if (!stored) return dropped("duplicate");
    const payload: InboundMessagePayload = {
      agentId: found.agentId,
      channel: "email",
      contactId: sender?.id ?? null,
      userId: null,
      rawRecordId: stored.id,
      documents,
      receivedAt: now.toISOString(),
    };
    const ev = await emit(
      tx,
      {
        tenantId,
        type: INBOUND_MESSAGE_EVENT,
        subjectType: "raw_record",
        subjectId: stored.id,
        payload,
      },
      { registry: deps.registry },
    );
    if (ev) events.push(ev);
    const confirm = accepting.find((t) => t.on.reply)?.on.reply?.confirm;
    const replies: InboundReply[] = [];
    if (confirm && proven) {
      const r = confirmReply({ channel: "email", confirm, agentName, locale, to: proven, key });
      if (r) replies.push(r);
    }
    return {
      status: "accepted",
      tenantId,
      agentId: found.agentId,
      rawRecordId: stored.id,
      fresh,
      events,
      replies,
    };
  });
}
