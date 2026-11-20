// Sloan by email and text (docs/plan.md §1.150). A client's people email Sloan at its own address
// (`sloan.<client label>-<client id>@<forwarding domain>`) and text the account's number; each
// message becomes theirs in their own conversation with Sloan ("By email", "By text"), so Sloan's
// chat workflow runs as it does for the portal, under the same rules (invariant 11). Sloan's answer
// goes back the way the message came (`deliverSloanAnswer`), and the portal shows both sides.
//
// Who counts: a person of the client (client admin or client user, not an operator) proven by
//   - email: the From address, only when its domain passed DMARC (as agent addresses, §1.48),
//     matched to their sign-in email;
//   - text: their directory entry (the client's contact with their sign-in email, as notifications
//     find it), whose number signed up for texts and hasn't said STOP.
// Anyone else is a stranger: nothing is stored, a fixed polite reply (email only with DMARC pass)
// and a note to the lead, as for an agent's address.

import {
  type ContentStore,
  ensureUploadConnection,
  MAX_FORWARDED_BYTES,
  parseForwardedEmail,
  parseReplyEmail,
  readTwilioConfig,
  TWILIO_CONNECTOR_ID,
  trustedFromHeader,
} from "@countersign/connectors";
import {
  ACCOUNT_AGENT_SLUG,
  type ContactConsent,
  consentBlock,
  inboundText,
  isSloanAddress,
  type JsonObject,
  parseAgentAddress,
  SLOAN_CHANNEL_THREAD_TITLES,
  type SloanChannel,
  sameAgentAddress,
  sloanAddress,
} from "@countersign/core";
import {
  agent,
  appUser,
  connection,
  type Db,
  membership,
  message,
  reachOut,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { attachmentsToKeep, storeEmailAttachments } from "@countersign/documents";
import type { EventRow, EventTypeRegistry } from "@countersign/senses";
import { channelAccountThread, postAsPerson, senseEmitPosted } from "@countersign/threads";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { auditInTx } from "../audit";
import { channelFor } from "../channels/resolve";
import type { ContactRow } from "../messaging/contacts";
import { tenantLocale } from "../routes/language";
import { type InboundReply, noteStranger, strangerReply } from "../triggers/replies";

/** The name Sloan's polite reply and the lead's note use. */
export const SLOAN_NAME = "Sloan";

const CLIENT_ROLES = ["client_admin", "client_user"] as const;
const MAX_ATTACHMENTS = 20;

export interface SloanPerson {
  userId: string;
  email: string;
  role: (typeof CLIENT_ROLES)[number];
}

/** A client admin or client user of this client with this sign-in email, or null. */
export async function clientPersonByEmail(
  tx: Tx,
  tenantId: string,
  email: string,
): Promise<SloanPerson | null> {
  const address = email.trim().toLowerCase();
  if (!address) return null;
  const [row] = await tx
    .select({ userId: appUser.id, email: appUser.email, role: membership.role })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, [...CLIENT_ROLES]),
        eq(appUser.email, address),
      ),
    )
    .limit(1);
  return row ? { ...row, role: row.role as SloanPerson["role"] } : null;
}

/** The client's Sloan is on: its fork is active (Sloan on by default, §1.47). */
export async function sloanIsOn(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: agent.id })
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.slug, ACCOUNT_AGENT_SLUG),
        eq(agent.runStatus, "active"),
        eq(agent.testCopy, false),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The person behind a text: the contact's email is a client person's sign-in email, and the number
 * signed up for texts with no STOP since, so Sloan's answer may go back to it.
 */
export async function sloanTextSender(
  tx: Tx,
  tenantId: string,
  c: Pick<ContactRow, "email" | "phone" | "whatsapp" | "consent" | "optedOutAt">,
): Promise<SloanPerson | null> {
  if (!c.email || !c.phone) return null;
  const block = consentBlock(
    {
      phone: c.phone,
      whatsapp: c.whatsapp,
      consent: (c.consent ?? {}) as ContactConsent,
      optedOutAt: c.optedOutAt,
    },
    "sms",
  );
  if (block) return null;
  return clientPersonByEmail(tx, tenantId, c.email);
}

/**
 * Posts the person's words in their channel conversation with Sloan, emitting
 * `thread.message_posted` (collected for dispatch after commit), and writes the audit row: the
 * message reaches Sloan on the person's behalf (invariant 14).
 */
