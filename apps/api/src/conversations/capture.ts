// v0.14 capture: WhatsApp conversations and their capture setting (ARCHITECTURE §6.12, docs/plan.md
// §1.55). Everything here runs in the caller's transaction for one client (invariant 1): reading
// and setting a conversation's capture with its change row, the client's default, and what each
// message of a conversation kept (text, attachments and their outcomes).

import { type MessageFacts, mediaSidOf, TWILIO_MESSAGE_ENTITY } from "@countersign/connectors";
import {
  type AttachmentView,
  type ConversationCapture,
  type ConversationChangeView,
  type ConversationMessageView,
  type ConversationView,
  defaultCaptureOf,
  initialCapture,
  isPlainObject,
  MediaOutcome,
  messageTriggersOn,
  StoredMedia,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  contact,
  conversation,
  conversationChange,
  rawRecord,
  type ConversationCapture as StoredConversationCapture,
  type Tx,
  tenant,
  tenantChange,
} from "@countersign/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";

/** One attachment's outcome: raw record `MessageMedia`, external id `<message sid>:<index>`. */
export const MESSAGE_MEDIA_ENTITY = "MessageMedia";
/** The capture agent was told about a message (once per message SID). */
export const CAPTURE_NOTIFIED_ENTITY = "MessageCaptureNotified";

export type ConversationRow = typeof conversation.$inferSelect;
export type ChangeSide = "client" | "operator" | "system";

/** What the inbound raw record keeps about capture (`payload.capture`). */
export interface StoredCapture {
  conversationId: string;
  archive: boolean;
  /** The attachments to fetch, by index (those the setting allowed when the message came in). */
  wanted: number[];
}

/** The column's shape: no `agentId` key unless one is set. */
function toStored(c: ConversationCapture): StoredConversationCapture {
  const { agentId, ...rest } = c;
  return agentId ? { ...rest, agentId } : rest;
}

export async function clientDefaultCapture(tx: Tx, tenantId: string): Promise<ConversationCapture> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!row) throw notFound("client");
  return defaultCaptureOf(row.settings);
}

