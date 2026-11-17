// Saved starts (docs/cases-plan.md §4.3; docs/plan.md §1.149): Sign up now's and Invite's presets.
// Operator only and global (`sales_start`). A few are seeded in code, once each by their
// `seed_key`, from the running platform: General only, one per area that has a pack, one per
// published template, and Just the account. Archived, never deleted.

import {
  Covers,
  DEFAULT_START_MODE,
  type IntakeArea,
  type NewSalesStart,
  processArea,
  type SalesStartView,
  SUPERVISOR_SLUG,
  type UpdateSalesStart,
} from "@countersign/core";
import { agent, salesStart, type Tx } from "@countersign/db";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { HttpError, iso, notFound } from "../http";

export type StartRow = typeof salesStart.$inferSelect;

/** An area's name, as the back office and the confirmation say it. */
export const AREA_WORDS: Record<IntakeArea, string> = {
  purchasing: "Purchasing",
  sales: "Sales",
  receivables: "Receivables",
  bookkeeping: "Bookkeeping",
  marketing: "Marketing",
};

/**
 * Templates that are the platform's own (the Builder, the Coordinator, Sloan): never sold, so no
 * start of their own.
 */
// DECISION: by slug, as the seed names them; a template the operator makes is always offered.
export const PLATFORM_TEMPLATE_SLUGS: readonly string[] = [
  "builder",
  "coordinator",
  SUPERVISOR_SLUG,
];

// DECISION (cases-plan §8 q18, the design): the seeded starts' notes are short and plain; the lead
// edits them per send. Each area's and template's start asks the general questions too, so a new
// client is asked about the business once; Invite can untick it.
const GENERAL_NOTE =
  "A few questions about your business, so we can set Mezonas up around how you work. It takes about 15 minutes.";
const areaNote = (area: IntakeArea) =>
  `A few questions about your business and how ${AREA_WORDS[area].toLowerCase()} works today, so we can set up the right agents.`;
const templateNote = (name: string) =>
  `A few questions about your business and what ${name} needs from you, so we can set it up.`;

interface SeedStart {
  key: string;
  name: string;
  covers: Covers;
  note: string;
}

/** The areas the running platform has a pack for (Purchasing, Bookkeeping, Marketing today). */
export function areasWithPacks(packIds: readonly string[]): IntakeArea[] {
  const out = new Set<IntakeArea>();
  for (const id of packIds) {
    const area = processArea({ requiresPacks: [id] });
    if (area !== "general") out.add(area);
  }
  return [...out];
}

/** Published templates a client can have: active, with a live version, not the platform's own. */
export async function sellableTemplates(
  tx: Tx,
  ids?: readonly string[],
): Promise<{ id: string; slug: string; name: string }[]> {
  return tx
    .select({ id: agent.id, slug: agent.slug, name: agent.name })
    .from(agent)
    .where(
      and(
        isNull(agent.tenantId),
        eq(agent.kind, "template"),
        eq(agent.status, "active"),
        isNotNull(agent.liveVersionId),
        sql`${agent.slug} <> all(${`{${PLATFORM_TEMPLATE_SLUGS.join(",")}}`}::text[])`,
        ...(ids ? [inArray(agent.id, ids.length > 0 ? [...ids] : [crypto.randomUUID()])] : []),
      ),
    )
    .orderBy(asc(agent.name));
}

/** Seeds the starts the platform offers, once each by key (concurrent seeding is harmless). */
export async function seedStarts(tx: Tx, packIds: readonly string[]): Promise<void> {
  const seeds: SeedStart[] = [
    {
      key: "general",
      name: "General only",
      covers: { general: true, areas: [], templateIds: [] },
      note: GENERAL_NOTE,
    },
    ...areasWithPacks(packIds).map((area) => ({
      key: `area:${area}`,
      name: AREA_WORDS[area],
      covers: { general: true, areas: [area], templateIds: [] },
      note: areaNote(area),
    })),
    ...(await sellableTemplates(tx)).map((t) => ({
      key: `template:${t.slug}`,
      name: t.name.slice(0, 80),
      covers: { general: true, areas: [], templateIds: [t.id] },
      note: templateNote(t.name),
    })),
    {
      key: "account",
      name: "Just the account",
      covers: { general: false, areas: [], templateIds: [] },
      note: "",
    },
  ];
  await tx
    .insert(salesStart)
    .values(
      seeds.map((s) => ({
        name: s.name,
        covers: s.covers,
        note: s.note,
        startMode: DEFAULT_START_MODE,
        seeded: true,
        seedKey: s.key,
      })),
    )
    .onConflictDoNothing({
      target: salesStart.seedKey,
      where: sql`${salesStart.seedKey} is not null`,
    });
}

export function startView(r: StartRow): SalesStartView {
  const covers = Covers.safeParse(r.covers);
  return {
    id: r.id,
    name: r.name,
    covers: covers.success ? covers.data : { general: false, areas: [], templateIds: [] },
    note: r.note,
    startMode: r.startMode,
    seeded: r.seeded,
    archived: r.archivedAt !== null,
    createdAt: iso(r.createdAt) as string,
    updatedAt: iso(r.updatedAt) as string,
  };
}

export async function listStarts(tx: Tx, archived: boolean): Promise<StartRow[]> {
  return tx
    .select()
    .from(salesStart)
    .where(archived ? undefined : isNull(salesStart.archivedAt))
    .orderBy(sql`${salesStart.seeded} desc`, asc(salesStart.createdAt), asc(salesStart.name));
}

export async function readStart(tx: Tx, id: string, lock = false): Promise<StartRow> {
  const q = tx.select().from(salesStart).where(eq(salesStart.id, id));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw notFound("start");
  return row;
}

/** Refuses a covers naming a template a client can't have. */
export async function checkCovers(tx: Tx, covers: Covers): Promise<void> {
  if (covers.templateIds.length === 0) return;
  const found = await sellableTemplates(tx, covers.templateIds);
  if (found.length !== covers.templateIds.length) {
    throw new HttpError(422, "unknown_template", "a template in it is not published");
  }
}

export async function createStart(tx: Tx, body: NewSalesStart, userId: string): Promise<StartRow> {
  await checkCovers(tx, body.covers);
  const [row] = await tx
    .insert(salesStart)
    .values({
      name: body.name,
      covers: body.covers,
      note: body.note,
      startMode: body.startMode,
      createdBy: userId,
    })
    .returning();
  if (!row) throw new Error("start insert returned nothing");
  return row;
}

export async function updateStart(tx: Tx, id: string, body: UpdateSalesStart): Promise<StartRow> {
  const row = await readStart(tx, id, true);
  const set: Partial<typeof salesStart.$inferInsert> = {};
  if (body.name !== undefined) set.name = body.name;
  if (body.covers !== undefined) {
    await checkCovers(tx, body.covers);
    set.covers = body.covers;
  }
  if (body.note !== undefined) set.note = body.note;
  if (body.startMode !== undefined) set.startMode = body.startMode;
  if (body.archived !== undefined) set.archivedAt = body.archived ? new Date() : null;
  if (Object.keys(set).length === 0) return row;
  const [updated] = await tx
    .update(salesStart)
    .set(set)
    .where(eq(salesStart.id, row.id))
    .returning();
  if (!updated) throw new Error("start update returned nothing");
  return updated;
}
