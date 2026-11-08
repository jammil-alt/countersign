// P-7: message translation in the Worker (docs/plan.md §1.69; ARCHITECTURE §10.13).
//
// - `translatePending`: after the commit that stores an original (a text, a WhatsApp message, an
//   email reply, an email to an agent, a client user's thread message), and from the hourly cron,
//   each of the client's originals since translation was turned on and in the last 24 hours with
//   no row yet gets exactly one: translated, or why not. A contact who is off is skipped without a
//   call. Nothing here runs for a client with no working language.
// - The settings for both surfaces and a contact's switch, each change logged.
// - The views: the latest row beside each original, never a model or cost for the portal.
//
// Every model call goes through `guardModels` (HIPAA mode, docs/plan.md §1.35). The original is
// never changed (invariant 3); the translation is data (invariant 9).

import {
  clientTranslation,
  rollupPlatformDaily,
  type TranslationRow,
  translateAndStore,
  translationsToday,
  utcDay,
} from "@countersign/agents";
import { TWILIO_MESSAGE_ENTITY } from "@countersign/connectors";
import {
  ContactTranslation,
  INBOUND_MESSAGE_ENTITY,
  type Locale,
  type OpsTranslationBody,
  type OpsTranslationSettingsView,
  type PortalTranslationBody,
  parseCoveredProcessors,
  redactCardNumbers,
  TRANSLATION_BATCH,
  TRANSLATION_CATCH_UP_HOURS,
  type TranslationSettings,
  type TranslationSettingsView,
  translationOf,
  translationWanted,
} from "@countersign/core";
import {
  contact,
  contactChange,
  type Db,
  message,
  reachOut,
  type Tx,
  tenant,
  tenantChange,
  withTenant,
} from "@countersign/db";
import { knownModelIds, type LlmTransport } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { guardModels, profileReader } from "../compliance/policy";
import type { TranslatedEdit } from "../converse/views";
import type { Bindings } from "../env";
import { type AppDeps, HttpError, notFound } from "../http";
import { contactLanguage } from "../messaging/contacts";
import { reportHandled } from "../observability/report";
import { REACH_REPLY_EMAIL_ENTITY } from "../reach/replies";

/** What the job needs: the database and a model transport per client (null: none configured). */
export interface TranslationDeps {
  db: Db;
  transport(tenantId: string): LlmTransport | null;
  now?: () => Date;
}

/** The minute of each hour the cron's catch-up runs (docs/plan.md §1.69). */
export const TRANSLATION_SWEEP_MINUTE = 23;

/** The raw records whose `text` is someone's message to the client. */
// A function, read at call time: reach/replies imports this module's neighbours, so its constant
// isn't set yet while modules load.
const inboundEntities = () => [
  TWILIO_MESSAGE_ENTITY,
  REACH_REPLY_EMAIL_ENTITY,
  INBOUND_MESSAGE_ENTITY,
];

/**
 * The Worker's translation transport for one client, held to its HIPAA mode: the test's, else the
 * live one when a model key is set, else none (originals are then stored as `failed: no_model`).
 */
export function translationDepsFor(services: {
  db: Db;
  env: Bindings;
  deps: AppDeps;
}): TranslationDeps {
  const inner = services.deps.translationTransport
    ? services.deps.translationTransport(services.env)
    : services.deps.extractionTransport(services.env);
  const covered = parseCoveredProcessors(services.env.BAA_PROCESSORS);
  const profiles = profileReader(services.db);
  return {
    db: services.db,
    transport: (tenantId) => (inner ? guardModels(inner, tenantId, profiles, covered) : null),
  };
}

interface Candidate {
  kind: "raw_record" | "message";
  id: string;
  text: string;
  contactId: string | null;
}

