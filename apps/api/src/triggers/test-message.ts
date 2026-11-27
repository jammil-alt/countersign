// A test message to a Sandbox agent (Sandbox inbound, 2026-11-27): an email, a text or a WhatsApp
// from one of the Sandbox's contacts, as it would come in once its carrier is behind it (no mail
// received, no Twilio, no DMARC: the operator names the sender, and the contact is taken as
// proven). From there it is the received message's own path: the agent must be one that takes
// messages (a client agent switched on with a live version, never a template's test copy), with a
// message trigger on the channel; a text from someone it waits on is their reply; the same People
// filter decides (`acceptingTriggers`), and a sender none takes is refused, the lead told as for a
// real one, and the polite reply reported instead of sent. A message a trigger takes is kept as
// the raw record `InboundMessage` on the Sandbox's upload connection, texts too (Twilio's record
// needs a number), and `inbound.message` is emitted, so the router starts the same live run;
// writes are signed in its trial as any (packages/core `effectiveMode`).

import { ensureUploadConnection } from "@countersign/connectors";
import {
  acceptingTriggers,
  inboundText,
  messageTriggersOn,
  pickLocalized,
  type TestMessageAnswer,
  type TestMessageChannel,
  triggerWords,
  uuidv7,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import type { EventRow, EventTypeRegistry } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import type { ContactRow } from "../messaging/contacts";
import { tenantLocale } from "../routes/language";
import { emitInboundMessage, storeInboundMessage } from "./inbound-message";
import { waitingOnReply } from "./inbound-text";
import { noteStranger } from "./replies";
import { contactFacts } from "./senders";

const CHANNEL_WORDS: Record<TestMessageChannel, { trigger: string; address: string }> = {
  email: { trigger: "email", address: "email address" },
  sms: { trigger: "text", address: "phone number" },
  whatsapp: { trigger: "WhatsApp", address: "WhatsApp number" },
};

/** The sender's address on the channel, as the real message would carry it. */
function addressOf(contact: ContactRow, channel: TestMessageChannel): string | null {
  if (channel === "email") return contact.email;
  return channel === "sms" ? contact.phone : contact.whatsapp;
}

export interface TestMessageOutcome {
  /** `started` is the caller's to say once the router has run: this says `accepted`. */
  answer: TestMessageAnswer;
  /** What was emitted, for the caller to dispatch once the transaction commits. */
  events: EventRow[];
}

export async function receiveTestMessage(
  tx: Tx,
  deps: { registry: EventTypeRegistry },
  input: {
    tenantId: string;
    agentId: string;
    channel: TestMessageChannel;
    contact: ContactRow;
    subject: string | null;
    text: string;
    documents: string[];
    /** The operator who sent it, kept on the record. */
    by: string;
    now: Date;
  },
): Promise<TestMessageOutcome> {
  const { tenantId, channel, contact } = input;
  const words = CHANNEL_WORDS[channel];
  const refused = (reason: string, message: string, reply: string | null = null) => ({
    answer: { status: "refused" as const, reason, message, reply },
    events: [],
  });
  const [row] = await tx
    .select({
      name: agent.name,
      kind: agent.kind,
      testCopy: agent.testCopy,
      runStatus: agent.runStatus,
      bundle: agentVersion.bundle,
    })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
    )
    .where(and(eq(agent.id, input.agentId), eq(agent.tenantId, tenantId)));
  if (row?.kind !== "client") {
    return refused("not_a_client_agent", "only a client agent takes messages");
  }
  if (row.testCopy) {
    return refused(
      "test_copy",
      "this is a template's test copy, which only test-runs: turn the template on in the Sandbox",
    );
  }
  const bundle = row.bundle;
  const agentName = bundle?.definition.identity.name ?? row.name;
  if (!bundle || row.runStatus !== "active") {
    return refused("agent_not_active", `${agentName} isn't on: start its trial first`);
  }
  if (messageTriggersOn(bundle, channel).length === 0) {
    return refused("no_trigger", `${agentName} has no ${words.trigger} trigger`);
  }
  const from = addressOf(contact, channel);
  if (!from) return refused("no_address", `${contact.name} has no ${words.address}`);
  if (
    channel !== "email" &&
    (await waitingOnReply(tx, { tenantId, agentId: input.agentId, contactId: contact.id }))
  ) {
    return refused(
      "waiting_on_reply",
      `${agentName} is waiting on ${contact.name}'s reply, so a ${words.trigger} from them is that reply, not a new request`,
    );
  }
  const locale = await tenantLocale(tx, tenantId);
  const accepting = acceptingTriggers(bundle, channel, contactFacts(contact));
  if (accepting.length === 0) {
    const events: EventRow[] = [];
    await noteStranger(tx, {
      tenantId,
      agentName,
      channel,
      from,
      locale,
      registry: deps.registry,
      collect: events,
    });
    return {
      answer: {
        status: "refused",
        reason: "sender_not_allowed",
        message: `${contact.name} isn't one of the people its ${words.trigger} trigger takes messages from`,
        reply: triggerWords(locale).strangerReply(agentName),
      },
      events,
    };
  }

  const conn = await ensureUploadConnection(tx, tenantId);
  const rawRecordId = await storeInboundMessage(tx, {
    tenantId,
    connectionId: conn.id,
    key: `${input.agentId}:test:${uuidv7(input.now.getTime())}`,
    payload: {
      agentId: input.agentId,
      channel,
      from,
      contactId: contact.id,
      subject: channel === "email" ? (input.subject?.slice(0, 300) ?? null) : null,
      date: input.now.toISOString(),
      messageId: null,
      // The sender's words: data for `inbound.get`, never instructions (invariant 9).
      text: inboundText(input.text),
      documents: input.documents,
      // Who sent it from the back office: no carrier ever saw it.
      test: { by: input.by },
    },
    now: input.now,
  });
  if (!rawRecordId) throw new Error("a test message's record was not kept");
  const events: EventRow[] = [];
  const ev = await emitInboundMessage(tx, deps.registry, {
    tenantId,
    agentId: input.agentId,
    channel,
    contactId: contact.id,
    rawRecordId,
    documents: input.documents,
    now: input.now,
  });
  if (ev) events.push(ev);
  const confirm = accepting.find((t) => t.on.reply)?.on.reply?.confirm;
  return {
    answer: {
      status: "accepted",
      rawRecordId,
      eventId: ev?.id ?? null,
      reply: confirm ? pickLocalized(confirm, locale) : null,
    },
    events,
  };
}
