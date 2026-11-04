// Searching a client's knowledge: its FAQs and policies, its documents, and the asking agent's
// memory notes, with Postgres full-text search. Every hit carries the ids of the records it rests
// on (invariant 10). Only the given client's rows are read, inside its transaction (invariant 1).

import { knowledgeChunk, knowledgeEntry, memoryNote, type Tx } from "@countersign/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { tenantSearchConfig } from "./entries";

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 20;
export const SEARCH_QUERY_MAX = 500;

export type KnowledgeHitKind = "faq" | "policy" | "document" | "memory";

export interface KnowledgeHit {
  kind: KnowledgeHitKind;
  /** The entry, document or memory note. */
  id: string;
  title: string;
  /** The passage around the matched words, plain text. */
  excerpt: string;
  /** Higher is better; comparable within one search. */
  score: number;
  /** Record ids: entry and its version, document and its extraction, or the memory note. */
  sources: string[];
}

export interface SearchKnowledgeOptions {
  query: string;
  limit?: number;
  /**
   * Whose memory notes to search: an agent's own notes in the given scopes (a run's agent), all
   * of the client's live notes (`"all"`, the back office's preview), or none.
   */
  memory?: { agentId: string; scopes: string[] } | "all" | null;
}

const HEADLINE = `StartSel="", StopSel="", MaxWords=40, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;

/**
 * Any of the query's words, ranked by how many match and where: a question in natural language
 * ("when do you open on Saturday?") finds an entry that has only some of its words.
 */
// DECISION: words are OR-ed (plainto_tsquery with & turned into |) and ranked with ts_rank, rather
// than AND-ed as websearch_to_tsquery would: agents and callers ask whole questions, and an AND of
// every word would find nothing.
function anyWords(config: SQL, query: string): SQL {
  return sql`nullif(replace(plainto_tsquery(${config}, ${query})::text, ' & ', ' | '), '')::tsquery`;
}

/** True when the query has something to search for (letters or digits). */
export function searchable(query: string): boolean {
  return /[\p{L}\p{N}]/u.test(query);
}

export async function searchKnowledge(
  tx: Tx,
  tenantId: string,
  options: SearchKnowledgeOptions,
): Promise<KnowledgeHit[]> {
  const query = options.query.trim().slice(0, SEARCH_QUERY_MAX);
  const limit = Math.min(Math.max(options.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
  if (!searchable(query)) return [];

  // Passages: each indexed with its own configuration, so the query is parsed the same way.
  const rowConfig = sql`${knowledgeChunk.config}::regconfig`;
  const q = anyWords(rowConfig, query);
  const rank = sql<number>`ts_rank(${knowledgeChunk.tsv}, ${q})`;
  const chunks = await tx
    .select({
      sourceType: knowledgeChunk.sourceType,
      entryId: knowledgeChunk.entryId,
      entryVersionId: knowledgeChunk.entryVersionId,
      documentId: knowledgeChunk.documentId,
      extractionId: knowledgeChunk.extractionId,
      title: knowledgeChunk.title,
      kind: knowledgeEntry.kind,
      score: rank,
      excerpt: sql<string>`ts_headline(${rowConfig}, ${knowledgeChunk.body}, ${q}, ${HEADLINE})`,
    })
    .from(knowledgeChunk)
    .leftJoin(
      knowledgeEntry,
      and(
        eq(knowledgeEntry.id, knowledgeChunk.entryId),
        eq(knowledgeEntry.tenantId, knowledgeChunk.tenantId),
      ),
    )
    .where(
      and(
        eq(knowledgeChunk.tenantId, tenantId),
        sql`${knowledgeChunk.tsv} @@ ${q}`,
        sql`(${knowledgeChunk.sourceType} = 'document' or ${knowledgeEntry.status} = 'active')`,
      ),
    )
    .orderBy(sql`${rank} desc`, knowledgeChunk.id)
    .limit(limit * 4);

  const hits = new Map<string, KnowledgeHit>();
  for (const c of chunks) {
    const id = c.sourceType === "entry" ? c.entryId : c.documentId;
    if (!id || hits.has(id)) continue; // rows come best first: keep each source's best passage
    hits.set(id, {
      kind: c.sourceType === "entry" ? (c.kind ?? "faq") : "document",
      id,
      title: c.title,
      excerpt: c.excerpt,
      score: Number(c.score),
      sources:
        c.sourceType === "entry"
          ? [id, c.entryVersionId].filter((v): v is string => !!v)
          : [id, c.extractionId].filter((v): v is string => !!v),
    });
  }

  if (options.memory) {
    const config = sql`${await tenantSearchConfig(tx, tenantId)}::regconfig`;
    const mq = anyWords(config, query);
    const vector = sql`to_tsvector(${config}, ${memoryNote.note})`;
    const noteRank = sql<number>`ts_rank(${vector}, ${mq})`;
    const scope =
      options.memory === "all"
        ? [eq(memoryNote.scope, "agent")]
        : [
            eq(memoryNote.agentId, options.memory.agentId),
            inArray(memoryNote.scope, options.memory.scopes),
          ];
    const notes = await tx
      .select({
        id: memoryNote.id,
        note: memoryNote.note,
        score: noteRank,
        excerpt: sql<string>`ts_headline(${config}, ${memoryNote.note}, ${mq}, ${HEADLINE})`,
      })
      .from(memoryNote)
      .where(and(eq(memoryNote.tenantId, tenantId), ...scope, sql`${vector} @@ ${mq}`))
      .orderBy(sql`${noteRank} desc`, memoryNote.id)
      .limit(limit);
    for (const n of notes) {
      hits.set(n.id, {
        kind: "memory",
        id: n.id,
        title: "Memory note",
        excerpt: n.excerpt,
        score: Number(n.score),
        sources: [n.id],
      });
    }
  }

  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
