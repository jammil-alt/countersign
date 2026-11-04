// A client's FAQs and policies (docs/plan.md §1.21). An entry's row is its current state; every
// save (create, edit, archive) inserts the next immutable version, so who changed what and when
// is kept. Saving re-indexes the entry's passages in the same transaction, so search never shows
// a stale or archived text.

import {
  type KNOWLEDGE_AUTHOR_ROLES,
  type KNOWLEDGE_ENTRY_KINDS,
  knowledgeChunk,
  knowledgeEntry,
  knowledgeEntryVersion,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { chunkText, searchConfigFor } from "./chunk";

export type KnowledgeEntryKind = (typeof KNOWLEDGE_ENTRY_KINDS)[number];
export type KnowledgeAuthorRole = (typeof KNOWLEDGE_AUTHOR_ROLES)[number];

export class KnowledgeError extends Error {
  constructor(
    readonly code: "not_found" | "stale" | "archived",
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
  authorId: string | null;
  authorRole: KnowledgeAuthorRole;
};

function view(r: EntryRow): KnowledgeEntryView {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    version: r.version,
    versionId: r.versionId,
    title: r.title,
    body: r.body,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: { id: r.authorId, role: r.authorRole },
  };
}

function entriesQuery(tx: Tx, tenantId: string, ...conditions: (SQL | undefined)[]) {
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

/** The client's entries, most recently changed first; archived ones only when asked. */
export async function listKnowledgeEntries(
  tx: Tx,
  tenantId: string,
  options: { includeArchived?: boolean } = {},
): Promise<KnowledgeEntryView[]> {
  const rows = await entriesQuery(
    tx,
    tenantId,
    options.includeArchived ? undefined : eq(knowledgeEntry.status, "active"),
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
    status: r.status,
    author: { id: r.authorId, role: r.authorRole },
    createdAt: r.createdAt,
  }));
}

/** Replaces an entry's passages with those of the given version (none when archived). */
async function reindexEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  version: { id: string; title: string; body: string; status: "active" | "archived" },
): Promise<void> {
  await tx
    .delete(knowledgeChunk)
    .where(and(eq(knowledgeChunk.tenantId, tenantId), eq(knowledgeChunk.entryId, entryId)));
  if (version.status !== "active") return;
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
  v: {
    version: number;
    title: string;
    body: string;
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
      status: v.status,
      authorId: v.author.id,
      authorRole: v.author.role,
    })
    .returning();
  if (!row) throw new Error("knowledge entry version insert returned nothing");
  await reindexEntry(tx, tenantId, entryId, row);
  return row;
}

export async function createKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  input: { kind: KnowledgeEntryKind; title: string; body: string; author: KnowledgeAuthor },
): Promise<KnowledgeEntryView> {
  const [entry] = await tx
    .insert(knowledgeEntry)
    .values({ tenantId, kind: input.kind, version: 1, createdBy: input.author.id })
    .returning();
  if (!entry) throw new Error("knowledge entry insert returned nothing");
  await insertVersion(tx, tenantId, entry.id, {
    version: 1,
    title: input.title,
    body: input.body,
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
 * Saves a new version of an entry. An unchanged title and text save nothing. An archived entry is
 * restored by editing it.
 */
// DECISION: editing an archived entry restores it (a new active version), so "undo archive" needs
// no route of its own.
export async function editKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  input: { title: string; body: string; baseVersion: number; author: KnowledgeAuthor },
): Promise<KnowledgeEntryView> {
  const row = await lockEntry(tx, tenantId, entryId, input.baseVersion);
  const current = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!current) throw new KnowledgeError("not_found", "knowledge entry not found");
  if (row.status === "active" && current.title === input.title && current.body === input.body) {
    return current;
  }
  const next = row.version + 1;
  await insertVersion(tx, tenantId, entryId, {
    version: next,
    title: input.title,
    body: input.body,
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
  await insertVersion(tx, tenantId, entryId, {
    version: next,
    title: current.title,
    body: current.body,
    status: "archived",
    author: input.author,
  });
  await bump(tx, tenantId, entryId, next, "archived");
  const saved = await getKnowledgeEntry(tx, tenantId, entryId);
  if (!saved) throw new KnowledgeError("not_found", "knowledge entry not found");
  return saved;
}