export async function findDirectConversation(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  channel: "whatsapp" | "sms",
  contactId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(conversation)
    .where(
      and(
        eq(conversation.tenantId, tenantId),
        eq(conversation.connectionId, connectionId),
        eq(conversation.channel, channel),
        eq(conversation.kind, "direct"),
        eq(conversation.contactId, contactId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The contact's conversation on the connection, made on the first message with the client's
 * default (attachments off for someone who wasn't a contact before, with a system change row).
 */
export async function ensureDirectConversation(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    channel: "whatsapp";
    contactId: string;
    title: string;
    knownContact: boolean;
  },
): Promise<ConversationRow> {
  const existing = await findDirectConversation(
    tx,
    input.tenantId,
    input.connectionId,
    input.channel,
    input.contactId,
  );
  if (existing) return existing;
  const clientDefault = await clientDefaultCapture(tx, input.tenantId);
  const capture = initialCapture(clientDefault, input.knownContact);
  const [made] = await tx
    .insert(conversation)
    .values({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      channel: input.channel,
      kind: "direct",
      contactId: input.contactId,
      title: input.title.slice(0, 200) || "WhatsApp",
      capture: toStored(capture),
    })
    .onConflictDoNothing()
    .returning();
  if (!made) {
    const raced = await findDirectConversation(
      tx,
      input.tenantId,
      input.connectionId,
      input.channel,
      input.contactId,
    );
    if (!raced) throw new Error("conversation vanished after a conflicting insert");
    return raced;
  }
  if (capture.attachments !== clientDefault.attachments) {
    await tx.insert(conversationChange).values({
      tenantId: input.tenantId,
      conversationId: made.id,
      actorId: null,
      side: "system",
      change: {
        setting: "capture",
        before: clientDefault,
        after: capture,
        reason: "not a contact before this message",
      },
    });
  }
  return made;
}

export async function getConversation(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<ConversationRow> {
  const [row] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.tenantId, tenantId)));
  if (!row) throw notFound("conversation");
  return row;
}

/** An agent may be named only if it is this client's live agent with a WhatsApp message trigger. */
export async function checkCaptureAgent(
  tx: Tx,
  tenantId: string,
  agentId: string,
): Promise<string> {
  const [row] = await tx
    .select({ name: agent.name, bundle: agentVersion.bundle })
    .from(agent)
    .innerJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
    )
    .where(
      and(
        eq(agent.id, agentId),
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        isNotNull(agent.liveVersionId),
      ),
    );
  if (!row || messageTriggersOn(row.bundle, "whatsapp").length === 0) {
    throw new HttpError(
      422,
      "invalid_agent",
      "pick one of this client's agents that starts on WhatsApp messages",
    );
  }
  return row.name;
}

const sameCapture = (a: ConversationCapture, b: ConversationCapture) =>
  a.archive === b.archive &&
  a.attachments === b.attachments &&
  a.maxBytes === b.maxBytes &&
  (a.agentId ?? null) === (b.agentId ?? null);

/**
 * Sets a conversation's capture and writes its change row. The caller read `expectedUpdatedAt`; a
 * newer row is 409 `stale`, an unchanged setting 409 `no_op`.
 */
export async function setConversationCapture(
  tx: Tx,
  input: {
    tenantId: string;
    conversationId: string;
    next: ConversationCapture;
    expectedUpdatedAt: string;
    actorId: string | null;
    side: ChangeSide;
    reason?: string | undefined;
  },
): Promise<ConversationRow> {
  const [row] = await tx
    .select()
    .from(conversation)
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.tenantId, input.tenantId)),
    )
    .for("update");
  if (!row) throw notFound("conversation");
  if (Date.parse(input.expectedUpdatedAt) !== row.updatedAt.getTime()) {
    throw new HttpError(409, "stale", "someone changed this conversation; reload and try again");
  }
  const before = row.capture as ConversationCapture;
  if (sameCapture(before, input.next)) {
    throw new HttpError(409, "no_op", "nothing changed");
  }
  if (input.next.agentId && input.next.agentId !== before.agentId) {
    await checkCaptureAgent(tx, input.tenantId, input.next.agentId);
  }
  const [updated] = await tx
    .update(conversation)
    .set({ capture: toStored(input.next), updatedAt: new Date() })
    .where(
      and(eq(conversation.id, input.conversationId), eq(conversation.tenantId, input.tenantId)),
    )
    .returning();
  if (!updated) throw notFound("conversation");
  await tx.insert(conversationChange).values({
    tenantId: input.tenantId,
    conversationId: row.id,
    actorId: input.actorId,
    side: input.side,
    change: {
      setting: "capture",
      before,
      after: input.next,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return updated;
}

/** Sets the client's default (the operator's), with a `tenant_change` row. */
export async function setDefaultCapture(
  tx: Tx,
  input: {
    tenantId: string;
    capture: ConversationCapture;
    actorId: string;
    reason?: string | undefined;
  },
): Promise<ConversationCapture> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, input.tenantId));
  if (!t) throw notFound("client");
  const before = defaultCaptureOf(t.settings);
  const next: ConversationCapture = {
    archive: input.capture.archive,
    attachments: input.capture.attachments,
    maxBytes: input.capture.maxBytes,
  };
  if (sameCapture(before, next)) throw new HttpError(409, "no_op", "nothing changed");
  const settings = isPlainObject(t.settings) ? t.settings : {};
  const messaging = isPlainObject(settings.messaging) ? settings.messaging : {};
  await tx
    .update(tenant)
    .set({ settings: { ...settings, messaging: { ...messaging, capture: next } } })
    .where(eq(tenant.id, input.tenantId));
  await tx.insert(tenantChange).values({
    tenantId: input.tenantId,
    actorId: input.actorId,
    change: { setting: "messaging.capture", from: before, to: next },
    reason: input.reason || "capture default changed",
  });
  return next;
}

