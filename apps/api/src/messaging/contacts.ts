// A client's contacts and their consent (docs/plan.md §1.22), over the database, inside the caller's
// withTenant/withOperator transaction. Every change is logged to `contact_change`. Opt-outs from a
// STOP text are lifted only by the contact's START; changing a number withdraws that channel's
// consent, which was given for the old number.

import { TWILIO_MESSAGE_ENTITY } from "@countersign/connectors";
import {
  type ConsentChannel,
  type Contact,
  type ContactConsent,
  type ContactConsentChangeInput,
  type ContactCreateInput,
  type ContactPatchInput,
  type ContactRelationshipBulkInput,
  type ContactRelationshipBulkResult,
  ContactTranslation,
  callBlock,
  consentBasisOf,
  consentBlock,
  consentBlockFor,
  DEFAULT_QUIET_HOURS,
  type Keyword,
  type LanguageUsed,
  languageFor,
  type MessagingChannel,
  normalizePhone,
  type OpsContactMessage,
  type OrganizationKind,
  QuietHours,
  type ReachChannel,
  type ReachContact,
  readAutonomy,
  relationshipChannelsFor,
} from "@countersign/core";
import {
  clientLanguageOf,
  contact,
  contactChange,
  directoryPeople,
  message,
  organization,
  rawRecord,
  type Tx,
  tenant,
  thread,
} from "@countersign/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
// P-7
import { translationsFor } from "../translate/views";

export type ContactRow = typeof contact.$inferSelect;
type StoredConsent = NonNullable<typeof contact.$inferInsert.consent>;

/** Consent as the column stores it: channels without consent are absent, never undefined. */
function stored(c: ContactConsent): StoredConsent {
  const out: StoredConsent = {};
  if (c.sms) out.sms = c.sms;
  if (c.whatsapp) out.whatsapp = c.whatsapp;
  if (c.voice) out.voice = c.voice;
  if (c.email) out.email = c.email;
  return out;
}

/** A contact as the reach-out evaluator reads it (core's ReachContact). */
export function reachContactOf(row: ContactRow): ReachContact {
  const q = QuietHours.safeParse(row.quietHours);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    language: row.language,
    preferredChannels: (row.preferredChannels ?? []) as ReachChannel[],
    timezone: row.timezone,
    quietHours: q.success ? q.data : null,
    consent: (row.consent ?? {}) as ContactConsent,
    optedOutAt: row.optedOutAt,
    // v0.12 W1-G: the person's autonomy per channel (docs/plan.md §1.42).
    autonomy: readAutonomy(row.autonomy),
  };
}

/** A timezone the runtime knows, or a 422. */
function timezoneOrThrow(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new HttpError(422, "invalid_timezone", `${tz} is not a timezone, e.g. America/Chicago`);
  }
}

export const CONTACT_THREAD_SUBJECT = "contact";

type OrgRef = { id: string; name: string; language: string | null; kinds?: OrganizationKind[] };

/**
 * A contact with its organization (the directory, docs/plan.md §1.27) and the language agents
 * write to them in (core's `languageFor`).
 */
export function contactView(
  row: ContactRow,
  org: OrgRef | null = null,
  client: string | null = null,
): Contact {
  const mine = org && org.id === row.organizationId ? org : null;
  const consent = (row.consent ?? {}) as ContactConsent;
  const state = { phone: row.phone, whatsapp: row.whatsapp, consent, optedOutAt: row.optedOutAt };
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    whatsapp: row.whatsapp,
    email: row.email,
    language: row.language,
    preferredChannels: (row.preferredChannels ?? []) as ReachChannel[],
    timezone: row.timezone,
    quietHours: QuietHours.safeParse(row.quietHours).data ?? null,
    roles: row.roles ?? [],
    notes: row.notes,
    organization: mine,
    languageUsed: languageFor({ person: row.language, organization: mine, client }),
    title: row.title,
    relationship: row.relationship ?? null,
    source: row.source,
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
    canEmail: consentBlockFor(reachContactOf(row), "email") === null,
    // v0.12 W1-G: per channel; a channel left out narrows nothing.
    autonomy: readAutonomy(row.autonomy),
    // P-7: this person's switch over the client's translation (docs/plan.md §1.69).
    translation: ContactTranslation.catch({}).parse(row.translation ?? {}),
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
  const rows = await directoryPeople(tx, tenantId);
  const client = await clientLanguageOf(tx, tenantId);
  return rows.slice(0, 2000).map((r) => contactView(r.person, r.organization, client));
}