export async function postToSloan(
  tx: Tx,
  input: {
    tenantId: string;
    person: SloanPerson;
    channel: SloanChannel;
    text: string;
    documents?: readonly string[];
    /** More of the body: the email's subject and id, or the number written to. */
    extra: JsonObject;
    registry: EventTypeRegistry;
    collect: EventRow[];
  },
): Promise<{ threadId: string; messageId: string }> {
  const thread = await channelAccountThread(
    tx,
    input.tenantId,
    input.person.userId,
    SLOAN_CHANNEL_THREAD_TITLES[input.channel],
  );
  const posted = await postAsPerson(
    tx,
    {
      tenantId: input.tenantId,
      thread,
      userId: input.person.userId,
      operator: false,
      text: input.text,
      sources: [],
      ...(input.documents && input.documents.length > 0 ? { documents: input.documents } : {}),
      audience: "client",
      locale: await tenantLocale(tx, input.tenantId),
      extra: { ...input.extra, via: input.channel },
    },
    senseEmitPosted({ registry: input.registry, collect: input.collect }),
  );
  const first = posted[0];
  if (!first) throw new Error("no message posted");
  await auditInTx(tx, null, {
    tenantId: input.tenantId,
    actorKind: "user",
    actorUserId: input.person.userId,
    actorEmail: input.person.email,
    actorRole: input.person.role,
    action: input.channel === "email" ? "sloan.email_received" : "sloan.text_received",
    outcome: "ok",
    target: { thread: thread.id, message: first.id },
  });
  return { threadId: thread.id, messageId: first.id };
}

// ── Email ───────────────────────────────────────────────────────────────────────────────────────

export interface SloanEmail {
  from: string;
  to: string;
  raw: Uint8Array;
  size: number;
}

export type SloanEmailOutcome = {
  status: "accepted" | "refused" | "dropped";
  tenantId: string | null;
  reason: string | null;
  /** Documents made from its attachments, for background reading. */
  fresh: string[];
  events: EventRow[];
  replies: InboundReply[];
};

/** Null when `to` isn't a Sloan address on `domain` (the caller tries the other kinds of mail). */
export async function receiveSloanEmail(
  deps: { db: Db; content: ContentStore; registry: EventTypeRegistry },
  mail: SloanEmail,
  options: { domain: string },
): Promise<SloanEmailOutcome | null> {
  if (!isSloanAddress(mail.to, options.domain)) return null;
  const target = parseAgentAddress(mail.to, options.domain);
  if (!target) return null;
  const { tenantId } = target;
  const dropped = (reason: string, known = true): SloanEmailOutcome => ({
    status: "dropped",
    tenantId: known ? tenantId : null,
    reason,
    fresh: [],
    events: [],
    replies: [],
  });
  return withTenant(deps.db, tenantId, async (tx) => {
    const [client] = await tx
      .select({ name: tenant.name, retiredAt: tenant.retiredAt })
      .from(tenant)
      .where(eq(tenant.id, tenantId));
    if (!client || client.retiredAt) return dropped("unknown_address", false);
    const expected = sloanAddress({ clientName: client.name, tenantId, domain: options.domain });
    if (!sameAgentAddress(expected, mail.to)) return dropped("unknown_address");
    // DECISION: with Sloan off (`sloan: off`, paused, retired) the address has no inbox, as an
    // agent with no email trigger has none: dropped, never answered.
    if (!(await sloanIsOn(tx, tenantId))) return dropped("sloan_off");
    if (mail.size > MAX_FORWARDED_BYTES) return dropped("too_large");
    let parsed: Awaited<ReturnType<typeof parseForwardedEmail>>;
    let reply: Awaited<ReturnType<typeof parseReplyEmail>>;
    try {
      parsed = await parseForwardedEmail(mail.raw, { envelopeFrom: mail.from });
      reply = await parseReplyEmail(mail.raw);
    } catch {
      return dropped("unreadable");
    }
    const h = parsed.headers;
    // An auto-reply or bounce starts nothing; mail a system wrote is never answered (§1.48).
    if (h.automatic !== null) return dropped("automatic");
    const proven = trustedFromHeader(h.from, h.dmarcPassFrom) ? h.from : null;
    const person = proven ? await clientPersonByEmail(tx, tenantId, proven) : null;
    const locale = await tenantLocale(tx, tenantId);
    const messageId = h.messageId?.slice(0, 300) ?? null;
    if (!person) {
      const events: EventRow[] = [];
      await noteStranger(tx, {
        tenantId,
        agentName: SLOAN_NAME,
        channel: "email",
        from: proven ?? mail.from,
        locale,
        registry: deps.registry,
        collect: events,
      });
      const polite = strangerReply({
        channel: "email",
        agentName: SLOAN_NAME,
        locale,
        to: proven,
        key: `sloan:${messageId ?? mail.from}`,
      });
      return {
        status: "refused",
        tenantId,
        reason: "sender_not_allowed",
        fresh: [],
        events,
        replies: polite ? [polite] : [],
      };
    }
    // The same message twice (Email Routing retries, a resend): one message, one answer.
    if (messageId) {
      const [seen] = await tx
        .select({ id: message.id })
        .from(message)
        .where(
          and(
            eq(message.tenantId, tenantId),
            eq(message.senderId, person.userId),
            sql`${message.body}->'email'->>'messageId' = ${messageId}`,
          ),
        )
        .limit(1);
      if (seen) return dropped("duplicate");
    }
    // The person's words, quoted history cut, cards redacted (as an agent's mail is kept).
    const text = inboundText(reply.text).trim();
    // As forwarded mail: a part whose bytes aren't its type, or that the store refuses (empty, too
    // large), is skipped and the rest kept (INPUT-6).
    const attachments = attachmentsToKeep(parsed.attachments, MAX_ATTACHMENTS).kept;
    if (!text && attachments.length === 0) return dropped("empty");
    const events: EventRow[] = [];
    const documents: string[] = [];
    const fresh: string[] = [];
    if (attachments.length > 0) {
      const conn = await ensureUploadConnection(tx, tenantId);
      const meta = {
        email: {
          from: h.from,
          to: mail.to.toLowerCase(),
          subject: h.subject,
          date: h.date,
          messageId: h.messageId,
          authenticated: true,
          authenticatedAs: proven,
          sloan: true,
        },
      };
      const files = await storeEmailAttachments(tx, deps.content, {
        tenantId,
        connectionId: conn.id,
        attachments,
        meta,
      });
      for (const d of files.documents) {
        documents.push(d.id);
        if (d.created) fresh.push(d.id);
      }
      events.push(...files.events);
    }
    await postToSloan(tx, {
      tenantId,
      person,
      channel: "email",
      // A message of files alone still says so, so Sloan reads it as a message.
      text: text || "(files attached)",
      documents,
      extra: {
        email: { subject: h.subject?.slice(0, 300) ?? null, messageId },
      },
      registry: deps.registry,
      collect: events,
    });
    return { status: "accepted", tenantId, reason: null, fresh, events, replies: [] };
  });
}

