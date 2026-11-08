// v0.14 W4-A: Meta's WhatsApp deliveries, once their signature holds (docs/plan.md §1.57). Each
// message and status is routed by the number it came to (`phone_number_id`): the one client whose
// connected `whatsapp_meta` connection has that number gets it, in its own transaction; a number
// no client has (or, by mistake, more than one) is ignored, never given to a default client and
// never routed by the sender. A message is stored once per `wamid` (the raw record's unique key on
// the connection), so Meta's retries and replays do nothing. From there it follows Twilio's
// WhatsApp path (§1.22, §1.55): the contact (made with no consent if new), its conversation and
// capture setting, STOP and START, the thread line, `message.received` (no text), the agents'
// message triggers, and the attachments to fetch after the commit. Group messages are kept only
// where the client turned groups on, and start no agent and get no reply.

import {
  MESSAGE_RECEIVED_EVENT,
  MESSAGE_STATUS_EVENT,
  type MessageReceivedPayload,
  type MessageStatusPayload,
  type MetaInbound,
  type MetaStatus,
  readWhatsappMetaConfig,
  TWILIO_MESSAGE_ENTITY,
  TWILIO_STATUS_ENTITY,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  type ConversationCapture,
  captureAllows,
  keywordOf,
  redactCardNumbers,
} from "@countersign/core";
import {
  connection,
  type Db,
  message,
  rawRecord,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { type EventRow, type EventTypeRegistry, emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import {
  type ConversationRow,
  ensureDirectConversation,
  ensureGroupConversation,
  type StoredCapture,
  whatsappGroupsOn,
} from "../conversations/capture";
import { type CaptureParams, captureAgentOf } from "../conversations/media";
import {
  applyKeyword,
  contactThread,
  createContact,
  findContactByNumber,
  markThreadStatus,
  type ThreadMessageBody,
} from "../messaging/contacts";
// P-3: attachments both ways
import { replyMediaJob } from "../reach/reply-media";
import { routeInboundText } from "../triggers/inbound-text";
import type { InboundReply } from "../triggers/replies";

/** Meta's raw records use the platform's message entities, on the Meta connection. */
export const META_MESSAGE_ENTITY = TWILIO_MESSAGE_ENTITY;
export const META_STATUS_ENTITY = TWILIO_STATUS_ENTITY;

export interface MetaRoute {
  tenantId: string;
  connectionId: string;
  /** The client's number, E.164. */
  phoneNumber: string;
}

/**
 * The client and connection a number belongs to, or null (no client has it, or more than one).
 * Looked for in each client in turn (each in its own withTenant), as QuickBooks' webhook finds a
 * company: no table outside RLS learns which client has which number.
 */
// DECISION: never a default client: a number that isn't exactly one client's connected Meta
// number is ignored (plan §1.57). Embedded Signup refuses a number another client has, so two
// can only meet by an inconsistency, which delivers to neither.
export async function metaRouteFor(db: Db, phoneNumberId: string): Promise<MetaRoute | null> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  const found: MetaRoute[] = [];
  for (const client of clients) {
    const rows = await withTenant(db, client.id, (tx) =>
      tx
        .select({ id: connection.id, config: connection.config })
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, WHATSAPP_META_CONNECTOR_ID),
            eq(connection.status, "connected"),
            eq(connection.externalAccountId, phoneNumberId),
          ),
        ),
    );
    for (const r of rows) {
      const config = readWhatsappMetaConfig(r.config);
      if (config) {
        found.push({ tenantId: client.id, connectionId: r.id, phoneNumber: config.phoneNumber });
      }
    }
  }
  return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * Whether a client other than `tenantId` has this account connected for the connector (a sign-in's
 * `accountTaken`: Embedded Signup asks it for a WhatsApp number before changing anything at Meta).
 */
