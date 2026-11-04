// A client's contacts and their consent (docs/plan.md §1.22), over the database, inside the caller's
// withTenant/withOperator transaction. Every change is logged to `contact_change`. Opt-outs from a
// STOP text are lifted only by the contact's START; changing a number withdraws that channel's
// consent, which was given for the old number.

import {
  type ConsentChannel,
  type Contact,
  type ContactConsent,
  type ContactConsentChangeInput,
  type ContactCreateInput,
  type ContactMessage,
  type ContactPatchInput,
  callBlock,
  consentBlock,
  DEFAULT_QUIET_HOURS,
  type Keyword,
  type MessagingChannel,
  normalizePhone,
  QuietHours,
} from "@countersign/core";
import { contact, contactChange, message, type Tx, tenant, thread } from "@countersign/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";

export type ContactRow = typeof contact.$inferSelect;
type StoredConsent = NonNullable<typeof contact.$inferInsert.consent>;

/** Consent as the column stores it: channels without consent are absent, never undefined. */
function stored(c: ContactConsent): StoredConsent {
  const out: StoredConsent = {};
  if (c.sms) out.sms = c.sms;
  if (c.whatsapp) out.whatsapp = c.whatsapp;
  if (c.voice) out.voice = c.voice;
  return out;
}

export const CONTACT_THREAD_SUBJECT = "contact";

export function contactView(row: ContactRow): Contact {
  const consent = (row.consent ?? {}) as ContactConsent;
  const state = { phone: row.phone, whatsapp: row.whatsapp, consent, optedOutAt: row.optedOutAt };
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    whatsapp: row.whatsapp,
    language: row.language,
    consent,
    optedOut:
      row.optedOutAt && row.optOutSource
        ? { at: row.optedOutAt.toISOString(), source: row.optOutSource }
        : null,
    canMessage: {
      sms: consentBlock(state, "sms") === null,
      whatsapp: consentBlock(state, "whatsapp") === null,
    },
    canCall: callBlock(state) === null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function phoneOrThrow(raw: string, field: string): string {
  const v = normalizePhone(raw);
  if (!v) {
    throw new HttpError(
      422,
      "invalid_phone",
      `${field}: give the number in international form, e.g. +15551234567`,
    );
  }
  return v;
}

async function log(
  tx: Tx,
  tenantId: string,
  contactId: string,
  actorId: string | null,
  change: Record<string, unknown>,
) {
  await tx.insert(contactChange).values({ tenantId, contactId, actorId, change });
}

export async function listContacts(tx: Tx, tenantId: string): Promise<Contact[]> {
  const rows = await tx
    .select()
    .from(contact)
    .where(eq(contact.tenantId, tenantId))
    .orderBy(asc(contact.name), asc(contact.id))
    .limit(2000);
  return rows.map(contactView);
}

export async function getContact(tx: Tx, tenantId: string, id: string): Promise<ContactRow> {
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)));
  if (!row) throw notFound("contact");
  return row;
}

async function ensureFree(
  tx: Tx,
  tenantId: string,
  field: "phone" | "whatsapp",
  value: string,
  except?: string,
) {
  const col = field === "phone" ? contact.phone : contact.whatsapp;
  const [taken] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(col, value)));
  if (taken && taken.id !== except) {
    throw new HttpError(409, "contact_exists", "another contact already has that number");
  }
}

export async function createContact(
  tx: Tx,
  tenantId: string,
  input: ContactCreateInput,
  actorId: string | null,
  now: Date = new Date(),
): Promise<ContactRow> {
  const phone = input.phone === undefined ? null : phoneOrThrow(input.phone, "phone");
  const whatsapp = input.whatsapp === undefined ? null : phoneOrThrow(input.whatsapp, "whatsapp");
  if (phone) await ensureFree(tx, tenantId, "phone", phone);
  if (whatsapp) await ensureFree(tx, tenantId, "whatsapp", whatsapp);
  const consent: ContactConsent = {};
  for (const ch of input.consent?.channels ?? []) {
    consent[ch] = { grantedAt: now.toISOString(), source: input.consent?.source ?? "" };
  }
  const [row] = await tx
    .insert(contact)
    .values({
      tenantId,
      name: input.name.trim(),
      phone,
      whatsapp,
      language: input.language ?? null,
      consent: stored(consent),
      createdBy: actorId,
    })
    .returning();
  if (!row) throw new Error("contact insert returned nothing");
  await log(tx, tenantId, row.id, actorId, {
    kind: "created",
    consent: Object.keys(consent),
    source: input.consent?.source ?? null,
  });
  return row;
}

