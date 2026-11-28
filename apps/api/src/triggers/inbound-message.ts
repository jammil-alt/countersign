// What every message to an agent shares once its carrier is behind it (docs/plan.md §1.48
// "Inbound messages"): the raw record `InboundMessage` its words are kept as on the client's upload
// connection (one per key, so a retry or a resend is one record), and the `inbound.message` event
// the router starts the agent's message triggers from. An email to the agent's address
// (./inbound-email.ts), a text to its number (./inbound-text.ts, whose words stay in Twilio's own
// record) and a test message in the Sandbox (./test-message.ts) all go through here.

import { UPLOAD_CONNECTOR_ID } from "@countersign/connectors";
import {
  INBOUND_MESSAGE_ENTITY,
  INBOUND_MESSAGE_EVENT,
  type InboundMessagePayload,
} from "@countersign/core";
import { rawRecord, type Tx } from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";

/** Whether the client's upload connection already keeps a message with this key. */
export async function inboundMessageSeen(
  tx: Tx,
  input: { tenantId: string; connectionId: string; key: string },
): Promise<boolean> {
  const [seen] = await tx
    .select({ id: rawRecord.id })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, input.tenantId),
        eq(rawRecord.connectionId, input.connectionId),
        eq(rawRecord.entityType, INBOUND_MESSAGE_ENTITY),
        eq(rawRecord.externalId, input.key),
      ),
    )
    .limit(1);
  return seen !== undefined;
}

/**
 * Keeps a message to an agent as the raw record `InboundMessage` on the upload connection. Its
 * `payload` is what `inbound.get` reads (`agentId`, `channel`, `text`, …): the sender's words are
 * data, never instructions (invariant 9). Null when a record with this key is kept already.
 */
export async function storeInboundMessage(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    key: string;
    payload: { agentId: string; channel: string; text: string } & Record<string, unknown>;
    now: Date;
  },
): Promise<string | null> {
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      connector: UPLOAD_CONNECTOR_ID,
      entityType: INBOUND_MESSAGE_ENTITY,
      externalId: input.key,
      externalVersion: null,
      payload: input.payload,
      syncedAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  return stored?.id ?? null;
}

/** Emits `inbound.message` for one agent about the raw record that keeps the message. */
export async function emitInboundMessage(
  tx: Tx,
  registry: EventTypeRegistry,
  input: {
    tenantId: string;
    agentId: string;
    channel: InboundMessagePayload["channel"];
    contactId: string | null;
    rawRecordId: string;
    documents: string[];
    now: Date;
  },
): Promise<EventRow | null> {
  const payload: InboundMessagePayload = {
    agentId: input.agentId,
    channel: input.channel,
    contactId: input.contactId,
    userId: null,
    rawRecordId: input.rawRecordId,
    documents: input.documents,
    receivedAt: input.now.toISOString(),
  };
  return emit(
    tx,
    {
      tenantId: input.tenantId,
      type: INBOUND_MESSAGE_EVENT,
      subjectType: "raw_record",
      subjectId: input.rawRecordId,
      payload,
    },
    { registry },
  );
}
