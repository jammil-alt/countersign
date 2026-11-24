// Email to an agent's own address (ARCHITECTURE §10.8; docs/plan.md §1.48 "Inbound messages"):
// `<agent>.<client label>-<client id>@<EMAIL_FORWARDING_DOMAIN>`. The address names the client, so
// the work happens in that client's transaction only, and the agent is found among that client's
// agents by its command name; the whole address must be the one we compute for that client, so a
// forged address (another client's label, an agent it doesn't have) is dropped.
//
// The sender counts only by a From address whose domain passed DMARC, as Cloudflare's own header
// says (`readAuthentication`, @countersign/core; an unauthenticated From is anyone). An auto-reply
// or bounce starts nothing; mail a system wrote is read as usual but never answered automatically.
// A sender one of the agent's email message triggers takes: the message's own words are kept as a
// raw record `InboundMessage` on the upload connection (4,000 characters, quoted history
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
import {
  agent,
  agentVersion,
  type Db,
  document,
  rawRecord,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { attachmentsToKeep, storeEmailAttachments } from "@countersign/documents";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { commandCandidates } from "@countersign/threads";
import { and, eq, inArray } from "drizzle-orm";
import { collectStepTags, type HandedTo, handToOpenLink, openLinks } from "../collect/email";
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
      /** Collect reports: the report link the files went to, whose run is woken. */
      wake?: HandedTo;
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

/**
 * Collect reports (owner, 2026-11-24): mail to one of the agent's collect steps. Only a sender
 * whose From address is a contact with a link of that step open gets in (DMARC proof is recorded,
 * not required); their attachments go to that link as an
 * upload would, and the step's run is woken (`wake`). Nothing else is stored, no run is started
 * and nobody is answered automatically: the step itself asks again or follows up.
 */
// DECISION: mail from anyone else, or from an owner with no link of the step open, is refused
// quietly (no reply, nothing stored): a stranger learns nothing, and an owner's report that is
// late or early is chased by the step's own follow-ups and escalation.
async function stepEmail(
  tx: Tx,
  deps: { content: ContentStore },
  m: {
    tenantId: string;
    agentId: string;
    tag: string;
    sender: { id: string } | null;
    from: string | null;
    proven: string | null;
    headers: Awaited<ReturnType<typeof parseForwardedEmail>>["headers"];
    attachments: Awaited<ReturnType<typeof parseForwardedEmail>>["attachments"];
    text: string;
    envelopeFrom: string;
    to: string;
    key: string;
    now: Date;
    dropped: (reason: string) => AgentEmailOutcome;
  },
): Promise<AgentEmailOutcome> {
  const refused = (reason: string): AgentEmailOutcome => ({
    status: "refused",
    tenantId: m.tenantId,
    reason,
    events: [],
    replies: [],
  });
  if (!m.sender) return refused("sender_not_owner");
  const open = await openLinks(tx, {
    tenantId: m.tenantId,
    agentId: m.agentId,
    tag: m.tag,
    contactId: m.sender.id,
    at: m.now,
  });
  if (open.length === 0) return refused("no_open_report");
  const conn = await ensureUploadConnection(tx, m.tenantId);
  const [seen] = await tx
    .select({ id: rawRecord.id })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, m.tenantId),
        eq(rawRecord.connectionId, conn.id),
        eq(rawRecord.entityType, INBOUND_MESSAGE_ENTITY),
        eq(rawRecord.externalId, m.key),
      ),
    )
    .limit(1);
  if (seen) return m.dropped("duplicate");
  const meta = {
    email: {
      from: m.from,
      envelopeFrom: m.envelopeFrom.toLowerCase(),
      to: m.to.toLowerCase(),
      subject: m.headers.subject,
      date: m.headers.date,
      messageId: m.headers.messageId,
      // Whether Cloudflare's header proved the From address (DMARC for its domain).
      authenticated: m.proven !== null,
      authenticatedAs: m.proven,
      agentId: m.agentId,
      step: m.tag,
    },
  };
  const files = await storeEmailAttachments(tx, deps.content, {
    tenantId: m.tenantId,
    connectionId: conn.id,
    attachments: attachmentsToKeep(m.attachments, MAX_ATTACHMENTS).kept,
    meta,
  });
  if (files.documents.length === 0) return refused("no_file");
  const ids = files.documents.map((d) => d.id);
  const types = await tx
    .select({ id: document.id, filename: document.filename, mimeType: document.mimeType })
    .from(document)
    .where(and(eq(document.tenantId, m.tenantId), inArray(document.id, ids)));
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId: m.tenantId,
      connectionId: conn.id,
      connector: UPLOAD_CONNECTOR_ID,
      entityType: INBOUND_MESSAGE_ENTITY,
      externalId: m.key,
      externalVersion: null,
      payload: {
        agentId: m.agentId,
        channel: "email",
        from: m.from,
        contactId: m.sender.id,
        step: m.tag,
        authenticated: m.proven !== null,
        subject: m.headers.subject?.slice(0, 300) ?? null,
        date: m.headers.date,
        messageId: m.headers.messageId,
        // The sender's words: data, never instructions (invariant 9).
        text: inboundText(m.text),
        documents: ids,
      },
      syncedAt: m.now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  if (!stored) return m.dropped("duplicate");
  const handed = await handToOpenLink(tx, {
    open,
    tenantId: m.tenantId,
    files: ids.flatMap((id) => types.filter((t) => t.id === id)),
    at: m.now,
    messageId: m.headers.messageId ?? null,
    proven: m.proven !== null,
  });
  if (!handed) return refused("no_open_report");
  return {
    status: "accepted",
    tenantId: m.tenantId,
    agentId: m.agentId,
    rawRecordId: stored.id,
    fresh: files.documents.filter((d) => d.created).map((d) => d.id),
    events: files.events,
    replies: [],
    wake: handed,
  };
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
    // Collect reports (owner, 2026-11-24): `+<step id>` names one of the agent's collect steps;
    // mail to it goes to that step, whatever the agent's message triggers.
    const tag = target.tag;
    if (tag !== null) {
      if (!bundle || !collectStepTags(bundle).has(tag)) return dropped("unknown_address");
    } else if (!bundle || messageTriggersOn(bundle, "email").length === 0) {
      // DECISION: an agent with no email message trigger has no inbox: mail to it is dropped
      // (counted nowhere, answered never), as an unknown address is.
      return dropped("no_email_trigger");
    }
    if (message.size > MAX_FORWARDED_BYTES) return dropped("too_large");
    let headers: Awaited<ReturnType<typeof parseForwardedEmail>>;
    let reply: Awaited<ReturnType<typeof parseReplyEmail>>;
    try {
      headers = await parseForwardedEmail(message.raw, { envelopeFrom: message.from });
      reply = await parseReplyEmail(message.raw);
    } catch {
      return dropped("unreadable");
    }
    // DECISION: an auto-reply or a bounce (`emailAutomation`) starts nothing and is never answered;
    // it is dropped like mail to an agent with no inbox. Mail a system wrote (an ERP's invoice, a
    // ticket system, a list) may start a trigger from a sender it takes, as any mail does, but gets
    // no automatic reply (no polite reply, no confirmation), so two machines can't write to each
    // other.
    if (headers.headers.automatic === "auto_reply") return dropped("automatic");
    const answerable = headers.headers.automatic === null;
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

    if (tag !== null) {
      // DECISION (owner, 2026-11-24: "not an issue right now… lets allow for the email to come
      // in to the address"): mail to a step is taken from the report owner's address as it
      // claims to be, proven or not; the report's checks decide whether it counts, and the file
      // is marked unproven for whoever reviews the run. Nothing else reads an unproven sender.
      const claimed = sender ?? (from ? await contactByEmail(tx, tenantId, from) : null);
      return stepEmail(tx, deps, {
        tenantId,
        agentId: found.agentId,
        tag,
        sender: claimed,
        from,
        proven,
        headers: headers.headers,
        attachments: headers.attachments,
        text: reply.text,
        envelopeFrom: message.from,
        to: message.to,
        key,
        now,
        dropped,
      });
    }

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
      const polite = answerable
        ? strangerReply({ channel: "email", agentName, locale, to: proven, key })
        : null;
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
        // Whether Cloudflare's header proved the From address (DMARC for its domain).
        authenticated: proven !== null,
        authenticatedAs: proven,
        agentId: found.agentId,
      },
    };
    // As forwarded mail: a part whose bytes aren't its type, or that the store refuses (empty, too
    // large), is skipped and the rest kept, never the whole message lost (INPUT-6).
    const files = await storeEmailAttachments(tx, deps.content, {
      tenantId,
      connectionId: conn.id,
      attachments: attachmentsToKeep(headers.attachments, MAX_ATTACHMENTS).kept,
      meta,
    });
    for (const d of files.documents) {
      documents.push(d.id);
      if (d.created) fresh.push(d.id);
    }
    events.push(...files.events);
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
    if (confirm && proven && answerable) {
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
