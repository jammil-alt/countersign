// A client's FAQs and policies (docs/plan.md §1.21), and its people's voice samples (§1.42). An
// entry's row is its current state; every save (create, edit, archive) inserts the next immutable
// version, so who changed what and when is kept. Saving re-indexes the entry's passages in the same
// transaction, so search never shows a stale or archived text. Voice samples are never indexed:
// agents read them only through `knowledge.voice_samples`.

import {
  type KNOWLEDGE_AUTHOR_ROLES,
  type KNOWLEDGE_ENTRY_KINDS,
  knowledgeChunk,
  knowledgeEntry,
  knowledgeEntryVersion,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, desc, eq, ne, type SQL, sql } from "drizzle-orm";
import { chunkText, searchConfigFor } from "./chunk";

export type KnowledgeEntryKind = (typeof KNOWLEDGE_ENTRY_KINDS)[number];
export type KnowledgeAuthorRole = (typeof KNOWLEDGE_AUTHOR_ROLES)[number];

/** Free-form per-version data: a voice sample's `{personUserId, channel}`; `{}` otherwise. */
export type KnowledgeMeta = Record<string, unknown>;

export class KnowledgeError extends Error {
  constructor(
    readonly code: "not_found" | "stale" | "archived" | "not_a_person" | "no_person",
    message: string,
  ) {
    super(message);
  }
}

export interface KnowledgeAuthor {
  id: string | null;
  role: KnowledgeAuthorRole;
}

export interface KnowledgeEntryView {
  id: string;
  kind: KnowledgeEntryKind;
  status: "active" | "archived";
  version: number;
  /** The current version's id (what search cites). */
  versionId: string;
  title: string;
  body: string;
  meta: KnowledgeMeta;
  createdAt: Date;
  updatedAt: Date;
  /** Who saved the current version. */
  updatedBy: KnowledgeAuthor;
}

export interface KnowledgeVersionView {
  id: string;
  version: number;
  title: string;
  body: string;
  meta: KnowledgeMeta;
  status: "active" | "archived";
  author: KnowledgeAuthor;
  createdAt: Date;
}

/** The client's text-search configuration, from its language. */
export async function tenantSearchConfig(tx: Tx, tenantId: string): Promise<string> {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const settings = (row?.settings ?? {}) as Record<string, unknown>;
  return searchConfigFor(settings.language);
}

const entryColumns = {
  id: knowledgeEntry.id,
  kind: knowledgeEntry.kind,
  status: knowledgeEntry.status,
  version: knowledgeEntry.version,
  createdAt: knowledgeEntry.createdAt,
  updatedAt: knowledgeEntry.updatedAt,
  versionId: knowledgeEntryVersion.id,
  title: knowledgeEntryVersion.title,
  body: knowledgeEntryVersion.body,
  meta: knowledgeEntryVersion.meta,
  authorId: knowledgeEntryVersion.authorId,
  authorRole: knowledgeEntryVersion.authorRole,
};

type EntryRow = {
  id: string;
  kind: KnowledgeEntryKind;
  status: "active" | "archived";
  version: number;
  createdAt: Date;
  updatedAt: Date;
  versionId: string;
  title: string;
  body: string;
  meta: unknown;
  authorId: string | null;
  authorRole: KnowledgeAuthorRole;
};

function metaOf(value: unknown): KnowledgeMeta {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as KnowledgeMeta)
    : {};
}

function view(r: EntryRow): KnowledgeEntryView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: r.version,
    versionId: r.versionId,
    title: r.title,
    body: r.body,
    meta: metaOf(r.meta),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: { id: r.authorId, role: r.authorRole },
  };
}

export function entriesQuery(tx: Tx, tenantId: string, ...conditions: (SQL | undefined)[]) {
  return tx
    .select(entryColumns)
    .from(knowledgeEntry)
    .innerJoin(
      knowledgeEntryVersion,
      and(
        eq(knowledgeEntryVersion.entryId, knowledgeEntry.id),
        eq(knowledgeEntryVersion.tenantId, knowledgeEntry.tenantId),
        eq(knowledgeEntryVersion.version, knowledgeEntry.version),
      ),
    )
    .where(and(eq(knowledgeEntry.tenantId, tenantId), ...conditions));
}

