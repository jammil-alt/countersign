// The platform services messaging connectors call (packages/connectors' MessagingServices), over
// the client's contacts: each call is one short withTenant transaction for the connection's client,
// so a send can only ever see and record its own client's contacts (invariant 1).

import type {
  ConnectionRef,
  ConnectorServices,
  MessagingServices,
  OutboundMessage,
  SendAttempt,
} from "@countersign/connectors";
import {
  type StoredMessageQuery,
  type StoredMessageRecord,
  TWILIO_ATTEMPT_ENTITY,
  TWILIO_MESSAGE_ENTITY,
  // v0.14 W4-A
  TWILIO_STATUS_ENTITY,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  type ContactConsent,
  consentBlock,
  inQuietHours,
  type MessagingChannel,
  sendBlockMessage,
} from "@countersign/core";
import {
  contact,
  type Db,
  externalAction,
  message,
  rawRecord,
  run,
  type Tx,
  tenant,
  usageDaily,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
// v0.14 W4-C
import { dbWriteAttempts } from "../attempts";
import type { VoiceDeps } from "../calls/answer";
import { dbVoiceServices } from "../calls/services";
// v0.14 capture
import { captureFactsOf } from "../conversations/capture";
import type { Platform } from "../platform";
import { dbEmailServices } from "../reach/email";
import {
  contactLanguage,
  contactThread,
  findContactByNumber,
  getContact,
  lastTextAt,
  messagingSettings,
  type ThreadMessageBody,
} from "./contacts";

/** The newest message this number sent us on this channel (for WhatsApp's 24-hour window). */
export async function lastInboundAt(
  tx: Tx,
  tenantId: string,
  channel: MessagingChannel,
  from: string,
  // v0.14 W4-A: Meta's window is per business number: only messages to this connection count.
  connectionId?: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: rawRecord.syncedAt })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        ...(connectionId ? [eq(rawRecord.connectionId, connectionId)] : []),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        sql`${rawRecord.payload}->>'direction' = 'in'`,
        sql`${rawRecord.payload}->>'channel' = ${channel}`,
        sql`${rawRecord.payload}->>'from' = ${from}`,
      ),
    )
    .orderBy(desc(rawRecord.syncedAt))
    .limit(1);
  return row?.at ?? null;
}

/** The client's name, as its contacts know it. */
async function clientNameOf(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx.select({ name: tenant.name }).from(tenant).where(eq(tenant.id, tenantId));
  return row?.name ?? "";
}