// ── Views ─────────────────────────────────────────────────────────────────────────────────────────

export async function conversationViews(
  tx: Tx,
  tenantId: string,
  only?: string,
): Promise<ConversationView[]> {
  const rows = await tx
    .select({ c: conversation, contactName: contact.name, agentName: agent.name })
    .from(conversation)
    .leftJoin(
      contact,
      and(eq(contact.id, conversation.contactId), eq(contact.tenantId, conversation.tenantId)),
    )
    .leftJoin(
      agent,
      and(
        sql`${agent.id}::text = ${conversation.capture}->>'agentId'`,
        eq(agent.tenantId, conversation.tenantId),
      ),
    )
    .where(and(eq(conversation.tenantId, tenantId), ...(only ? [eq(conversation.id, only)] : [])))
    .orderBy(desc(conversation.updatedAt))
    .limit(500);
  const last = await lastMessageTimes(
    tx,
    tenantId,
    rows.map((r) => r.c.id),
  );
  return rows.map(({ c, contactName, agentName }) => ({
    id: c.id,
    kind: c.kind,
    channel: c.channel,
    title: c.title,
    contact: c.contactId ? { id: c.contactId, name: contactName ?? c.title } : null,
    capture: c.capture as ConversationCapture,
    agentName: agentName ?? null,
    lastMessageAt: last.get(c.id) ?? null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));
}

/** The newest message per conversation, from the raw records that name it. */
async function lastMessageTimes(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const convId = sql<string>`${rawRecord.payload}->'capture'->>'conversationId'`;
  const rows = await tx
    .select({ id: convId, at: sql<Date>`max(${rawRecord.syncedAt})` })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        inArray(convId, [...ids]),
      ),
    )
    .groupBy(convId);
  return new Map(rows.map((r) => [r.id, new Date(r.at).toISOString()]));
}

export async function conversationChanges(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  surface: "ops" | "portal",
): Promise<ConversationChangeView[]> {
  const rows = await tx
    .select({ ch: conversationChange, name: appUser.name, email: appUser.email })
    .from(conversationChange)
    .leftJoin(appUser, eq(appUser.id, conversationChange.actorId))
    .where(
      and(
        eq(conversationChange.tenantId, tenantId),
        eq(conversationChange.conversationId, conversationId),
      ),
    )
    .orderBy(desc(conversationChange.createdAt))
    .limit(200);
  return rows.map(({ ch, name, email }) => {
    const change = (isPlainObject(ch.change) ? ch.change : {}) as {
      before?: unknown;
      after?: unknown;
      reason?: unknown;
    };
    // The portal calls the operator's side "us" and never names the operator's people.
    const by =
      ch.side === "system"
        ? null
        : surface === "portal" && ch.side === "operator"
          ? "us"
          : (name ?? email ?? null);
    const strip = (v: unknown) => {
      if (surface === "ops" || !isPlainObject(v)) return v ?? null;
      const { agentId: _agent, ...rest } = v;
      return rest;
    };
    return {
      id: ch.id,
      side: ch.side,
      by,
      before: strip(change.before),
      after: strip(change.after),
      reason: typeof change.reason === "string" ? change.reason : null,
      at: ch.createdAt.toISOString(),
    };
  });
}

/** The capture facts of an inbound raw record's payload, when it has them. */
export function storedCaptureOf(payload: unknown): StoredCapture | null {
  if (!isPlainObject(payload) || !isPlainObject(payload.capture)) return null;
  const c = payload.capture;
  if (typeof c.conversationId !== "string") return null;
  const wanted = Array.isArray(c.wanted)
    ? c.wanted.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < 10)
    : [];
  return { conversationId: c.conversationId, archive: c.archive !== false, wanted };
}

