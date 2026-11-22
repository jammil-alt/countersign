// A client's intake as the back office and the portal read it (docs/cases-plan.md §4.5; docs/plan.md
// §1.149.2): the stored guide, its people, the latest answer to each field, each card's progress
// and the log. The portal's view holds only the cards a person was asked (all of them for the
// client admin), "We think" in words, and nothing of ours (invariant 11): no fact ids, no
// question's origin, no `ours` fact (the guide never holds one).

import {
  ANSWER_STATES,
  ANSWERED_STATES,
  type AnswerState,
  type Covers,
  GUIDE_VERSION,
  type Guide,
  Guide as GuideSchema,
  guideAnswered,
  guideProgress,
  type IntakeAnswerView,
  IntakeArea,
  type IntakeEventView,
  type IntakePersonView,
  latestByField,
  OPEN_INTAKE_STATUSES,
  type OpsIntakeSummary,
  type PortalIntakeView,
  portalField,
  portalSection,
  type SectionProgress,
  visibleSectionKeys,
} from "@countersign/core";
import {
  appUser,
  connection,
  intake,
  intakeAnswer,
  intakeEvent,
  intakePerson,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { HttpError, iso, notFound } from "../http";
import { unsentInvite } from "./emails";

export type IntakeRow = typeof intake.$inferSelect;
export type PersonRow = typeof intakePerson.$inferSelect;
type AnswerRow = typeof intakeAnswer.$inferSelect;
type EventRow = typeof intakeEvent.$inferSelect;

const EMPTY_GUIDE: Guide = {
  version: GUIDE_VERSION,
  sections: [],
  totals: { known: 0, toConfirm: 0, toAsk: 0, later: 0, tools: 0, minutes: 0 },
};

/** The stored guide; an unreadable one is empty (nothing asked), never a failure. */
export function guideOf(row: Pick<IntakeRow, "guide">): Guide {
  const parsed = GuideSchema.safeParse(row.guide);
  return parsed.success ? parsed.data : EMPTY_GUIDE;
}

/** An intake of the request's clients, or 404 (another client's is not found: invariant 1). */
export async function readIntake(
  tx: Tx,
  tenantIds: readonly string[],
  id: string,
  lock = false,
): Promise<IntakeRow> {
  const q = tx
    .select()
    .from(intake)
    .where(and(eq(intake.id, id), inArray(intake.tenantId, [...tenantIds])));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("intake");
  return row;
}

/** Intakes still taking answers. */
export function isOpen(row: Pick<IntakeRow, "status">): boolean {
  return OPEN_INTAKE_STATUSES.includes(row.status);
}

/** A display name: the person's name, else their address's first part (never an operator's address). */
async function names(tx: Tx, ids: readonly (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  for (const u of await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted))) {
    out.set(u.id, u.name?.trim() || (u.email.split("@")[0] ?? "someone"));
  }
  return out;
}

export interface IntakeData {
  row: IntakeRow;
  guide: Guide;
  people: PersonRow[];
  /** Oldest first, each as stored. */
  answers: AnswerRow[];
  /** Oldest first. */
  events: EventRow[];
  /** The client's connected tools, by connector: a tool field is answered once connected. */
  connected: Map<string, string>;
  names: Map<string, string>;
}

