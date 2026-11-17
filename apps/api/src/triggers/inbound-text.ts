// A text or WhatsApp message to a number bound to an agent's channel (ARCHITECTURE §10.8; docs/plan.md
// §1.48 "Inbound messages"), in the Twilio webhook's transaction, after `message.received`. An agent
// whose `sms` / `whatsapp` channel resolves to the connection the message came in on (its own
// binding, or the account's number when it has none: R4, ../channels/resolve.ts `agentsListeningOn`),
// and which has a message trigger on that channel, gets `inbound.message` when a trigger's People filter takes the
// sender; otherwise the sender gets the polite fixed reply from the same number and the lead a note.
// The message's text stays in Twilio's raw record (read with `inbound.get`); the event carries ids.

import {
  acceptingTriggers,
  E164_RE,
  INBOUND_MESSAGE_EVENT,
  type InboundMessagePayload,
  messageTriggersOn,
  type SenderFacts,
} from "@countersign/core";
import { agent, agentVersion, contactChange, reachOut, type Tx } from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { agentsListeningOn } from "../channels/resolve";
import { type ContactRow, logContactChange } from "../messaging/contacts";
import { tenantLocale } from "../routes/language";
import { confirmReply, type InboundReply, noteStranger, strangerReply } from "./replies";
import { contactFacts } from "./senders";

export async function routeInboundText(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    channel: "sms" | "whatsapp";
    sid: string;
    contact: ContactRow;
    /** False when the contact was made for this message: the sender is a stranger. */
    knownContact: boolean;
    rawRecordId: string;
    /** The sender's number and the client's number it came in on. */
    from: string;
    to: string;
    now: Date;
    registry: EventTypeRegistry;
    collect: EventRow[];
    // v0.14 capture
    /** The conversation's capture agent: told after the downloads, so not here (§1.55). */
    skipAgentId?: string | null;
  },
): Promise<InboundReply[]> {
  const { tenantId } = input;
  // R4: the agents listening on this number, by the same resolver that picks what they send on.
  const listening = new Set(
    await agentsListeningOn(tx, tenantId, input.channel, input.connectionId),
  );
  const rows = await tx
    .select({
      id: agent.id,
      bundle: agentVersion.bundle,
    })
    .from(agent)
    .innerJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
    )
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.runStatus, "active"),
        eq(agent.testCopy, false),
        isNotNull(agent.liveVersionId),
      ),
    );
  const bound = rows.filter(
    (r) =>
      // v0.14 capture
      r.id !== input.skipAgentId &&
      listening.has(r.id) &&
      messageTriggersOn(r.bundle, input.channel).length > 0,
  );
  if (bound.length === 0) return [];
  const facts: SenderFacts = input.knownContact
    ? contactFacts(input.contact)
    : { kind: "stranger" };
  const locale = await tenantLocale(tx, tenantId);
  const replies: InboundReply[] = [];
  let noted = false;
  for (const r of bound) {
    // DECISION: a text from someone this agent is waiting on (an open reach-out) is their reply,
    // matched by reach out as before; it doesn't also start a new run.
    const [open] = await tx
      .select({ id: reachOut.id })
      .from(reachOut)
      .where(
        and(
          eq(reachOut.tenantId, tenantId),
          eq(reachOut.agentId, r.id),
          eq(reachOut.contactId, input.contact.id),
          // P-4: a conversation's message waiting for its signature counts as open too (§1.66).
          or(
            eq(reachOut.status, "open"),
            and(
              eq(reachOut.status, "awaiting_approval"),
              sql`${reachOut.subject} like 'converse:%'`,
            ),
          ),
        ),
      )
      .limit(1);
    if (open) continue;
    const agentName = r.bundle.definition.identity.name;
    const accepting = acceptingTriggers(r.bundle, input.channel, facts);
    if (accepting.length === 0) {
      if (!noted) {
        noted = true;
        await noteStranger(tx, {
          tenantId,
          agentName,
          channel: input.channel,
          from: input.from,
          locale,
          registry: input.registry,
          collect: input.collect,
        });
        // Texts get the reply, from the number they were sent to: never to someone who opted
        // out, to an automated sender, or more than once a day to the same sender.
        if (!input.contact.optedOutAt && (await mayAnswer(tx, input))) {
          const polite = strangerReply({
            channel: input.channel,
            agentName,
            locale,
            to: input.from,
            from: input.to,
            key: input.sid,
          });
          if (polite) replies.push(polite);
        }
      }
      continue;
    }
    const payload: InboundMessagePayload = {
      agentId: r.id,
      channel: input.channel,
      contactId: input.contact.id,
      userId: null,
      rawRecordId: input.rawRecordId,
      documents: [],
      receivedAt: input.now.toISOString(),
    };
    const ev = await emit(
      tx,
      {
        tenantId,
        type: INBOUND_MESSAGE_EVENT,
        subjectType: "raw_record",
        subjectId: input.rawRecordId,
        payload,
      },
      { registry: input.registry },
    );
    if (ev) input.collect.push(ev);
    const confirm = accepting.find((t) => t.on.reply)?.on.reply?.confirm;
    if (confirm && !input.contact.optedOutAt) {
      const c = confirmReply({
        channel: input.channel,
        confirm,
        agentName,
        locale,
        to: input.from,
        from: input.to,
        key: `${input.sid}:${r.id}`,
      });
      if (c) replies.push(c);
    }
  }
  return replies;
}