/** Rows of `entriesQuery` as views. */
export function entryViews(rows: EntryRow[]): KnowledgeEntryView[] {
  return rows.map(view);
}

/**
 * The client's entries, most recently changed first; archived ones only when asked. Voice
 * samples only when asked (`kind`), so lists of FAQs and policies stay as they were.
 */
export async function listKnowledgeEntries(
  tx: Tx,
  tenantId: string,
  options: { includeArchived?: boolean; kind?: KnowledgeEntryKind } = {},
): Promise<KnowledgeEntryView[]> {
  const rows = await entriesQuery(
    tx,
    tenantId,
    options.includeArchived ? undefined : eq(knowledgeEntry.status, "active"),
    // v0.12 W1-G: voice samples are listed on their own.
    options.kind
      ? eq(knowledgeEntry.kind, options.kind)
      : ne(knowledgeEntry.kind, "voice_sample"),
  )
    .orderBy(desc(knowledgeEntry.updatedAt), desc(knowledgeEntry.id))
    .limit(500);
  return rows.map(view);
}

export async function getKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
): Promise<KnowledgeEntryView | null> {
  const [row] = await entriesQuery(tx, tenantId, eq(knowledgeEntry.id, entryId));
  return row ? view(row) : null;
}

/** Every version of an entry, oldest first. */
export async function knowledgeEntryVersions(
  tx: Tx,
  tenantId: string,
  entryId: string,
): Promise<KnowledgeVersionView[]> {
  const rows = await tx
    .select()
    .from(knowledgeEntryVersion)
    .where(
      and(eq(knowledgeEntryVersion.tenantId, tenantId), eq(knowledgeEntryVersion.entryId, entryId)),
    )
    .orderBy(asc(knowledgeEntryVersion.version));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    body: r.body,
    meta: metaOf(r.meta),
    status: r.status,
    author: { id: r.authorId, role: r.authorRole },
    createdAt: r.createdAt,
  }));
}

/**
 * Replaces an entry's passages with those of the given version (none when archived, and none for
 * a voice sample: those are never searched, docs/plan.md §1.42).
 */
async function reindexEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  kind: KnowledgeEntryKind,
  version: { id: string; title: string; body: string; status: "active" | "archived" },
): Promise<void> {
  await tx
    .delete(knowledgeChunk)
    .where(and(eq(knowledgeChunk.tenantId, tenantId), eq(knowledgeChunk.entryId, entryId)));
  if (version.status !== "active") return;
  if (kind === "voice_sample") return;
  const config = await tenantSearchConfig(tx, tenantId);
  const bodies = chunkText(version.body);
  const passages = bodies.length > 0 ? bodies : [""];
  await tx.insert(knowledgeChunk).values(
    passages.map((body, chunkNo) => ({
      tenantId,
      sourceType: "entry" as const,
      entryId,
      entryVersionId: version.id,
      chunkNo,
      title: version.title,
      body,
      config,
      // The title weighs more than the text: a question's words in a title are the best match.
      tsv: sql`setweight(to_tsvector(${config}::regconfig, ${version.title}), 'A') || setweight(to_tsvector(${config}::regconfig, ${body}), 'B')`,
    })),
  );
}

async function insertVersion(
  tx: Tx,
  tenantId: string,
  entryId: string,
  kind: KnowledgeEntryKind,
  v: {
    version: number;
    title: string;
    body: string;
    meta: KnowledgeMeta;
    status: "active" | "archived";
    author: KnowledgeAuthor;
  },
) {
  const [row] = await tx
    .insert(knowledgeEntryVersion)
    .values({
      tenantId,
      entryId,
      version: v.version,
      title: v.title,
      body: v.body,
      meta: v.meta,
      status: v.status,
      authorId: v.author.id,
      authorRole: v.author.role,
    })
    .returning();
  if (!row) throw new Error("knowledge entry version insert returned nothing");
  await reindexEntry(tx, tenantId, entryId, kind, row);
  return row;
}