async function organizationOf(tx: Tx, row: ContactRow): Promise<OrgRef | null> {
  if (!row.organizationId) return null;
  const [org] = await tx
    .select({
      id: organization.id,
      name: organization.name,
      language: organization.language,
      kinds: organization.kinds,
    })
    .from(organization)
    .where(and(eq(organization.id, row.organizationId), eq(organization.tenantId, row.tenantId)));
  return org ?? null;
}

/** A contact as the routes answer it: with its organization and the language it gets. */
export async function contactOut(tx: Tx, row: ContactRow): Promise<Contact> {
  return contactView(row, await organizationOf(tx, row), await clientLanguageOf(tx, row.tenantId));
}

/**
 * The language to write to a contact in (docs/plan.md §1.27): theirs, else their organization's,
 * else the client's, else English. Every path where an agent writes to a person uses it.
 */
export async function contactLanguage(tx: Tx, row: ContactRow): Promise<LanguageUsed> {
  return languageFor({
    person: row.language,
    organization: await organizationOf(tx, row),
    client: await clientLanguageOf(tx, row.tenantId),
  });
}

/** The organization exists in this client's directory, or a 422. */
async function organizationOrThrow(tx: Tx, tenantId: string, id: string): Promise<string> {
  const [org] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(and(eq(organization.id, id), eq(organization.tenantId, tenantId)));
  if (!org) {
    throw new HttpError(422, "unknown_organization", "that organization isn't in the directory");
  }
  return org.id;
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
  field: "phone" | "whatsapp" | "email",
  value: string,
  except?: string,
) {
  const col =
    field === "phone" ? contact.phone : field === "whatsapp" ? contact.whatsapp : contact.email;
  const [taken] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), eq(col, value)));
  if (taken && taken.id !== except) {
    throw new HttpError(
      409,
      "contact_exists",
      `another contact already has that ${field === "email" ? "email address" : "number"}`,
    );
  }
}

export interface ContactOrigin {
  /** `manual`, `csv`, `agent` or a connector; default `manual` for a person, none for the system. */
  source?: string;
  /** Ids in the connected tool it came from. */
  externalRefs?: Record<string, string>;
  /** Logged with the creation (e.g. the suggestion it came from). */
  log?: Record<string, unknown>;
}

export async function createContact(
  tx: Tx,
  tenantId: string,
  input: ContactCreateInput,
  actorId: string | null,
  now: Date = new Date(),
  origin: ContactOrigin = {},
): Promise<ContactRow> {
  const phone = input.phone === undefined ? null : phoneOrThrow(input.phone, "phone");
  const whatsapp = input.whatsapp === undefined ? null : phoneOrThrow(input.whatsapp, "whatsapp");
  const email = input.email?.trim().toLowerCase() ?? null;
  if (phone) await ensureFree(tx, tenantId, "phone", phone);
  if (whatsapp) await ensureFree(tx, tenantId, "whatsapp", whatsapp);
  if (email) await ensureFree(tx, tenantId, "email", email);
  const consent: ContactConsent = {};
  const given = input.consent;
  if (given && "channels" in given) {
    for (const ch of given.channels) {
      const address = ch === "email" ? email : ch === "whatsapp" ? whatsapp : phone;
      if (!address) {
        throw new HttpError(
          422,
          "no_number",
          `add the contact's ${ch === "email" ? "email" : "number"} for ${ch} first`,
        );
      }
      consent[ch] = { grantedAt: now.toISOString(), source: given.source, basis: "express" };
    }
  } else if (given) {
    // They gave the client this number for business (docs/plan.md §1.97).
    const channels = relationshipChannelsFor({ phone, email });
    if (channels.length === 0) {
      throw new HttpError(422, "no_number", "add the contact's phone or email address first");
    }
    for (const ch of channels) {
      consent[ch] = { grantedAt: now.toISOString(), source: given.source, basis: "relationship" };
    }
  }
  const [row] = await tx
    .insert(contact)
    .values({
      tenantId,
      name: input.name.trim(),
      phone,
      whatsapp,
      email,
      language: input.language ?? null,
      preferredChannels: [...new Set(input.preferredChannels ?? [])],
      timezone: input.timezone === undefined ? null : timezoneOrThrow(input.timezone),
      quietHours: input.quietHours ?? null,
      roles: [...new Set(input.roles ?? [])],
      notes: input.notes?.trim() || null,
      organizationId:
        input.organizationId === undefined
          ? null
          : await organizationOrThrow(tx, tenantId, input.organizationId),
      title: input.title?.trim() || null,
      relationship: input.relationship ?? null,
      source: origin.source ?? (actorId ? "manual" : null),
      externalRefs: origin.externalRefs ?? {},
      consent: stored(consent),
      createdBy: actorId,
    })
    .returning();
  if (!row) throw new Error("contact insert returned nothing");
  await log(tx, tenantId, row.id, actorId, {
    kind: "created",
    consent: Object.keys(consent),
    source: input.consent?.source ?? null,
    ...(given ? { basis: "channels" in given ? "express" : "relationship" } : {}),
    ...(origin.source ? { from: origin.source } : {}),
    ...(origin.log ?? {}),
  });
  return row;
}

