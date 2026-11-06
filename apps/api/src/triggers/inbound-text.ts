// A text or WhatsApp message to a number bound to an agent's channel (ARCHITECTURE §10.8; docs/plan.md
// §1.48 "Inbound messages"), in the Twilio webhook's transaction, after `message.received`. An agent
// whose `sms` / `whatsapp` channel is bound to the connection the message came in on, and which has
// a message trigger on that channel, gets `inbound.message` when a trigger's People filter takes the
// sender; otherwise the sender gets the polite fixed reply from the same number and the lead a note.
// The message's text stays in Twilio's raw record (read with `inbound.get`); the event carries ids.

import {
  acceptingTriggers,
  INBOUND_MESSAGE_EVENT,
  type InboundMessagePayload,
  messageTriggersOn,
  type SenderFacts,
} from "@countersign/core";
import { agent, agentVersion, reachOut, type Tx } from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { and, eq, isNotNull } from "drizzle-orm";
import type { ContactRow } from "../messaging/contacts";
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
  const rows = await tx
    .select({
      id: agent.id,
      channels: agent.channels,
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
      r.channels?.[input.channel] === input.connectionId &&
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
          eq(reachOut.status, "open"),
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
        // Texts always get the reply, from the number they were sent to; never to someone who
        // opted out.
        if (!input.contact.optedOutAt) {
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