export async function updateContact(
  tx: Tx,
  tenantId: string,
  id: string,
  patch: ContactPatchInput,
  actorId: string,
): Promise<ContactRow> {
  const row = await getContact(tx, tenantId, id);
  const next = {
    name: patch.name?.trim() ?? row.name,
    phone:
      patch.phone === undefined
        ? row.phone
        : patch.phone === null
          ? null
          : phoneOrThrow(patch.phone, "phone"),
    whatsapp:
      patch.whatsapp === undefined
        ? row.whatsapp
        : patch.whatsapp === null
          ? null
          : phoneOrThrow(patch.whatsapp, "whatsapp"),
    language: patch.language === undefined ? row.language : patch.language,
  };
  if (!next.phone && !next.whatsapp) {
    throw new HttpError(422, "invalid_contact", "a contact needs a phone or a WhatsApp number");
  }
  if (next.phone && next.phone !== row.phone)
    await ensureFree(tx, tenantId, "phone", next.phone, id);
  if (next.whatsapp && next.whatsapp !== row.whatsapp) {
    await ensureFree(tx, tenantId, "whatsapp", next.whatsapp, id);
  }
  // DECISION: consent is for a number; a new number for a channel needs consent again.
  const consent = { ...((row.consent ?? {}) as ContactConsent) };
  const withdrawn: ConsentChannel[] = [];
  if (next.phone !== row.phone && consent.sms) {
    delete consent.sms;
    withdrawn.push("sms");
  }
  // Calls go to the phone too.
  if (next.phone !== row.phone && consent.voice) {
    delete consent.voice;
    withdrawn.push("voice");
  }
  if (next.whatsapp !== row.whatsapp && consent.whatsapp) {
    delete consent.whatsapp;
    withdrawn.push("whatsapp");
  }
  const [updated] = await tx
    .update(contact)
    .set({ ...next, consent: stored(consent) })
    .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)))
    .returning();
  if (!updated) throw notFound("contact");
  await log(tx, tenantId, id, actorId, {
    kind: "edited",
    fields: Object.keys(patch),
    ...(withdrawn.length ? { consentWithdrawn: withdrawn } : {}),
  });
  return updated;
}

export async function changeConsent(
  tx: Tx,
  tenantId: string,
  id: string,
  change: ContactConsentChangeInput,
  actor: { id: string; role: "operator" | "client_admin" | "client_user" },
  now: Date = new Date(),
): Promise<ContactRow> {
  const row = await getContact(tx, tenantId, id);
  const consent = { ...((row.consent ?? {}) as ContactConsent) };
  const where = and(eq(contact.id, id), eq(contact.tenantId, tenantId));
  let set: Partial<typeof contact.$inferInsert>;
  switch (change.action) {
    case "grant": {
      if (row.optedOutAt) {
        throw new HttpError(409, "opted_out", "this contact opted out: lift the opt-out first");
      }
      const number = change.channel === "whatsapp" ? row.whatsapp : row.phone;
      if (!number) {
        throw new HttpError(422, "no_number", "add the contact's number for that channel first");
      }
      consent[change.channel] = { grantedAt: now.toISOString(), source: change.source };
      set = { consent: stored(consent) };
      break;
    }
    case "withdraw":
      if (!consent[change.channel])
        throw new HttpError(409, "no_op", "there is no consent to withdraw");
      delete consent[change.channel];
      set = { consent: stored(consent) };
      break;
    case "opt_out":
      if (row.optedOutAt) throw new HttpError(409, "no_op", "this contact has already opted out");
      set = { optedOutAt: now, optOutSource: actor.role === "operator" ? "operator" : "client" };
      break;
    case "lift_opt_out":
      if (!row.optedOutAt) throw new HttpError(409, "no_op", "this contact hasn't opted out");
      if (row.optOutSource?.startsWith("keyword:")) {
        throw new HttpError(
          409,
          "contact_opted_out",
          "the contact opted out by text: only they can opt back in, by texting START",
        );
      }
      set = { optedOutAt: null, optOutSource: null };
      break;
  }
  const [updated] = await tx.update(contact).set(set).where(where).returning();
  if (!updated) throw notFound("contact");
  await log(tx, tenantId, id, actor.id, {
    kind: change.action,
    ...("channel" in change ? { channel: change.channel } : {}),
    ...("source" in change ? { source: change.source } : {}),
    by: actor.role === "operator" ? "operator" : "client",
  });
  return updated;
}

export async function findContactByNumber(
  tx: Tx,
  tenantId: string,
  channel: MessagingChannel,
  number: string,
): Promise<ContactRow | null> {
  const col = channel === "sms" ? contact.phone : contact.whatsapp;
  const [row] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(col, number)));
  return row ?? null;
}