export function dbMessagingServices(db: Db, connection: ConnectionRef): MessagingServices {
  const tenantId = connection.tenantId;
  return {
    checkSend(input) {
      return withTenant(db, tenantId, async (tx) => {
        const c = await findContactByNumber(tx, tenantId, input.channel, input.to);
        if (!c) {
          return {
            ok: false as const,
            block: "no_contact" as const,
            message: "that number is not one of this client's contacts",
          };
        }
        const block = consentBlock(
          {
            phone: c.phone,
            whatsapp: c.whatsapp,
            consent: (c.consent ?? {}) as ContactConsent,
            optedOutAt: c.optedOutAt,
          },
          input.channel,
        );
        if (block) return { ok: false as const, block, message: sendBlockMessage(block) };
        if (!input.ignoreQuietHours) {
          const s = await messagingSettings(tx, tenantId);
          if (inQuietHours(input.now, s.timezone, s.quietHours)) {
            return {
              ok: false as const,
              block: "quiet_hours" as const,
              message: `${sendBlockMessage("quiet_hours", { until: `${s.quietHours.end} (${s.timezone})` })}; send it again after that`,
            };
          }
        }
        // §1.97: the first text (or the first in 30 days) names the client and offers STOP.
        const texts =
          input.channel === "sms"
            ? {
                lastTextAt: await lastTextAt(tx, tenantId, c.id),
                client: await clientNameOf(tx, tenantId),
              }
            : {};
        return {
          ok: true as const,
          ...texts,
          // The language to write to them in (§1.27): theirs, their organization's, the client's.
          contact: { id: c.id, name: c.name, language: (await contactLanguage(tx, c)).language },
          lastInboundAt: await lastInboundAt(
            tx,
            tenantId,
            input.channel,
            input.to,
            connection.connector === WHATSAPP_META_CONNECTOR_ID ? connection.id : undefined,
          ),
        };
      });
    },

    sentFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ externalId: rawRecord.externalId, payload: rawRecord.payload })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
              sql`${rawRecord.payload}->>'idempotencyKey' = ${idempotencyKey}`,
            ),
          )
          .limit(1);
        if (!row) return null;
        const p = row.payload as {
          status?: string;
          channel?: MessagingChannel;
          to?: string;
          from?: string;
          templateId?: string | null;
          contactId?: string;
        };
        const to = p.to ?? "";
        // Not getContact: a sent message is returned even if its contact was removed since.
        const [who] = p.contactId
          ? await tx
              .select({ name: contact.name })
              .from(contact)
              .where(and(eq(contact.id, p.contactId), eq(contact.tenantId, tenantId)))
          : [];
        return {
          sid: row.externalId,
          status: p.status ?? "queued",
          channel: p.channel ?? "sms",
          to,
          from: p.from ?? "",
          templateId: p.templateId ?? null,
          contactId: p.contactId ?? "",
          contactName: who?.name ?? to,
        };
      });
    },

    startAttempt(a) {
      return withTenant(db, tenantId, async (tx) => {
        // Once per key (the raw record's external id): a second start keeps the first.
        await tx
          .insert(rawRecord)
          .values({
            tenantId,
            connectionId: connection.id,
            // v0.14 W4-A: the connection's own connector (Twilio or Meta).
            connector: connection.connector,
            entityType: TWILIO_ATTEMPT_ENTITY,
            externalId: a.idempotencyKey,
            externalVersion: null,
            payload: { ...a, startedAt: a.startedAt.toISOString() },
            syncedAt: a.startedAt,
          })
          .onConflictDoNothing();
      });
    },

    attemptFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ payload: rawRecord.payload })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.entityType, TWILIO_ATTEMPT_ENTITY),
              eq(rawRecord.externalId, idempotencyKey),
            ),
          )
          .limit(1);
        if (!row) return null;
        const p = row.payload as Omit<SendAttempt, "startedAt"> & { startedAt: string };
        return { ...p, startedAt: new Date(p.startedAt) };
      });
    },

    recordedSids(sids) {
      if (sids.length === 0) return Promise.resolve([]);
      return withTenant(db, tenantId, async (tx) => {
        const rows = await tx
          .select({ sid: rawRecord.externalId })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
              inArray(rawRecord.externalId, [...sids]),
            ),
          );
        return rows.map((r) => r.sid);
      });
    },

    // v0.14 capture: what the platform keeps of these messages (docs/plan.md §1.55).
    messageFacts(sids) {
      return withTenant(db, tenantId, (tx) =>
        captureFactsOf(tx, tenantId, connection.id, sids.slice(0, 100)),
      );
    },

    recordOutbound(m) {
      return withTenant(db, tenantId, (tx) =>
        recordOutboundTx(tx, tenantId, m, connection.connector),
      );
    },

    // v0.14 W4-A: Meta's reads and lost answers, from what was recorded on the connection.
    storedMessages(q) {
      return withTenant(db, tenantId, (tx) => storedMessagesOf(tx, connection, q));
    },
    storedMessage(sid) {
      return withTenant(db, tenantId, async (tx) => {
        const [one] = await storedMessagesOf(tx, connection, { limit: 1 }, sid);
        return one ?? null;
      });
    },
    statusSidFor(idempotencyKey) {
      return withTenant(db, tenantId, async (tx) => {
        const [row] = await tx
          .select({ payload: rawRecord.payload })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, tenantId),
              eq(rawRecord.connectionId, connection.id),
              eq(rawRecord.entityType, TWILIO_STATUS_ENTITY),
              sql`${rawRecord.payload}->>'opaque' = ${idempotencyKey}`,
            ),
          )
          .orderBy(desc(rawRecord.syncedAt))
          .limit(1);
        const p = (row?.payload ?? {}) as { sid?: unknown; status?: unknown };
        return typeof p.sid === "string" && typeof p.status === "string"
          ? { sid: p.sid, status: p.status }
          : null;
      });
    },
  };
}