export async function createKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  input: {
    kind: KnowledgeEntryKind;
    title: string;
    body: string;
    meta?: KnowledgeMeta;
    author: KnowledgeAuthor;
  },
): Promise<KnowledgeEntryView> {
  const [entry] = await tx
    .insert(knowledgeEntry)
    .values({ tenantId, kind: input.kind, version: 1, createdBy: input.author.id })
    .returning();
  if (!entry) throw new Error("knowledge entry insert returned nothing");
  await insertVersion(tx, tenantId, entry.id, input.kind, {
    version: 1,
    title: input.title,
    body: input.body,
    meta: input.meta ?? {},
    status: "active",
    author: input.author,
  });
  const created = await getKnowledgeEntry(tx, tenantId, entry.id);
  if (!created) throw new Error("knowledge entry vanished");
  return created;
}

/** The entry locked for a change, checked against the version the editor started from. */
async function lockEntry(tx: Tx, tenantId: string, entryId: string, baseVersion: number) {
  const [row] = await tx
    .select()
    .from(knowledgeEntry)
    .where(and(eq(knowledgeEntry.tenantId, tenantId), eq(knowledgeEntry.id, entryId)))
    .for("update");
  if (!row) throw new KnowledgeError("not_found", "knowledge entry not found");
  if (row.version !== baseVersion) {
    throw new KnowledgeError(
      "stale",
      `this entry changed since you opened it (now version ${row.version})`,
    );
  }
  return row;
}

async function bump(
  tx: Tx,
  tenantId: string,
  entryId: string,
  version: number,
  status: "active" | "archived",
) {
  await tx
    .update(knowledgeEntry)
    .set({ version, status, updatedAt: new Date() })
    .where(and(eq(knowledgeEntry.tenantId, tenantId), eq(knowledgeEntry.id, entryId)));
}

/**
 * Saves a new version of an entry. An unchanged title, text and meta save nothing. An archived
 * entry is restored by editing it. `meta` left out keeps the current version's.
 */
// DECISION: editing an archived entry restores it (a new active version), so "undo archive" needs
// no route of its own.
export async function editKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  input: {
    title: string;
    body: string;
    meta?: KnowledgeMeta;
    baseVersion: number;
    author: KnowledgeAuthor;
  },
): Promise<KnowledgeEntryView> {
  const row = await lockEntry(tx, tenantId, entryId, input.baseVersion);
  const current = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!current) throw new KnowledgeError("not_found", "knowledge entry not found");
  const meta = input.meta ?? current.meta;
  if (
    row.status === "active" &&
    current.title === input.title &&
    current.body === input.body &&
    JSON.stringify(current.meta) === JSON.stringify(meta)
  ) {
    return current;
  }
  const next = row.version + 1;
  await insertVersion(tx, tenantId, entryId, row.kind, {
    version: next,
    title: input.title,
    body: input.body,
    meta,
    status: "active",
    author: input.author,
  });
  await bump(tx, tenantId, entryId, next, "active");
  const saved = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!saved) throw new KnowledgeError("not_found", "knowledge entry not found");
  return saved;
}

/** Takes an entry out of search: a new, archived version with the same text. */
export async function archiveKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  input: { baseVersion: number; author: KnowledgeAuthor },
): Promise<KnowledgeEntryView> {
  const row = await lockEntry(tx, tenantId, entryId, input.baseVersion);
  if (row.status === "archived") throw new KnowledgeError("archived", "already archived");
  const current = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!current) throw new KnowledgeError("not_found", "knowledge entry not found");
  const next = row.version + 1;
  await insertVersion(tx, tenantId, entryId, row.kind, {
    version: next,
    title: current.title,
    body: current.body,
    meta: current.meta,
    status: "archived",
    author: input.author,
  });
  await bump(tx, tenantId, entryId, next, "archived");
  const saved = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!saved) throw new KnowledgeError("not_found", "knowledge entry not found");
  return saved;
}