export async function accountTakenElsewhere(
  db: Db,
  input: { tenantId: string; connector: string; externalAccountId: string },
): Promise<boolean> {
  const clients = await db.select({ id: tenant.id }).from(tenant);
  for (const client of clients) {
    if (client.id === input.tenantId) continue;
    const [row] = await withTenant(db, client.id, (tx) =>
      tx
        .select({ id: connection.id })
        .from(connection)
        .where(
          and(
            eq(connection.tenantId, client.id),
            eq(connection.connector, input.connector),
            eq(connection.status, "connected"),
            eq(connection.externalAccountId, input.externalAccountId),
          ),
        )
        .limit(1),
    );
    if (row) return true;
  }
  return false;
}

export interface InboundOutcome {
  events: EventRow[];
  capture: CaptureParams | null;
  replies: InboundReply[];
  // P-3: a reach-out reply's PDFs and images, fetched after the commit (docs/plan.md §1.65).
  replyMedia?: CaptureParams | null;
}

/** One inbound message, in its client's transaction. Nothing happens for one seen before. */
export async function receiveMetaMessage(
  tx: Tx,
  route: MetaRoute,
  parsed: MetaInbound,
  ctx: { registry: EventTypeRegistry; now: Date },
): Promise<InboundOutcome> {
  const { tenantId, connectionId } = route;
  const out: InboundOutcome = { events: [], capture: null, replies: [] };
  const [seen] = await tx
    .select({ id: rawRecord.id })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        eq(rawRecord.entityType, META_MESSAGE_ENTITY),
        eq(rawRecord.externalId, parsed.wamid),
      ),
    )
    .limit(1);
  if (seen) return out;
  // A card number in a message is never stored (PCI DSS 3.3, docs/plan.md §1.35).
  const msg = { ...parsed, text: redactCardNumbers(parsed.text) };
  // DECISION: group messages only where the client turned groups on (off by default); otherwise
  // nothing of them is kept (plan §1.57).
  const group = msg.groupId !== null;
  if (group && !(await whatsappGroupsOn(tx, tenantId))) return out;

  let who = await findContactByNumber(tx, tenantId, "whatsapp", msg.from);
  const knownContact = who !== null;
  who ??= await createContact(
    tx,
    tenantId,
    { name: msg.profileName?.trim() || msg.from, whatsapp: msg.from },
    null,
    ctx.now,
  );
  const conv: ConversationRow =
    group && msg.groupId
      ? await ensureGroupConversation(tx, {
          tenantId,
          connectionId,
          externalId: msg.groupId,
          title: `WhatsApp group ${msg.groupId.slice(-6)}`,
        })
      : await ensureDirectConversation(tx, {
          tenantId,
          connectionId,
          channel: "whatsapp",
          contactId: who.id,
          title: who.name,
          knownContact,
        });
  const setting = conv.capture as ConversationCapture;
  const archive = setting.archive;
  const kept: StoredCapture = {
    conversationId: conv.id,
    archive,
    wanted: msg.media
      .filter((m) => m.mediaSid && captureAllows(setting, m.contentType))
      .map((m) => m.index),
  };
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId,
      connectionId,
      connector: WHATSAPP_META_CONNECTOR_ID,
      entityType: META_MESSAGE_ENTITY,
      externalId: msg.wamid,
      externalVersion: null,
      payload: {
        direction: "in",
        channel: "whatsapp",
        from: msg.from,
        to: route.phoneNumber,
        // With archiving off, only the envelope is kept (plan §1.55).
        text: archive ? msg.text : "",
        type: msg.type,
        numMedia: msg.media.length,
        // Index, declared type and Meta's media id: never a link.
        media: msg.media,
        profileName: msg.profileName,
        ...(msg.groupId ? { groupId: msg.groupId } : {}),
        ...(msg.sentAt ? { sentAt: msg.sentAt.toISOString() } : {}),
        capture: kept,
      },
      syncedAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  // A concurrent duplicate got here first: what it made stands.
  if (!stored) return out;
  if (kept.wanted.length > 0) {
    out.capture = {
      tenantId,
      connectionId,
      rawRecordId: stored.id,
      messageSid: msg.wamid,
      indexes: kept.wanted,
      reason: "inbound",
    };
  }
  // DECISION: STOP and START are acted on in direct chats only: in a group they are just words.
  const keyword = group ? null : keywordOf(msg.text);
  let contactRow = who;
  if (keyword) contactRow = await applyKeyword(tx, contactRow, keyword, "whatsapp", ctx.now);
  // P-3: a direct reply to an open reach-out keeps its PDFs and images (docs/plan.md §1.65).
  if (!group) {
    out.replyMedia = await replyMediaJob(tx, {
      tenantId,
      connectionId,
      rawRecordId: stored.id,
      messageSid: msg.wamid,
      contactId: contactRow.id,
      channel: "whatsapp",
      media: msg.media,
      keyword,
    });
  }

  const threadId = await contactThread(tx, contactRow);
  const body: ThreadMessageBody = {
    direction: "in",
    channel: "whatsapp",
    text: archive ? msg.text : "",
    sid: msg.wamid,
    rawRecordId: stored.id,
    status: null,
  };
  await tx.insert(message).values({
    tenantId,
    threadId,
    senderType: "contact",
    senderId: contactRow.id,
    body: body as unknown as Record<string, unknown>,
    sources: [stored.id],
  });
  const payload: MessageReceivedPayload = {
    connectionId,
    channel: "whatsapp",
    messageSid: msg.wamid,
    rawRecordId: stored.id,
    contactId: contactRow.id,
    knownContact,
    from: msg.from,
    to: route.phoneNumber,
    keyword,
    numMedia: msg.media.length,
    receivedAt: ctx.now.toISOString(),
  };
  const ev = await emit(
    tx,
    {
      tenantId,
      type: MESSAGE_RECEIVED_EVENT,
      subjectType: "raw_record",
      subjectId: stored.id,
      payload,
    },
    { registry: ctx.registry },
  );
  if (ev) out.events.push(ev);
  // Agents bound to this number start on a direct message (their triggers, the polite reply), as
  // on Twilio (§1.48); a group message starts nothing and gets no reply. Keywords are never
  // requests.
  if (!keyword && !group) {
    out.replies = await routeInboundText(tx, {
      tenantId,
      connectionId,
      channel: "whatsapp",
      sid: msg.wamid,
      contact: contactRow,
      knownContact,
      rawRecordId: stored.id,
      from: msg.from,
      to: route.phoneNumber,
      now: ctx.now,
      registry: ctx.registry,
      collect: out.events,
      skipAgentId: captureAgentOf(setting, kept.wanted),
    });
  }
  return out;
}