export async function loadIntake(tx: Tx, row: IntakeRow): Promise<IntakeData> {
  const where = (t: typeof intakeAnswer | typeof intakeEvent | typeof intakePerson) =>
    and(eq(t.tenantId, row.tenantId), eq(t.intakeId, row.id));
  // One after another: a transaction holds one connection.
  const people = await tx
    .select()
    .from(intakePerson)
    .where(where(intakePerson))
    .orderBy(asc(intakePerson.createdAt));
  const answers = await tx
    .select()
    .from(intakeAnswer)
    .where(where(intakeAnswer))
    .orderBy(asc(intakeAnswer.createdAt), asc(intakeAnswer.id));
  const events = await tx
    .select()
    .from(intakeEvent)
    .where(where(intakeEvent))
    .orderBy(asc(intakeEvent.createdAt), asc(intakeEvent.id));
  const conns = await tx
    .select({ id: connection.id, connector: connection.connector })
    .from(connection)
    .where(and(eq(connection.tenantId, row.tenantId), eq(connection.status, "connected")))
    .orderBy(asc(connection.createdAt));
  const connected = new Map<string, string>();
  for (const c of conns) if (!connected.has(c.connector)) connected.set(c.connector, c.id);
  return {
    row,
    guide: guideOf(row),
    people,
    answers,
    events,
    connected,
    names: await names(tx, [
      row.leadUserId,
      ...answers.map((a) => a.userId),
      ...people.map((p) => p.invitedBy),
    ]),
  };
}

/**
 * The latest answer to each field, as shown: a tool field the client has connected counts as
 * answered by the tool itself unless someone answered it (a "Can't connect it now" or "Later" is
 * overtaken once the tool is connected).
 */
// DECISION: a connection is read live, not written as an answer: connecting on the Connections page
// (or disconnecting) shows on the card at once, and no answer goes stale.
export function answerViews(d: IntakeData): IntakeAnswerView[] {
  const latest = latestByField(d.answers).map(
    (a): IntakeAnswerView => ({
      fieldKey: a.fieldKey,
      value: a.value ?? null,
      state: (ANSWER_STATES as readonly string[]).includes(a.state)
        ? (a.state as AnswerState)
        : "answered",
      source: a.source,
      by: a.userId ? { id: a.userId, name: d.names.get(a.userId) ?? "" } : null,
      at: a.createdAt.toISOString(),
    }),
  );
  const said = new Set(
    latest.filter((a) => ANSWERED_STATES.includes(a.state)).map((a) => a.fieldKey),
  );
  for (const s of d.guide.sections) {
    for (const f of s.fields) {
      if (f.kind !== "tool" || !f.connector || said.has(f.key)) continue;
      const connectionId = d.connected.get(f.connector);
      if (!connectionId) continue;
      said.add(f.key);
      // A not sure or later answer before the connection is overtaken by it.
      const was = latest.findIndex((a) => a.fieldKey === f.key);
      if (was >= 0) latest.splice(was, 1);
      latest.push({
        fieldKey: f.key,
        value: { connectionId },
        state: "answered",
        source: "tool",
        by: null,
        at: d.row.updatedAt.toISOString(),
      });
    }
  }
  return latest;
}

/** Each card's Start with this or Not now: the latest event for it. */
function decisionsOf(events: readonly EventRow[]): Record<string, "start" | "not_now"> {
  const out: Record<string, "start" | "not_now"> = {};
  for (const e of events) {
    const key = (e.meta as { sectionKey?: unknown } | null)?.sectionKey;
    if (typeof key !== "string") continue;
    if (e.kind === "section_started") out[key] = "start";
    if (e.kind === "section_not_now") out[key] = "not_now";
  }
  return out;
}

/** One question asked of a colleague: the field and who has it. */
function askedOf(d: IntakeData): { fieldKey: string; name: string }[] {
  return d.events.flatMap((e) => {
    const m = e.meta as { fieldKey?: unknown; personId?: unknown } | null;
    if (e.kind !== "asked" || typeof m?.fieldKey !== "string") return [];
    const p = d.people.find((x) => x.id === m.personId);
    return p ? [{ fieldKey: m.fieldKey, name: p.name }] : [];
  });
}

export function progressOf(d: IntakeData, answers = answerViews(d)): SectionProgress[] {
  // §1.206 q4: an answer the lead gave on a call counts once the client says yes to it.
  return guideProgress(
    d.guide,
    answers.filter((a) => a.source !== "call"),
    {
      people: d.people.map((p) => ({ name: p.name, sections: p.sections, isAdmin: p.isAdmin })),
      asked: askedOf(d),
      decisions: decisionsOf(d.events),
    },
  );
}