/** The client's originals with no translation row yet, newest first. */
async function candidates(
  tx: Tx,
  tenantId: string,
  settings: TranslationSettings,
  since: Date,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  // DECISION: read whatever the client's switch, since a contact's own switch may turn it on for
  // them; each candidate then gets one row (skipped when off), so none is looked at twice.
  {
    const rows = await tx.execute<{
      id: string;
      text: string | null;
      contact_id: string | null;
      reach_out_id: string | null;
    }>(sql`
      select rr.id, rr.payload ->> 'text' as text, rr.payload ->> 'contactId' as contact_id,
             rr.payload ->> 'reachOutId' as reach_out_id
      from raw_record rr
      where rr.tenant_id = ${tenantId}
        and rr.entity_type in (${sql.join(
          inboundEntities().map((e) => sql`${e}`),
          sql`, `,
        )})
        and (rr.entity_type <> ${TWILIO_MESSAGE_ENTITY} or rr.payload ->> 'direction' = 'in')
        and rr.synced_at >= ${since.toISOString()}
        and coalesce(rr.payload ->> 'text', '') <> ''
        and not exists (
          select 1 from message_translation mt
          where mt.tenant_id = rr.tenant_id and mt.raw_record_id = rr.id)
      order by rr.synced_at desc
      limit ${TRANSLATION_BATCH}`);
    for (const r of rows) {
      out.push({
        kind: "raw_record",
        id: r.id,
        text: r.text ?? "",
        contactId: await contactOf(tx, tenantId, r),
      });
    }
  }
  if (settings.threads) {
    // A client member's own words in a thread (never an operator's, the system's or an agent's).
    const rows = await tx.execute<{ id: string; text: string | null }>(sql`
      select m.id, m.body ->> 'text' as text
      from message m
      join membership ms on ms.tenant_id = m.tenant_id and ms.user_id = m.sender_id
        and ms.role in ('client_admin', 'client_user')
      where m.tenant_id = ${tenantId} and m.sender_type = 'user' and m.kind = 'text'
        and m.created_at >= ${since.toISOString()}
        and coalesce(m.body ->> 'text', '') <> ''
        and not exists (
          select 1 from message_translation mt
          where mt.tenant_id = m.tenant_id and mt.message_id = m.id)
      order by m.created_at desc
      limit ${TRANSLATION_BATCH}`);
    for (const r of rows) {
      out.push({ kind: "message", id: r.id, text: r.text ?? "", contactId: null });
    }
  }
  return out;
}

/** Who sent a raw record: its payload's contact, its reach-out's, else its thread line's sender. */
async function contactOf(
  tx: Tx,
  tenantId: string,
  r: { id: string; contact_id: string | null; reach_out_id: string | null },
): Promise<string | null> {
  if (r.contact_id) return r.contact_id;
  if (r.reach_out_id) {
    const [ro] = await tx
      .select({ contactId: reachOut.contactId })
      .from(reachOut)
      .where(and(eq(reachOut.tenantId, tenantId), eq(reachOut.id, r.reach_out_id)));
    if (ro) return ro.contactId;
  }
  const [line] = await tx
    .select({ senderId: message.senderId })
    .from(message)
    .where(
      and(
        eq(message.tenantId, tenantId),
        eq(message.senderType, "contact"),
        sql`${message.body} ->> 'rawRecordId' = ${r.id}`,
      ),
    )
    .limit(1);
  return line?.senderId ?? null;
}

/**
 * Translates the client's pending originals (at most TRANSLATION_BATCH of each kind). A client
 * with no working language does nothing at all. Returns the rows written.
 */
export async function translatePending(
  deps: TranslationDeps,
  tenantId: string,
): Promise<TranslationRow[]> {
  const now = deps.now?.() ?? new Date();
  const read = await withTenant(deps.db, tenantId, async (tx) => {
    const { settings } = await clientTranslation(tx, tenantId);
    if (!settings.working) return null;
    const window = new Date(now.getTime() - TRANSLATION_CATCH_UP_HOURS * 3600_000);
    const enabled = settings.enabledAt ? new Date(settings.enabledAt) : window;
    const since = enabled > window ? enabled : window;
    const list = await candidates(tx, tenantId, settings, since);
    const people = new Map<string, unknown>();
    const ids = [...new Set(list.map((c) => c.contactId).filter((v): v is string => !!v))];
    for (const id of ids) {
      const [c] = await tx
        .select({ translation: contact.translation })
        .from(contact)
        .where(and(eq(contact.tenantId, tenantId), eq(contact.id, id)));
      people.set(id, c?.translation ?? {});
    }
    return { settings, list, people };
  });
  if (!read) return [];
  const { settings, list, people } = read;
  const working = settings.working as Locale;
  const transport = deps.transport(tenantId);
  const written: TranslationRow[] = [];
  for (const c of list) {
    const isMessage = c.kind === "message";
    const own = c.contactId ? people.get(c.contactId) : {};
    const wanted = isMessage || translationWanted(settings, own, "incoming");
    // Why not: the person's own switch, else the client's.
    const off = translationWanted(settings, {}, "incoming") ? "contact_off" : "client_off";
    written.push(
      await translateAndStore(deps.db, transport, {
        tenantId,
        source: { kind: c.kind, id: c.id },
        direction: "in",
        text: c.text,
        // A client member's thread message is for the back office, which reads English.
        to: isMessage ? "en" : working,
        settings,
        skip: wanted ? undefined : off,
        now,
      }),
    );
  }
  if (written.some((r) => r.model && !r.agentVersionId)) {
    await withTenant(deps.db, tenantId, (tx) =>
      rollupPlatformDaily(tx, { tenantId, day: utcDay(now) }),
    );
  }
  return written;
}