/** An inbound record's attachments as kept (new records: StoredMedia; older ones: links). */
export function storedMediaOf(payload: unknown, mediaSidOf: (link: string) => string | null) {
  if (!isPlainObject(payload) || !Array.isArray(payload.media)) return [];
  const out: StoredMedia[] = [];
  for (const [i, m] of payload.media.entries()) {
    const parsed = StoredMedia.safeParse(m);
    if (parsed.success) {
      out.push(parsed.data);
      continue;
    }
    // DECISION (plan §1.55): records made before v0.14 kept Twilio's link; only its media SID is
    // read out of it.
    if (isPlainObject(m) && typeof m.url === "string") {
      out.push({
        index: i,
        contentType: typeof m.contentType === "string" ? m.contentType : "",
        mediaSid: mediaSidOf(m.url),
      });
    }
  }
  return out.slice(0, 10);
}

/** The latest outcome per `<sid>:<index>` for these messages. */
export async function mediaOutcomes(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  sids: readonly string[],
): Promise<Map<string, { outcome: MediaOutcome; tries: number }>> {
  if (sids.length === 0) return new Map();
  const rows = await tx
    .select({
      externalId: rawRecord.externalId,
      version: rawRecord.externalVersion,
      payload: rawRecord.payload,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        eq(rawRecord.entityType, MESSAGE_MEDIA_ENTITY),
        inArray(sql<string>`split_part(${rawRecord.externalId}, ':', 1)`, [...sids]),
      ),
    );
  const out = new Map<string, { outcome: MediaOutcome; tries: number }>();
  for (const r of rows) {
    const parsed = MediaOutcome.safeParse(r.payload);
    if (!parsed.success) continue;
    const tries = Number(r.version ?? "1") || 1;
    const prior = out.get(r.externalId);
    if (!prior || prior.tries < tries) out.set(r.externalId, { outcome: parsed.data, tries });
  }
  return out;
}

/** Each attachment's state for screens and tools. */
export function attachmentViews(
  sid: string,
  media: readonly StoredMedia[],
  wanted: readonly number[],
  outcomes: Map<string, { outcome: MediaOutcome }>,
): AttachmentView[] {
  return media.map((m) => {
    const o = outcomes.get(`${sid}:${m.index}`)?.outcome;
    return {
      index: m.index,
      contentType: m.contentType,
      sizeBytes: o?.sizeBytes ?? null,
      status: o ? o.status : wanted.includes(m.index) ? "pending" : "not_downloaded",
      documentId: o?.documentId ?? null,
    };
  });
}

/**
 * For `message.get` and `messages.search`: each inbound WhatsApp message's conversation, whether
 * its text was kept and its attachments, by SID. Messages the platform keeps no capture for (texts,
 * ours) are left out, and the tool shows them as Twilio has them.
 */
export async function captureFactsOf(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  sids: readonly string[],
): Promise<Map<string, MessageFacts>> {
  const out = new Map<string, MessageFacts>();
  if (sids.length === 0) return out;
  const rows = await tx
    .select({ sid: rawRecord.externalId, payload: rawRecord.payload })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        inArray(rawRecord.externalId, [...sids]),
      ),
    );
  const stored: { sid: string; payload: unknown; capture: StoredCapture }[] = [];
  for (const r of rows) {
    const capture = storedCaptureOf(r.payload);
    if (capture) stored.push({ sid: r.sid, payload: r.payload, capture });
  }
  if (stored.length === 0) return out;
  const convIds = [...new Set(stored.map((r) => r.capture.conversationId))];
  const convs = await tx
    .select({ id: conversation.id, kind: conversation.kind, title: conversation.title })
    .from(conversation)
    .where(and(eq(conversation.tenantId, tenantId), inArray(conversation.id, convIds)));
  const byId = new Map(convs.map((c) => [c.id, c]));
  const outcomes = await mediaOutcomes(
    tx,
    tenantId,
    connectionId,
    stored.map((r) => r.sid),
  );
  for (const r of stored) {
    const conv = byId.get(r.capture.conversationId);
    out.set(r.sid, {
      kept: r.capture.archive,
      conversation: conv ? { id: conv.id, kind: conv.kind, title: conv.title } : null,
      attachments: attachmentViews(
        r.sid,
        storedMediaOf(r.payload, mediaSidOf),
        r.capture.wanted,
        outcomes,
      ),
    });
  }
  return out;
}

