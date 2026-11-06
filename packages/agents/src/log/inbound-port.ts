// v0.12 W2-E: the message behind `inbound.get` (InboundPort), read from the run's own trigger in
// one client-scoped transaction (invariant 1): an email to the agent (raw record `InboundMessage`,
// kept for this agent), a text or WhatsApp (Twilio's raw record `Message`), or a thread message (a
// command or a request Sloan passed). Only what the run's trigger points at is read.

import { INBOUND_MESSAGE_ENTITY, isUuid } from "@countersign/core";
import { appUser, contact, type Db, message, rawRecord, run, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import type { InboundMessageForTool, InboundPort } from "../tools/inbound";

/** Twilio's raw record of a message in or out (connectors' TWILIO_MESSAGE_ENTITY). */
const TWILIO_MESSAGE_ENTITY = "Message";
const CHANNELS = new Set(["email", "sms", "whatsapp", "command", "sloan"]);

interface TriggerPayload {
  channel?: unknown;
  contactId?: unknown;
  userId?: unknown;
  rawRecordId?: unknown;
  threadId?: unknown;
  messageId?: unknown;
  documents?: unknown;
}

const idOrNull = (v: unknown) => (typeof v === "string" && isUuid(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function dbInboundPort(db: Db): InboundPort {
  return {
    get(tenantId, input) {
      return withTenant(db, tenantId, async (tx) => {
        const [r] = await tx
          .select({ trigger: run.trigger, agentId: run.agentId })
          .from(run)
          .where(and(eq(run.id, input.runId), eq(run.tenantId, tenantId)));
        if (!r || r.agentId !== input.agentId) return null;
        const p = ((r.trigger as { payload?: unknown } | null)?.payload ??
          null) as TriggerPayload | null;
        const channel = str(p?.channel);
        if (!p || !channel || !CHANNELS.has(channel)) return null;
        const contactId = idOrNull(p.contactId);
        const userId = idOrNull(p.userId);
        const documents = Array.isArray(p.documents)
          ? p.documents.filter((d): d is string => typeof d === "string" && isUuid(d))
          : [];
        let name: string | null = null;
        if (contactId) {
          const [c] = await tx
            .select({ name: contact.name })
            .from(contact)
            .where(and(eq(contact.tenantId, tenantId), eq(contact.id, contactId)));
          name = c?.name ?? null;
        } else if (userId) {
          const [u] = await tx
            .select({ name: appUser.name })
            .from(appUser)
            .where(eq(appUser.id, userId));
          name = u?.name ?? null;
        }
        const from = { contactId, userId, name };

        const rawRecordId = idOrNull(p.rawRecordId);
        if (rawRecordId) {
          const [rec] = await tx
            .select({
              id: rawRecord.id,
              entityType: rawRecord.entityType,
              payload: rawRecord.payload,
              syncedAt: rawRecord.syncedAt,
            })
            .from(rawRecord)
            .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.id, rawRecordId)));
          if (!rec) return null;
          const body = (rec.payload ?? {}) as Record<string, unknown>;
          if (rec.entityType === INBOUND_MESSAGE_ENTITY) {
            // An email kept for another agent is not this one's to read.
            if (body.agentId !== input.agentId) return null;
          } else if (rec.entityType !== TWILIO_MESSAGE_ENTITY || body.direction !== "in") {
            return null;
          }
          const out: InboundMessageForTool = {
            channel: channel as InboundMessageForTool["channel"],
            from,
            subject: str(body.subject),
            text: str(body.text) ?? "",
            receivedAt: rec.syncedAt ? new Date(rec.syncedAt).toISOString() : null,
            documents,
            sources: [rec.id, ...documents],
          };
          return out;
        }

        const messageId = idOrNull(p.messageId);
        const threadId = idOrNull(p.threadId);
        if (messageId && threadId) {
          const [m] = await tx
            .select({ id: message.id, body: message.body, createdAt: message.createdAt })
            .from(message)
            .where(
              and(
                eq(message.tenantId, tenantId),
                eq(message.id, messageId),
                eq(message.threadId, threadId),
              ),
            );
          if (!m) return null;
          const body = (m.body ?? {}) as Record<string, unknown>;
          return {
            channel: channel as InboundMessageForTool["channel"],
            from,
            subject: null,
            // A command's words after `/name`; any other message's text.
            text: str(body.args) ?? str(body.text) ?? "",
            receivedAt: new Date(m.createdAt).toISOString(),
            documents,
            sources: [m.id],
          };
        }
        return null;
      });
    },
  };
}