/** translatePending, reported and never thrown: for after-commit tasks. */
export function translateLater(deps: TranslationDeps, tenantId: string): Promise<void> {
  return translatePending(deps, tenantId).then(
    () => undefined,
    (error: unknown) => reportHandled("translating messages failed", error, { job: "translate" }),
  );
}

/** The hourly catch-up: every client with a working language. */
export async function translationSweep(deps: TranslationDeps): Promise<void> {
  const clients = await deps.db
    .select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} -> 'translation' ->> 'working' is not null`);
  for (const c of clients) await translateLater(deps, c.id);
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────

export function settingsView(s: TranslationSettings): TranslationSettingsView {
  return {
    working: s.working,
    incoming: s.working ? s.incoming : false,
    outgoing: s.working ? s.outgoing : false,
    threads: s.working ? s.threads : false,
    dailyLimit: s.dailyLimit,
    enabledAt: s.enabledAt,
  };
}

export async function opsSettingsView(
  tx: Tx,
  tenantId: string,
): Promise<OpsTranslationSettingsView> {
  const { settings } = await clientTranslation(tx, tenantId);
  return {
    ...settingsView(settings),
    model: settings.model,
    today: await translationsToday(tx, tenantId),
  };
}

/**
 * Saves a client's translation settings (the operator's whole body, or the client admin's language
 * and switches), with a `tenant_change` row. The stored key is written alone (`jsonb_set`), so no
 * other setting is touched.
 */
export async function saveTranslation(
  tx: Tx,
  tenantId: string,
  body: PortalTranslationBody | OpsTranslationBody,
  actor: { id: string; side: "operator" | "client" },
  now = new Date(),
): Promise<TranslationSettings> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .for("update");
  if (!row) throw notFound("client");
  const before = ((row.settings ?? {}) as Record<string, unknown>).translation ?? null;
  const prev = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const ops = "reason" in body;
  if (ops && body.model && !knownModelIds().includes(body.model)) {
    throw new HttpError(422, "unknown_model", `${body.model} is not a model we know the price of`);
  }
  const next: Record<string, unknown> = { ...prev, working: body.working };
  for (const key of ["incoming", "outgoing", "threads"] as const) {
    if (body[key] !== undefined) next[key] = body[key];
  }
  if (ops) {
    if (body.model !== undefined) {
      if (body.model === null) delete next.model;
      else next.model = body.model;
    }
    if (body.dailyLimit !== undefined) next.dailyLimit = body.dailyLimit;
  }
  // DECISION: `enabledAt` marks when a working language was set from none, so turning it on never
  // translates what came in before (the catch-up starts there).
  if (body.working && !prev.working) next.enabledAt = now.toISOString();
  if (!body.working) delete next.enabledAt;
  const [saved] = await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(${tenant.settings}, '{translation}', ${JSON.stringify(next)}::jsonb)`,
    })
    .where(eq(tenant.id, tenantId))
    .returning({ settings: tenant.settings });
  if (JSON.stringify(before) !== JSON.stringify(next)) {
    await tx.insert(tenantChange).values({
      tenantId,
      actorId: actor.id,
      change: { setting: "translation", side: actor.side, from: before, to: next },
      reason: ops ? body.reason : "set by the client admin",
    });
  }
  return translationOf(saved?.settings as Record<string, unknown>);
}