/** The polite reply's limit: one per sender per client in this window. */
const STRANGER_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** NANP toll-free area codes: numbers that businesses and automated systems send from. */
const TOLL_FREE = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Whether a sender looks automated: a short code or an alphanumeric sender (not a full
 * international number), a NANP number that isn't a real one or is toll-free, or the client's own
 * number. Their messages get no polite reply, so two automatic responders can't answer each other.
 */
// DECISION: judged from the number alone (no carrier lookup, which costs per number): a full
// international number of at least nine digits, and for +1 a valid area code and exchange that
// isn't toll-free.
export function looksAutomated(from: string, to: string): boolean {
  if (from === to || !E164_RE.test(from) || from.length < 10) return true;
  if (from.startsWith("+1")) {
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(from)) return true;
    return TOLL_FREE.has(from.slice(2, 5));
  }
  return false;
}

/**
 * Whether the polite reply may go to this sender, recorded on their contact when it may: at most
 * one per sender per client a day, never to an automated sender.
 */
// DECISION: counted from the contact's own log (`contact_change` kind `stranger_reply`), as text
// invitations are, under an advisory lock on the client and the sender, so two messages at once
// get one reply. Counted when decided, before it is sent: a reply that then fails still counts.
async function mayAnswer(
  tx: Tx,
  input: {
    tenantId: string;
    channel: "sms" | "whatsapp";
    contact: ContactRow;
    from: string;
    to: string;
    now: Date;
  },
): Promise<boolean> {
  if (looksAutomated(input.from, input.to)) return false;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`stranger-reply:${input.tenantId}:${input.channel}:${input.from}`}, 0))`,
  );
  const [recent] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contactChange)
    .where(
      and(
        eq(contactChange.tenantId, input.tenantId),
        eq(contactChange.contactId, input.contact.id),
        gt(contactChange.createdAt, new Date(input.now.getTime() - STRANGER_REPLY_WINDOW_MS)),
        sql`${contactChange.change}->>'kind' = 'stranger_reply'`,
        sql`${contactChange.change}->>'channel' = ${input.channel}`,
      ),
    );
  if ((recent?.n ?? 0) > 0) return false;
  await logContactChange(tx, input.tenantId, input.contact.id, null, {
    kind: "stranger_reply",
    channel: input.channel,
  });
  return true;
}