/** A conversation's latest inbound messages with their attachments. */
export async function conversationMessages(
  tx: Tx,
  tenantId: string,
  conv: ConversationRow,
  mediaSidOf: (link: string) => string | null,
): Promise<ConversationMessageView[]> {
  const rows = await tx
    .select({
      id: rawRecord.id,
      sid: rawRecord.externalId,
      payload: rawRecord.payload,
      at: rawRecord.syncedAt,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, conv.connectionId),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        sql`${rawRecord.payload}->'capture'->>'conversationId' = ${conv.id}`,
      ),
    )
    .orderBy(desc(rawRecord.syncedAt))
    .limit(50);
  const outcomes = await mediaOutcomes(
    tx,
    tenantId,
    conv.connectionId,
    rows.map((r) => r.sid),
  );
  return rows.map((r) => {
    const stored = storedCaptureOf(r.payload);
    const p = r.payload as { text?: unknown };
    return {
      rawRecordId: r.id,
      sid: r.sid,
      text: stored?.archive === false ? null : typeof p.text === "string" ? p.text : null,
      at: r.at.toISOString(),
      attachments: attachmentViews(
        r.sid,
        storedMediaOf(r.payload, mediaSidOf),
        stored?.wanted ?? [],
        outcomes,
      ),
    };
  });
}

// ── v0.14 W4-A: WhatsApp groups through Meta (docs/plan.md §1.57) ─────────────────────────────────

/** Whether the client has WhatsApp group messages turned on (`messaging.whatsappGroups`; off). */
export async function whatsappGroupsOn(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const settings = isPlainObject(row?.settings) ? row.settings : {};
  const messaging = isPlainObject(settings.messaging) ? settings.messaging : {};
  return messaging.whatsappGroups === true;
}

/**
 * A group's conversation on the connection, made on its first message with the client's default
 * and attachments off (with a system change row): a group's members aren't all the client's
 * known contacts, so its files are fetched only after a person turns that on.
 */
// DECISION: groups start like a stranger's conversation (plan §1.55's rule for unknown senders).
export async function ensureGroupConversation(
  tx: Tx,
  input: { tenantId: string; connectionId: string; externalId: string; title: string },
): Promise<ConversationRow> {
  const find = async () => {
    const [row] = await tx
      .select()
      .from(conversation)
      .where(
        and(
          eq(conversation.tenantId, input.tenantId),
          eq(conversation.connectionId, input.connectionId),
          eq(conversation.channel, "whatsapp"),
          eq(conversation.kind, "group"),
          eq(conversation.externalId, input.externalId),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  const clientDefault = await clientDefaultCapture(tx, input.tenantId);
  const capture = initialCapture(clientDefault, false);
  const [made] = await tx
    .insert(conversation)
    .values({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      channel: "whatsapp",
      kind: "group",
      externalId: input.externalId,
      title: input.title.slice(0, 200) || "WhatsApp group",
      capture: toStored(capture),
    })
    .onConflictDoNothing()
    .returning();
  if (!made) {
    const raced = await find();
    if (!raced) throw new Error("conversation vanished after a conflicting insert");
    return raced;
  }
  if (capture.attachments !== clientDefault.attachments) {
    await tx.insert(conversationChange).values({
      tenantId: input.tenantId,
      conversationId: made.id,
      actorId: null,
      side: "system",
      change: {
        setting: "capture",
        before: clientDefault,
        after: capture,
        reason: "a group: its members aren't all known contacts",
      },
    });
  }
  return made;
}