export async function updateContact(
  tx: Tx,
  tenantId: string,
  id: string,
  patch: ContactPatchInput,
  actorId: string | null,
  extra: { log?: Record<string, unknown>; externalRefs?: Record<string, string> } = {},
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
    email:
      patch.email === undefined
        ? row.email
        : patch.email === null
          ? null
          : patch.email.trim().toLowerCase(),
    language: patch.language === undefined ? row.language : patch.language,
    preferredChannels:
      patch.preferredChannels === undefined
        ? row.preferredChannels
        : [...new Set(patch.preferredChannels)],
    timezone:
      patch.timezone === undefined
        ? row.timezone
        : patch.timezone === null
          ? null
          : timezoneOrThrow(patch.timezone),
    quietHours: patch.quietHours === undefined ? row.quietHours : patch.quietHours,
    roles: patch.roles === undefined ? row.roles : [...new Set(patch.roles)],
    notes: patch.notes === undefined ? row.notes : patch.notes?.trim() || null,
    organizationId:
      patch.organizationId === undefined
        ? row.organizationId
        : patch.organizationId === null
          ? null
          : await organizationOrThrow(tx, tenantId, patch.organizationId),
    title: patch.title === undefined ? row.title : patch.title?.trim() || null,
    relationship: patch.relationship === undefined ? row.relationship : patch.relationship,
    externalRefs:
      extra.externalRefs === undefined
        ? row.externalRefs
        : { ...(row.externalRefs ?? {}), ...extra.externalRefs },
  };
  if (!next.phone && !next.whatsapp && !next.email) {
    throw new HttpError(
      422,
      "invalid_contact",
      "a contact needs a phone, a WhatsApp number or an email address",
    );
  }
  if (next.phone && next.phone !== row.phone)
    await ensureFree(tx, tenantId, "phone", next.phone, id);
  if (next.whatsapp && next.whatsapp !== row.whatsapp) {
    await ensureFree(tx, tenantId, "whatsapp", next.whatsapp, id);
  }
  if (next.email && next.email !== row.email) {
    await ensureFree(tx, tenantId, "email", next.email, id);
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
  if (next.email !== row.email && consent.email) {
    delete consent.email;
    withdrawn.push("email");
  }
  const [updated] = await tx
    .update(contact)
    .set({ ...next, consent: stored(consent) })
    .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)))
    .returning();
  if (!updated) throw notFound("contact");
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of Object.keys(next) as (keyof typeof next)[]) {
    if (JSON.stringify(row[k] ?? null) !== JSON.stringify(next[k] ?? null)) {
      changed[k] = { before: row[k] ?? null, after: next[k] ?? null };
    }
  }
  await log(tx, tenantId, id, actorId, {
    kind: "edited",
    fields: Object.keys(patch),
    changed,
    ...(withdrawn.length ? { consentWithdrawn: withdrawn } : {}),
    ...(extra.log ?? {}),
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
      const number =
        change.channel === "whatsapp"
          ? row.whatsapp
          : change.channel === "email"
            ? row.email
            : row.phone;
      if (!number) {
        throw new HttpError(
          422,
          "no_number",
          change.channel === "email"
            ? "add the contact's email address first"
            : "add the contact's number for that channel first",
        );
      }
      consent[change.channel] = {
        grantedAt: now.toISOString(),
        source: change.source,
        basis: "express",
      };
      set = { consent: stored(consent) };
      break;
    }
    case "relationship": {
      if (row.optedOutAt) {
        throw new HttpError(409, "opted_out", "this contact opted out: lift the opt-out first");
      }
      const channels = relationshipChannelsFor(row);
      if (channels.length === 0) {
        throw new HttpError(422, "no_number", "add the contact's phone or email address first");
      }
      Object.assign(consent, withRelationship(consent, channels, change.source, now));
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
    ...(change.action === "relationship"
      ? { basis: "relationship", channels: relationshipChannelsFor(row) }
      : change.action === "grant"
        ? { basis: "express" }
        : {}),
    ...("source" in change ? { source: change.source } : {}),
    by: actor.role === "operator" ? "operator" : "client",
  });
  return updated;
}

/**
 * The relationship basis on these channels. Express consent already recorded on a channel is kept:
 * it is the stronger record, and replacing it would lose its evidence.
 */
