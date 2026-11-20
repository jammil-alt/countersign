// B6 (docs/builder-plan.md §8): the client's charter and tagged policies are `policy` entries whose
// version's meta carries `tier`, `tags` and who confirmed it. No migration: `meta` is JSON. Versions
// stay immutable (invariant 3): a confirmation is the next version with the same text.
//
// The charter counts for agents only as its latest confirmed version, so an edit we make (a new
// draft) changes nothing an agent reads until the client admin confirms it.

import type { ClientGovernance, ClientPolicy } from "@countersign/core";
import { knowledgeEntry, knowledgeEntryVersion, type Tx } from "@countersign/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  editKnowledgeEntry,
  entriesQuery,
  entryViews,
  type KnowledgeAuthor,
  type KnowledgeEntryView,
  KnowledgeError,
  type KnowledgeMeta,
  type KnowledgeVersionView,
  knowledgeEntryVersions,
} from "./entries";

export type GovernanceTierValue = "charter" | "policy";

export interface GovernanceMeta {
  tier: GovernanceTierValue | null;
  tags: string[];
  confirmedBy: string | null;
  confirmedAt: string | null;
}

/** The governance fields of a version's meta, whatever else it holds. */
export function governanceMeta(meta: KnowledgeMeta): GovernanceMeta {
  const tier = meta.tier === "charter" || meta.tier === "policy" ? meta.tier : null;
  const tags = Array.isArray(meta.tags)
    ? [...new Set(meta.tags.filter((t): t is string => typeof t === "string"))].sort()
    : [];
  const confirmedAt = typeof meta.confirmedAt === "string" ? meta.confirmedAt : null;
  const confirmedBy = typeof meta.confirmedBy === "string" ? meta.confirmedBy : null;
  return { tier, tags, confirmedBy: confirmedAt ? confirmedBy : null, confirmedAt };
}

/** A version's meta without its confirmation: what an edit saves before anyone confirms it. */
export function unconfirmedMeta(meta: KnowledgeMeta): KnowledgeMeta {
  const { confirmedBy: _by, confirmedAt: _at, ...rest } = meta;
  return rest;
}

/**
 * The meta for a new version of an entry: the current meta, its tags replaced when given, never
 * the earlier confirmation; confirmed by `confirm` when the person saving it confirms it too.
 */
export function nextMeta(
  current: KnowledgeMeta,
  change: { tags?: string[] | undefined; confirm?: { by: string; at: Date } | undefined },
): KnowledgeMeta {
  const meta: KnowledgeMeta = unconfirmedMeta(current);
  if (change.tags !== undefined) {
    if (change.tags.length > 0) meta.tags = [...new Set(change.tags)].sort();
    else delete meta.tags;
  }
  if (change.confirm) {
    meta.confirmedBy = change.confirm.by;
    meta.confirmedAt = change.confirm.at.toISOString();
  }
  return meta;
}

/** The client's active charter entry, if it has one (the most recently changed). */
export async function charterEntry(tx: Tx, tenantId: string): Promise<KnowledgeEntryView | null> {
  const rows = await entriesQuery(
    tx,
    tenantId,
    eq(knowledgeEntry.kind, "policy"),
    eq(knowledgeEntry.status, "active"),
    sql`${knowledgeEntryVersion.meta}->>'tier' = 'charter'`,
  )
    .orderBy(desc(knowledgeEntry.updatedAt), desc(knowledgeEntry.id))
    .limit(1);
  return entryViews(rows)[0] ?? null;
}

/** The entry's latest version a client admin confirmed (and not archived), or null. */
export async function latestConfirmedVersion(
  tx: Tx,
  tenantId: string,
  entryId: string,
): Promise<KnowledgeVersionView | null> {
  const versions = await knowledgeEntryVersions(tx, tenantId, entryId);
  for (let i = versions.length - 1; i >= 0; i--) {
    const v = versions[i] as KnowledgeVersionView;
    if (v.status === "active" && governanceMeta(v.meta).confirmedAt) return v;
  }
  return null;
}

/**
 * What the runtime reads for a client (`@countersign/core`'s `composeGovernance`): the charter's
 * latest confirmed version, and the active policies that carry tags (an untagged policy is read
 * only through search, as before B6).
 */
// DECISION: a client's tagged policy needs no confirmation to be read; the client admin writes
// most of them, and one we write is theirs to see and archive in the portal. Only the charter, read
// on every call, waits for the client admin's confirmation.
export async function clientGovernance(tx: Tx, tenantId: string): Promise<ClientGovernance> {
  const charter = await charterEntry(tx, tenantId);
  const confirmed = charter ? await latestConfirmedVersion(tx, tenantId, charter.id) : null;
  const rows = await entriesQuery(
    tx,
    tenantId,
    eq(knowledgeEntry.kind, "policy"),
    eq(knowledgeEntry.status, "active"),
    sql`coalesce(${knowledgeEntryVersion.meta}->>'tier', 'policy') <> 'charter'`,
    sql`jsonb_typeof(${knowledgeEntryVersion.meta}->'tags') = 'array'`,
  )
    .orderBy(knowledgeEntry.id)
    .limit(200);
  const policies: ClientPolicy[] = entryViews(rows)
    .map((e) => ({
      entryId: e.id,
      version: e.version,
      title: e.title,
      body: e.body,
      tags: governanceMeta(e.meta).tags,
    }))
    .filter((p) => p.tags.length > 0);
  return {
    charter:
      charter && confirmed
        ? {
            entryId: charter.id,
            version: confirmed.version,
            title: confirmed.title,
            body: confirmed.body,
          }
        : null,
    policies,
  };
}

/**
 * The client admin confirms a charter or policy as it reads now: the next version, same text,
 * with who and when. Confirming a version already confirmed saves nothing.
 */
export async function confirmKnowledgeEntry(
  tx: Tx,
  tenantId: string,
  entryId: string,
  input: { baseVersion: number; author: KnowledgeAuthor & { id: string }; at: Date },
): Promise<KnowledgeEntryView> {
  const [row] = await tx
    .select({ kind: knowledgeEntry.kind, version: knowledgeEntry.version })
    .from(knowledgeEntry)
    .where(and(eq(knowledgeEntry.tenantId, tenantId), eq(knowledgeEntry.id, entryId)));
  if (row?.kind !== "policy") throw new KnowledgeError("not_found", "no such policy");
  const current = entryViews(
    await entriesQuery(tx, tenantId, eq(knowledgeEntry.id, entryId)),
  )[0] as KnowledgeEntryView;
  if (current.status !== "active") throw new KnowledgeError("archived", "this is archived");
  if (row.version !== input.baseVersion) {
    throw new KnowledgeError(
      "stale",
      `this entry changed since you opened it (now version ${row.version})`,
    );
  }
  if (governanceMeta(current.meta).confirmedAt) return current;
  return editKnowledgeEntry(tx, tenantId, entryId, {
    title: current.title,
    body: current.body,
    meta: nextMeta(current.meta, { confirm: { by: input.author.id, at: input.at } }),
    baseVersion: input.baseVersion,
    author: input.author,
  });
}