/**
 * A STOP or START text, acted on at once: STOP opts the contact out of every channel; START lifts
 * the opt-out and records consent for the channel it came on.
 */
export async function applyKeyword(
  tx: Tx,
  row: ContactRow,
  keyword: Keyword,
  channel: MessagingChannel,
  now: Date,
): Promise<ContactRow> {
  const where = and(eq(contact.id, row.id), eq(contact.tenantId, row.tenantId));
  if (keyword === "stop") {
    if (row.optedOutAt) return row;
    const [u] = await tx
      .update(contact)
      .set({ optedOutAt: now, optOutSource: "keyword:STOP" })
      .where(where)
      .returning();
    await log(tx, row.tenantId, row.id, null, { kind: "opt_out", by: "contact", channel });
    return u ?? row;
  }
  if (keyword === "start") {
    const consent = { ...((row.consent ?? {}) as ContactConsent) };
    consent[channel] = { grantedAt: now.toISOString(), source: "texted START" };
    const [u] = await tx
      .update(contact)
      .set({ optedOutAt: null, optOutSource: null, consent: stored(consent) })
      .where(where)
      .returning();
    await log(tx, row.tenantId, row.id, null, { kind: "opt_in", by: "contact", channel });
    return u ?? row;
  }
  return row;
}

/** The contact's thread (subject `contact`), made on first use. */
export async function contactThread(tx: Tx, row: ContactRow): Promise<string> {
  const [found] = await tx
    .select({ id: thread.id })
    .from(thread)
    .where(
      and(
        eq(thread.tenantId, row.tenantId),
        eq(thread.subjectType, CONTACT_THREAD_SUBJECT),
        eq(thread.subjectId, row.id),
      ),
    )
    .limit(1);
  if (found) return found.id;
  const [made] = await tx
    .insert(thread)
    .values({
      tenantId: row.tenantId,
      subjectType: CONTACT_THREAD_SUBJECT,
      subjectId: row.id,
      title: `Messages with ${row.name}`.slice(0, 200),
    })
    .returning({ id: thread.id });
  if (!made) throw new Error("thread insert returned nothing");
  return made.id;
}

/** What a contact-thread message keeps in `message.body`. */
export interface ThreadMessageBody {
  direction: "in" | "out";
  /** `voice`: a call (calls/store.ts threadCallLine). */
  channel: MessagingChannel | "voice";
  /** The sender's words (or the template id): shown to people, never handed to a model. */
  text: string;
  sid: string;
  rawRecordId: string;
  status: string | null;
}

export async function contactMessages(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<ContactMessage[]> {
  const rows = await tx
    .select({ id: message.id, body: message.body, createdAt: message.createdAt })
    .from(message)
    .innerJoin(thread, and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)))
    .where(
      and(
        eq(message.tenantId, tenantId),
        eq(thread.subjectType, CONTACT_THREAD_SUBJECT),
        eq(thread.subjectId, contactId),
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(200);
  return rows.map((r) => {
    const b = r.body as Partial<ThreadMessageBody>;
    return {
      id: r.id,
      direction: b.direction === "in" ? "in" : "out",
      channel: b.channel === "whatsapp" ? "whatsapp" : b.channel === "voice" ? "voice" : "sms",
      text: typeof b.text === "string" ? b.text : "",
      sid: typeof b.sid === "string" ? b.sid : null,
      status: typeof b.status === "string" ? b.status : null,
      at: r.createdAt.toISOString(),
    };
  });
}

/** Marks a sent message's status on its thread message. */
export async function markThreadStatus(tx: Tx, tenantId: string, sid: string, status: string) {
  await tx
    .update(message)
    .set({ body: sql`${message.body} || ${JSON.stringify({ status })}::jsonb` })
    .where(and(eq(message.tenantId, tenantId), sql`${message.body}->>'sid' = ${sid}`));
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

export interface MessagingSettings {
  timezone: string;
  quietHours: QuietHours;
}

export function messagingSettingsOf(
  row: Pick<typeof tenant.$inferSelect, "timezone" | "settings">,
) {
  const m = (row.settings as { messaging?: { quietHours?: unknown } } | null)?.messaging;
  const q = QuietHours.safeParse(m?.quietHours);
  return { timezone: row.timezone, quietHours: q.success ? q.data : DEFAULT_QUIET_HOURS };
}

export async function messagingSettings(tx: Tx, tenantId: string): Promise<MessagingSettings> {
  const [row] = await tx
    .select({ timezone: tenant.timezone, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!row) throw notFound("client");
  return messagingSettingsOf(row);
}