// v0.14 W4-A: messages recorded on a connection as `messages.search` and `message.get` return
// them, newest first, with their capture facts (text hidden where it wasn't kept) and the latest
// status a callback gave (raw records are never changed, so statuses are their own rows).
async function storedMessagesOf(
  tx: Tx,
  conn: ConnectionRef,
  q: StoredMessageQuery,
  sid?: string,
): Promise<StoredMessageRecord[]> {
  const tenantId = conn.tenantId;
  const p = rawRecord.payload;
  const rows = await tx
    .select({ sid: rawRecord.externalId, payload: p, at: rawRecord.syncedAt })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, conn.id),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        ...(sid ? [eq(rawRecord.externalId, sid)] : []),
        ...(q.channel ? [sql`${p}->>'channel' = ${q.channel}`] : []),
        ...(q.contact ? [sql`(${p}->>'from' = ${q.contact} or ${p}->>'to' = ${q.contact})`] : []),
        ...(q.since ? [gte(rawRecord.syncedAt, new Date(`${q.since}T00:00:00Z`))] : []),
      ),
    )
    .orderBy(desc(rawRecord.syncedAt))
    .limit(Math.min(Math.max(q.limit, 1), 50));
  if (rows.length === 0) return [];
  const sids = rows.map((r) => r.sid);
  const statuses = await tx
    .select({ payload: rawRecord.payload })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, conn.id),
        eq(rawRecord.entityType, TWILIO_STATUS_ENTITY),
        inArray(sql<string>`${rawRecord.payload}->>'sid'`, sids),
      ),
    )
    .orderBy(rawRecord.syncedAt);
  const latest = new Map<string, { status: string; errorCode: string | null }>();
  for (const s of statuses) {
    const sp = s.payload as { sid?: unknown; status?: unknown; errorCode?: unknown };
    if (typeof sp.sid === "string" && typeof sp.status === "string") {
      latest.set(sp.sid, {
        status: sp.status,
        errorCode: typeof sp.errorCode === "string" ? sp.errorCode : null,
      });
    }
  }
  const facts = await captureFactsOf(tx, tenantId, conn.id, sids);
  return rows.map((r) => {
    const m = r.payload as {
      direction?: unknown;
      channel?: unknown;
      from?: unknown;
      to?: unknown;
      text?: unknown;
      status?: unknown;
      numMedia?: unknown;
    };
    const f = facts.get(r.sid);
    const st = latest.get(r.sid);
    const text = typeof m.text === "string" ? m.text : "";
    const recorded =
      typeof m.status === "string" ? m.status : m.direction === "in" ? "received" : "sent";
    return {
      sid: r.sid,
      direction: m.direction === "in" ? ("in" as const) : ("out" as const),
      channel: m.channel === "sms" ? ("sms" as const) : ("whatsapp" as const),
      from: typeof m.from === "string" ? m.from : "",
      to: typeof m.to === "string" ? m.to : "",
      text: f && !f.kept ? "" : text,
      status: st?.status ?? recorded,
      sentAt: r.at.toISOString(),
      numMedia: typeof m.numMedia === "number" ? m.numMedia : 0,
      errorCode: st?.errorCode ?? null,
      ...(f ? { kept: f.kept, conversation: f.conversation, attachments: f.attachments } : {}),
    };
  });
}

async function recordOutboundTx(
  tx: Tx,
  tenantId: string,
  m: OutboundMessage,
  // v0.14 W4-A: the connection's own connector (Twilio or Meta).
  connector = "twilio",
): Promise<void> {
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId,
      connectionId: m.connectionId,
      connector,
      entityType: TWILIO_MESSAGE_ENTITY,
      externalId: m.sid,
      externalVersion: null,
      payload: {
        direction: "out",
        channel: m.channel,
        from: m.from,
        to: m.to,
        text: m.text,
        templateId: m.templateId,
        status: m.status,
        segments: m.segments,
        contactId: m.contactId,
        idempotencyKey: m.idempotencyKey,
      },
      syncedAt: m.sentAt,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  // Recorded before (a retried call): nothing more to count or show.
  if (!stored) return;

  const [action] = await tx
    .select({ agentVersionId: externalAction.agentVersionId, agentId: run.agentId })
    .from(externalAction)
    .leftJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.idempotencyKey, m.idempotencyKey),
      ),
    )
    .limit(1);

  const c = await getContact(tx, tenantId, m.contactId);
  const threadId = await contactThread(tx, c);
  const body: ThreadMessageBody = {
    direction: "out",
    channel: m.channel,
    text: m.text,
    sid: m.sid,
    rawRecordId: stored.id,
    status: m.status,
  };
  await tx.insert(message).values({
    tenantId,
    threadId,
    senderType: "agent",
    agentVersionId: action?.agentVersionId ?? null,
    body: body as unknown as Record<string, unknown>,
    sources: [stored.id],
  });

  // DECISION: messages are counted into usage_daily when the provider accepts them, once per
  // message id, against the client agent whose run sent them (UTC day, as the rollup counts).
  // The rollup leaves this column alone. Inbound messages are no agent's usage and aren't counted.
  if (action?.agentId) {
    await tx
      .insert(usageDaily)
      .values({
        tenantId,
        day: m.sentAt.toISOString().slice(0, 10),
        agentId: action.agentId,
        messages: 1,
      })
      .onConflictDoUpdate({
        target: [usageDaily.tenantId, usageDaily.day, usageDaily.agentId],
        set: { messages: sql`${usageDaily.messages} + 1` },
      });
  }
}

/**
 * For the runtime: platform services for every connector call (RuntimeDeps.services). Calls get
 * their services only where the deployment's voice settings are passed in.
 */
export function connectorServicesFor(
  db: Db,
  calls?: { voice: VoiceDeps; platform: Platform },
): (connection: ConnectionRef) => ConnectorServices {
  return (connection) => ({
    messaging: dbMessagingServices(db, connection),
    email: dbEmailServices(db, connection),
    // v0.14 W4-C: writes the provider takes no idempotency key for (Slack posts).
    attempts: dbWriteAttempts(db, connection),
    ...(calls ? { voice: dbVoiceServices(db, connection, calls) } : {}),
  });
}