/** A contact's switch, saved whole, with a `contact_change` row. */
export async function setContactTranslation(
  tx: Tx,
  tenantId: string,
  contactId: string,
  value: ContactTranslation,
  actor: { id: string; role: "operator" | "client_admin" },
): Promise<ContactTranslation> {
  const [row] = await tx
    .select({ translation: contact.translation })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.tenantId, tenantId)));
  if (!row) throw notFound("contact");
  const before = ContactTranslation.catch({}).parse(row.translation ?? {});
  // Only the directions given are stored: one left out follows the client again.
  const after: { incoming?: boolean; outgoing?: boolean } = Object.fromEntries(
    Object.entries(ContactTranslation.parse(value)).filter(([, v]) => typeof v === "boolean"),
  );
  if (JSON.stringify(before) === JSON.stringify(after)) return after;
  await tx
    .update(contact)
    .set({ translation: after })
    .where(and(eq(contact.id, contactId), eq(contact.tenantId, tenantId)));
  await tx.insert(contactChange).values({
    tenantId,
    contactId,
    actorId: actor.id,
    change: {
      kind: "translation",
      before,
      after,
      by: actor.role === "operator" ? "operator" : "client",
    },
  });
  return after;
}

// ── Outgoing: a person's words for a contact (the Desk's message edit) ────────────────────────────

export interface OutgoingTranslation {
  /** What to sign and send: the translation, or the person's words when already in the language. */
  text: string;
  translated?: TranslatedEdit;
  outcome: {
    status: "translated" | "skipped";
    reason: string | null;
    from: string;
    to: string;
    original: string;
  };
}

/**
 * Translates a person's words for the contact a waiting message (a `reach_out` row) goes to, into
 * that contact's language (theirs, their organization's, the client's). Card numbers are cut
 * first, so no model sees them. A limit, a refusal or a failure is an error: nothing is saved.
 */
export async function translateForContact(
  tx: Tx,
  deps: TranslationDeps,
  input: { tenantId: string; reachOutId: string; text: string; by: string },
): Promise<OutgoingTranslation> {
  const { settings } = await clientTranslation(tx, input.tenantId);
  const [ro] = await tx
    .select({ contactId: reachOut.contactId })
    .from(reachOut)
    .where(and(eq(reachOut.tenantId, input.tenantId), eq(reachOut.id, input.reachOutId)));
  if (!ro) throw notFound("message");
  const [who] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.tenantId, input.tenantId), eq(contact.id, ro.contactId)));
  if (!who) throw notFound("contact");
  if (!translationWanted(settings, who.translation, "outgoing")) {
    throw new HttpError(409, "translation_off", "translation is off for this person");
  }
  const to = (await contactLanguage(tx, who)).language as Locale;
  const original = redactCardNumbers(input.text);
  const row = await translateAndStore(deps.db, deps.transport(input.tenantId), {
    tenantId: input.tenantId,
    source: { kind: "reach_out", id: input.reachOutId },
    direction: "out",
    text: original,
    to,
    settings,
    requestedBy: input.by,
    now: deps.now?.(),
  });
  const outcome = {
    reason: row.reason ?? null,
    from: row.sourceLanguage,
    to,
    original,
  };
  if (row.status === "translated" && row.text) {
    return {
      text: row.text,
      translated: { original, from: row.sourceLanguage, to, translationId: row.id },
      outcome: { status: "translated", ...outcome },
    };
  }
  if (row.status === "skipped" && row.reason === "same_language") {
    return { text: original, outcome: { status: "skipped", ...outcome } };
  }
  if (row.status === "capped") {
    throw new HttpError(429, "translation_limit", "today's translations are used up; try tomorrow");
  }
  if (row.status === "refused") {
    throw new HttpError(409, "not_covered", "translation isn't available for this client's data");
  }
  if (row.status === "skipped") {
    throw new HttpError(422, "not_translatable", "we couldn't tell which language this is in");
  }
  throw new HttpError(502, "translation_failed", "the translation didn't work; try again");
}