// DECISION: the relationship basis never replaces express consent, and never opens WhatsApp
// (relationshipChannelsFor leaves it out; hasConsent refuses it there anyway).
function withRelationship(
  consent: ContactConsent,
  channels: ConsentChannel[],
  source: string,
  now: Date,
): ContactConsent {
  const out: ContactConsent = {};
  for (const ch of channels) {
    const had = consent[ch];
    if (had && consentBasisOf(had) === "express") continue;
    out[ch] = { grantedAt: now.toISOString(), source, basis: "relationship" };
  }
  return out;
}

/**
 * The relationship basis for many contacts at once (docs/plan.md §1.97): each one in this client
 * that hasn't opted out and has a phone or email. Each change is logged on its contact.
 */
// DECISION: the bulk action skips (and reports) a contact who opted out instead of failing the
// batch: only the contact's START, or a person lifting the opt-out, reopens them (§1.22).
export async function relationshipForMany(
  tx: Tx,
  tenantId: string,
  input: ContactRelationshipBulkInput,
  actor: { id: string; role: "operator" | "client_admin" | "client_user" },
  now: Date = new Date(),
): Promise<ContactRelationshipBulkResult> {
  const ids = [...new Set(input.contactIds)];
  const rows = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, tenantId), inArray(contact.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ContactRelationshipBulkResult = { updated: [], skipped: [] };
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      out.skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (row.optedOutAt) {
      out.skipped.push({ id, reason: "opted_out" });
      continue;
    }
    const channels = relationshipChannelsFor(row);
    if (channels.length === 0) {
      out.skipped.push({ id, reason: "no_address" });
      continue;
    }
    const consent = { ...((row.consent ?? {}) as ContactConsent) };
    Object.assign(consent, withRelationship(consent, channels, input.source.trim(), now));
    await tx
      .update(contact)
      .set({ consent: stored(consent) })
      .where(and(eq(contact.id, id), eq(contact.tenantId, tenantId)));
    await log(tx, tenantId, id, actor.id, {
      kind: "relationship",
      basis: "relationship",
      channels,
      source: input.source.trim(),
      bulk: true,
      by: actor.role === "operator" ? "operator" : "client",
    });
    out.updated.push(id);
  }
  return out;
}

/** When this contact was last sent a text (not WhatsApp, not a call), or null. */
// DECISION: the 30-day gap for a first text (§1.97) counts texts only: a call or a WhatsApp
// message doesn't remind the person how to stop texts.
export async function lastTextAt(
  tx: Tx,
  tenantId: string,
  contactId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ at: rawRecord.syncedAt })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
        sql`${rawRecord.payload}->>'direction' = 'out'`,
        sql`${rawRecord.payload}->>'channel' = 'sms'`,
        sql`${rawRecord.payload}->>'contactId' = ${contactId}`,
      ),
    )
    .orderBy(desc(rawRecord.syncedAt))
    .limit(1);
  return row?.at ?? null;
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
  /** `voice`: a call (calls/store.ts threadCallLine); `email`: a reach-out email or its reply. */
  channel: MessagingChannel | "voice" | "email";
  /** The sender's words (or the template id): shown to people, never handed to a model. */
  text: string;
  sid: string;
  rawRecordId: string;
  status: string | null;
  /** A reach-out's own line: the run, the agent version and the sources (invariant 10). */
  reachOut?: { id: string; runId: string | null; agentVersionId: string | null; sources: string[] };
}

export async function contactMessages(
  tx: Tx,
  tenantId: string,
  contactId: string,
  // P-7: the surface decides whether a translation shows its model and cost.
  surface: "ops" | "portal" = "portal",
): Promise<OpsContactMessage[]> {
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
  // P-7: each line's translation, beside the raw record it shows (docs/plan.md §1.69).
  const rawOf = (body: unknown) => {
    const id = (body as Partial<ThreadMessageBody>).rawRecordId;
    return typeof id === "string" && id ? id : null;
  };
  const translated = await translationsFor(
    tx,
    tenantId,
    { rawRecordIds: rows.map((r) => rawOf(r.body)).filter((v): v is string => !!v) },
    surface,
  );
  return rows.map((r) => {
    const b = r.body as Partial<ThreadMessageBody>;
    const raw = rawOf(r.body);
    // The portal's view has no model or cost; the back office's has both.
    const translation = (raw ? translated.get(raw) : undefined) as OpsContactMessage["translation"];
    return {
      ...(translation ? { translation } : {}),
      id: r.id,
      direction: b.direction === "in" ? "in" : "out",
      channel:
        b.channel === "whatsapp" || b.channel === "voice" || b.channel === "email"
          ? b.channel
          : "sms",
      ...(b.reachOut ? { reachOut: b.reachOut } : {}),
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