export function personView(p: PersonRow): IntakePersonView {
  return {
    id: p.id,
    userId: p.userId,
    email: p.email,
    name: p.name,
    sections: p.sections,
    isAdmin: p.isAdmin,
    invitedBy: p.invitedBy,
    createdAt: p.createdAt.toISOString(),
  };
}

function eventView(e: EventRow): IntakeEventView {
  return {
    id: e.id,
    kind: e.kind,
    personId: e.personId,
    meta: (e.meta ?? {}) as Record<string, unknown>,
    at: e.createdAt.toISOString(),
  };
}

/** The stored covers, read leniently: an unknown area is left out. */
export function coversOf(raw: unknown): Covers {
  const c = (raw ?? {}) as { general?: unknown; areas?: unknown; templateIds?: unknown };
  return {
    general: c.general === true,
    areas: Array.isArray(c.areas)
      ? c.areas.filter((a): a is IntakeArea => IntakeArea.safeParse(a).success)
      : [],
    templateIds: Array.isArray(c.templateIds)
      ? c.templateIds.filter((t): t is string => typeof t === "string")
      : [],
  };
}

export async function opsSummary(tx: Tx, rows: readonly IntakeRow[]): Promise<OpsIntakeSummary[]> {
  if (rows.length === 0) return [];
  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(
      inArray(
        tenant.id,
        rows.map((r) => r.tenantId),
      ),
    );
  const out: OpsIntakeSummary[] = [];
  for (const r of rows) {
    const d = await loadIntake(tx, r);
    const { answered, total } = guideAnswered(d.guide, answerViews(d));
    out.push({
      id: r.id,
      client: clients.find((c) => c.id === r.tenantId) ?? { id: r.tenantId, name: "" },
      fileId: r.fileId,
      dealId: r.dealId,
      status: r.status,
      covers: coversOf(r.covers),
      startMode: r.startMode,
      people: d.people.length,
      answered,
      total,
      sendAt: iso(r.sendAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  return out;
}

export async function opsView(tx: Tx, row: IntakeRow) {
  const d = await loadIntake(tx, row);
  const answers = answerViews(d);
  const progress = progressOf(d, answers);
  const [summary] = await opsSummary(tx, [row]);
  if (!summary) throw notFound("intake");
  return {
    intake: {
      ...summary,
      leadNote: row.leadNote,
      lead: row.leadUserId ? { id: row.leadUserId, name: d.names.get(row.leadUserId) ?? "" } : null,
    },
    guide: d.guide,
    people: d.people.map(personView),
    answers,
    progress,
    events: [...d.events].reverse().map(eventView),
    unsentInvites: await unsentPeople(tx, row.tenantId, d.people),
  };
}

/** §1.220: the people whose latest invite didn't go out, for Send it again. */
async function unsentPeople(
  tx: Tx,
  tenantId: string,
  people: readonly Pick<PersonRow, "id">[],
): Promise<string[]> {
  const out: string[] = [];
  for (const p of people) if (await unsentInvite(tx, tenantId, p.id)) out.push(p.id);
  return out;
}

// ── The portal ──────────────────────────────────────────────────────────────────────────────────

export interface Viewer {
  userId: string;
  email: string;
  role: string;
}

/** Who this is on the intake: their person row (by user, else by address), and what they see. */
export function viewerOn(
  people: readonly PersonRow[],
  viewer: Viewer,
): { person: PersonRow | null; sections: string[] | null; isAdmin: boolean } | null {
  const email = viewer.email.trim().toLowerCase();
  const person =
    people.find((p) => p.userId === viewer.userId) ??
    people.find((p) => !p.userId && p.email === email) ??
    null;
  // DECISION: the client admin sees every card, asked or not (cases-plan §4.5: "all of them for the
  // admin"); a client user only the cards they were asked, and an intake that didn't ask them is
  // not theirs (404).
  if (viewer.role === "client_admin") return { person, sections: null, isAdmin: true };
  if (!person) return null;
  return { person, sections: person.sections, isAdmin: person.isAdmin };
}

/** Links a person to their user the first time they act (the welcome page does it at sign-in too). */
export async function claimPerson(tx: Tx, person: PersonRow | null, userId: string): Promise<void> {
  if (!person || person.userId) return;
  await tx
    .update(intakePerson)
    .set({ userId })
    .where(
      and(
        eq(intakePerson.id, person.id),
        eq(intakePerson.tenantId, person.tenantId),
        isNull(intakePerson.userId),
      ),
    );
}

/** The client's newest open intake that has gone out (a "Send at" in the future hasn't yet). */
export async function currentIntake(tx: Tx, tenantId: string, now: Date): Promise<IntakeRow[]> {
  return tx
    .select()
    .from(intake)
    .where(
      and(
        eq(intake.tenantId, tenantId),
        inArray(intake.status, [...OPEN_INTAKE_STATUSES]),
        or(isNull(intake.sendAt), lte(intake.sendAt, now)),
      ),
    )
    .orderBy(desc(intake.createdAt));
}

export async function portalView(
  tx: Tx,
  row: IntakeRow,
  viewer: Viewer,
): Promise<PortalIntakeView> {
  const d = await loadIntake(tx, row);
  const who = viewerOn(d.people, viewer);
  if (!who) throw notFound("intake");
  const visible = visibleSectionKeys(d.guide, who.sections);
  const sections = d.guide.sections.filter((s) => visible.includes(s.key));
  const fieldKeys = new Set(
    d.guide.sections.flatMap((s) =>
      s.fields
        .filter((f) => visible.includes(f.sectionKey) || f.alsoIn.some((k) => visible.includes(k)))
        .map((f) => f.key),
    ),
  );
  const answers = answerViews(d);
  return {
    intake: {
      id: row.id,
      status: row.status,
      startMode: row.startMode,
      leadNote: row.leadNote,
      lead: row.leadUserId ? { name: d.names.get(row.leadUserId) ?? "", photoUrl: null } : null,
      createdAt: row.createdAt.toISOString(),
    },
    // A question shared into a card whose home card this person doesn't see is asked on theirs
    // (it keeps its home's `sectionKey`): Mark, asked only for Purchasing, answers "who approves".
    sections: sections.map((s) => {
      const shown = portalSection(s);
      const shared = d.guide.sections
        .filter((home) => !visible.includes(home.key))
        .flatMap((home) => home.fields)
        .filter((f) => f.alsoIn.includes(s.key) && f.state !== "known")
        .map(portalField);
      return { ...shown, fields: [...shown.fields, ...shared] };
    }),
    answers: answers.filter((a) => fieldKeys.has(a.fieldKey)),
    progress: progressOf(d, answers).filter((p) => visible.includes(p.sectionKey)),
    people: d.people.map((p) => ({
      id: p.id,
      name: p.name,
      sections: p.sections,
      isAdmin: p.isAdmin,
    })),
    you: {
      personId: who.person?.id ?? null,
      sections: who.sections,
      isAdmin: who.isAdmin,
    },
  };
}

/** The first thing a client does on an intake that went out opens it. */
export async function markOpen(tx: Tx, row: IntakeRow): Promise<void> {
  if (row.status !== "sent") return;
  await tx
    .update(intake)
    .set({ status: "open" })
    .where(
      and(eq(intake.id, row.id), eq(intake.tenantId, row.tenantId), eq(intake.status, "sent")),
    );
}

/** An intake the client can still answer, or 409. */
export function ensureOpen(row: IntakeRow): void {
  if (!isOpen(row)) throw new HttpError(409, "closed", "this intake is closed");
}