/** One status callback, in its client's transaction: stored once per (message, status). */
export async function receiveMetaStatus(
  tx: Tx,
  route: MetaRoute,
  st: MetaStatus,
  ctx: { registry: EventTypeRegistry; now: Date },
): Promise<EventRow[]> {
  const { tenantId, connectionId } = route;
  const [stored] = await tx
    .insert(rawRecord)
    .values({
      tenantId,
      connectionId,
      connector: WHATSAPP_META_CONNECTOR_ID,
      entityType: META_STATUS_ENTITY,
      externalId: `${st.wamid}:${st.status}`,
      externalVersion: null,
      payload: {
        sid: st.wamid,
        status: st.status,
        errorCode: st.errorCode,
        to: st.to,
        channel: "whatsapp",
        // The send's own key (biz_opaque_callback_data), for a send that lost Meta's answer.
        ...(st.opaque ? { opaque: st.opaque } : {}),
      },
      syncedAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: rawRecord.id });
  if (!stored) return [];
  await markThreadStatus(tx, tenantId, st.wamid, st.status);
  const payload: MessageStatusPayload = {
    connectionId,
    channel: "whatsapp",
    messageSid: st.wamid,
    rawRecordId: stored.id,
    status: st.status,
    errorCode: st.errorCode,
    to: st.to ?? "",
    at: ctx.now.toISOString(),
  };
  const ev = await emit(
    tx,
    {
      tenantId,
      type: MESSAGE_STATUS_EVENT,
      subjectType: "raw_record",
      subjectId: stored.id,
      payload,
    },
    { registry: ctx.registry },
  );
  return ev ? [ev] : [];
}