// ── Where to reach Sloan ────────────────────────────────────────────────────────────────────────

export interface SloanReach {
  /** Sloan's address, or null when email isn't set up here (no forwarding domain) or Sloan is off. */
  email: string | null;
  /** The account's number for texts, or null when it has none that can text yet. */
  phone: string | null;
}

/** Where the client's people email and text Sloan, read in the client's transaction. */
export async function sloanReach(
  tx: Tx,
  tenantId: string,
  domain: string | null | undefined,
): Promise<SloanReach> {
  const [t] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  if (!t || !(await sloanIsOn(tx, tenantId))) return { email: null, phone: null };
  const d = domain?.trim();
  const sms = await channelFor(tx, tenantId, null, "sms");
  return {
    email: d ? sloanAddress({ clientName: t.name, tenantId, domain: d }) : null,
    // Only the client's own number on Twilio: texts to it reach the inbound path that finds Sloan.
    phone: sms?.connector === TWILIO_CONNECTOR_ID ? sms.address : null,
  };
}

/** The account's texting line is this connection (texts to an agent's own number aren't Sloan's). */
export async function isAccountTextLine(
  tx: Tx,
  tenantId: string,
  connectionId: string,
): Promise<boolean> {
  const sms = await channelFor(tx, tenantId, null, "sms");
  return sms?.connectionId === connectionId;
}

/**
 * An agent is waiting on this contact (an open reach-out, or a conversation's message waiting for
 * its signature): their text is that agent's reply (§1.48), never Sloan's.
 */
export async function waitedOnByAnAgent(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<boolean> {
  const [open] = await tx
    .select({ id: reachOut.id })
    .from(reachOut)
    .where(
      and(
        eq(reachOut.tenantId, tenantId),
        eq(reachOut.contactId, contactId),
        or(
          eq(reachOut.status, "open"),
          and(eq(reachOut.status, "awaiting_approval"), sql`${reachOut.subject} like 'converse:%'`),
        ),
      ),
    )
    .limit(1);
  return !!open;
}

/** A connected Twilio connection of the client, for sending Sloan's text from the number written to. */
export async function twilioConnectionOf(tx: Tx, tenantId: string, connectionId: string) {
  const [row] = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.id, connectionId),
        eq(connection.connector, TWILIO_CONNECTOR_ID),
        eq(connection.status, "connected"),
      ),
    );
  return row && readTwilioConfig(row.config) ? row : null;
}
