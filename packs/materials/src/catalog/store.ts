// The catalog's reads and writes, each inside the caller's client-scoped transaction (withTenant:
// RLS shows one client's rows, invariant 1). Queries also filter by tenant_id. Nothing here calls
// a model; ./match.ts keeps model calls outside transactions.

import { docExtraction, docLine, document, type Tx, transaction, vendor } from "@countersign/db";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import {
  type Category,
  catalogItem,
  itemAlias,
  itemMatch,
  type MatchDecision,
  type MatchMethod,
} from "../schema";
import { canonicalName, keySignature, type ParsedLine, statedKeys } from "./keys";
import type { Attributes } from "./parsers";

export type CatalogItemRow = typeof catalogItem.$inferSelect;

export interface LineRow {
  id: string;
  vendorSku: string | null;
  rawDescription: string;
  uomRaw: string | null;
  qty: string;
  unitPrice: string;
  extractionId: string;
  documentId: string;
  transactionId: string | null;
  vendorId: string | null;
  /** The vendor's learned abbreviations (`vendor.ext.abbreviations`). */
  abbreviations: Record<string, string>;
}

/** A document line with the vendor of its document's transaction. */
export async function loadLine(
  tx: Tx,
  tenantId: string,
  docLineId: string,
): Promise<LineRow | null> {
  const [row] = await tx
    .select({
      id: docLine.id,
      vendorSku: docLine.vendorSku,
      rawDescription: docLine.rawDescription,
      uomRaw: docLine.uomRaw,
      qty: docLine.qty,
      unitPrice: docLine.unitPrice,
      extractionId: docLine.extractionId,
      documentId: docExtraction.documentId,
      transactionId: document.transactionId,
      vendorId: transaction.vendorId,
      vendorExt: vendor.ext,
    })
    .from(docLine)
    .innerJoin(docExtraction, eq(docExtraction.id, docLine.extractionId))
    .innerJoin(document, eq(document.id, docExtraction.documentId))
    .leftJoin(transaction, eq(transaction.id, document.transactionId))
    .leftJoin(vendor, eq(vendor.id, transaction.vendorId))
    .where(and(eq(docLine.id, docLineId), eq(docLine.tenantId, tenantId)))
    .limit(1);
  if (!row) return null;
  const { vendorExt, ...line } = row;
  const abbreviations = (vendorExt?.abbreviations ?? {}) as Record<string, string>;
  return { ...line, abbreviations: typeof abbreviations === "object" ? abbreviations : {} };
}

/** The item an id names now: itself, or the item it was merged into (followed to the end). */
export async function liveItem(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<CatalogItemRow | null> {
  let current = id;
  for (let hop = 0; hop < 16; hop++) {
    const [row] = await tx
      .select()
      .from(catalogItem)
      .where(and(eq(catalogItem.id, current), eq(catalogItem.tenantId, tenantId)))
      .limit(1);
    if (!row) return null;
    if (!row.mergedIntoId) return row;
    current = row.mergedIntoId;
  }
  return null;
}

/** Step 2: the vendor's SKU alias, then its description alias. */
export async function findAlias(
  tx: Tx,
  tenantId: string,
  key: { vendorId: string; vendorSku: string | null; descriptionHash: string },
): Promise<{ item: CatalogItemRow; via: "sku" | "description" } | null> {
  const lookups: { via: "sku" | "description"; sku: string; hash: string }[] = [];
  if (key.vendorSku) lookups.push({ via: "sku", sku: key.vendorSku, hash: "" });
  lookups.push({ via: "description", sku: "", hash: key.descriptionHash });
  for (const l of lookups) {
    // The same expressions as the unique index (migration 0006), so the lookup uses it.
    const [hit] = await tx
      .select({ catalogItemId: itemAlias.catalogItemId })
      .from(itemAlias)
      .where(
        and(
          eq(itemAlias.tenantId, tenantId),
          eq(itemAlias.vendorId, key.vendorId),
          sql`coalesce(${itemAlias.vendorSku}, '') = ${l.sku}`,
          sql`coalesce(${itemAlias.descriptionHash}, '') = ${l.hash}`,
        ),
      )
      .limit(1);
    if (!hit) continue;
    const item = await liveItem(tx, tenantId, hit.catalogItemId);
    if (item) return { item, via: l.via };
  }
  return null;
}

export interface Candidate {
  item: CatalogItemRow;
  /** Trigram similarity of names, 0..1 (null for candidates found by equal key attributes). */
  similarity: number | null;
}

/**
 * Step 4: live items in the line's category containing every key attribute the line states,
 * then the closest names by trigram as a backstop.
 */
export async function findCandidates(
  tx: Tx,
  tenantId: string,
  parsed: ParsedLine,
  options: { limit?: number; trigramLimit?: number } = {},
): Promise<Candidate[]> {
  const live = and(
    eq(catalogItem.tenantId, tenantId),
    eq(catalogItem.category, parsed.category),
    isNull(catalogItem.mergedIntoId),
  ) as SQL;
  const stated = statedKeys(parsed.category, parsed.attributes);
  const byKeys =
    Object.keys(stated).length === 0
      ? []
      : await tx
          .select()
          .from(catalogItem)
          .where(and(live, sql`${catalogItem.attributes} @> ${JSON.stringify(stated)}::jsonb`))
          .orderBy(catalogItem.createdAt)
          .limit(options.limit ?? 20);
  const name = canonicalName(parsed.category, parsed.attributes, parsed.normalized);
  const similarity = sql<number>`similarity(${catalogItem.canonicalName}, ${name})`;
  const byName = await tx
    .select({ item: catalogItem, similarity })
    .from(catalogItem)
    .where(and(live, sql`${catalogItem.canonicalName} % ${name}`))
    .orderBy(desc(similarity))
    .limit(options.trigramLimit ?? 5);
  const out: Candidate[] = byKeys.map((item) => ({ item, similarity: null }));
  const seen = new Set(out.map((c) => c.item.id));
  for (const r of byName) {
    if (seen.has(r.item.id)) continue;
    seen.add(r.item.id);
    out.push({ item: r.item, similarity: Number(r.similarity) });
  }
  return out;
}

export type Creator = { agentVersionId: string } | { userId: string };

/**
 * A catalog item for a parsed line. When the line's key signature is complete and a live item
 * already has it (another run made it a moment ago), that item is answered instead.
 */
export async function createItem(
  tx: Tx,
  tenantId: string,
  parsed: ParsedLine,
  by: Creator,
  /** §1.88: a master item from the vendor path keeps no vendor's wording (`firstDescription`). */
  options: { vendorNeutral?: boolean } = {},
): Promise<{ item: CatalogItemRow; created: boolean }> {
  const signature = keySignature(parsed.category, parsed.attributes);
  const [row] = await tx
    .insert(catalogItem)
    .values({
      tenantId,
      category: parsed.category,
      canonicalName: canonicalName(parsed.category, parsed.attributes, parsed.normalized),
      attributes: parsed.attributes,
      standardUom: parsed.standardUom,
      keySignature: signature,
      ...("agentVersionId" in by
        ? { createdByAgentVersionId: by.agentVersionId }
        : { createdByUserId: by.userId }),
      ext: options.vendorNeutral
        ? { parsedBy: parsed.parsedBy }
        : { parsedBy: parsed.parsedBy, firstDescription: parsed.normalized },
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { item: row, created: true };
  const [existing] = await tx
    .select()
    .from(catalogItem)
    .where(
      and(
        eq(catalogItem.tenantId, tenantId),
        eq(catalogItem.keySignature, signature ?? ""),
        isNull(catalogItem.mergedIntoId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("catalog item insert returned nothing");
  return { item: existing, created: false };
}

export interface MatchRecord {
  docLineId: string;
  catalogItemId: string | null;
  decision: MatchDecision;
  confidence: number;
  method: MatchMethod;
  hingeAttribute: string | null;
  candidates: unknown[];
  by: Creator;
}

export async function recordMatch(tx: Tx, tenantId: string, m: MatchRecord): Promise<string> {
  const [row] = await tx
    .insert(itemMatch)
    .values({
      tenantId,
      docLineId: m.docLineId,
      catalogItemId: m.catalogItemId,
      decision: m.decision,
      confidence: m.confidence.toFixed(3),
      method: m.method,
      hingeAttribute: m.hingeAttribute,
      candidates: m.candidates,
      ...("agentVersionId" in m.by
        ? { agentVersionId: m.by.agentVersionId }
        : { decidedByUserId: m.by.userId }),
    })
    .returning({ id: itemMatch.id });
  if (!row) throw new Error("item_match insert returned nothing");
  return row.id;
}

/**
 * Remembers what a vendor calls an item: its SKU (when the line has one) and its description.
 */
// DECISION: automatic matches teach `auto` aliases and people's decisions `human` ones; an `auto`
// alias never replaces a `human` one, and a person's decision replaces either.
export async function learnAlias(
  tx: Tx,
  tenantId: string,
  alias: {
    vendorId: string;
    vendorSku: string | null;
    descriptionHash: string;
    normalizedDescription: string;
    catalogItemId: string;
    source: "auto" | "human";
    /** §1.88: the vendor item the wording names, when known (0047). */
    vendorItemId?: string | null | undefined;
  },
): Promise<void> {
  const rows: { sku: string | null; hash: string | null }[] = [
    ...(alias.vendorSku ? [{ sku: alias.vendorSku, hash: null }] : []),
    { sku: null, hash: alias.descriptionHash },
  ];
  const vendorItemId = alias.vendorItemId ?? null;
  for (const r of rows) {
    // §1.88: an alias that changes item takes the new vendor item (or none); one that keeps its
    // item keeps the vendor item it had when none is given.
    await tx.execute(sql`
      insert into item_alias
        (tenant_id, vendor_id, vendor_sku, description_hash, normalized_description,
         catalog_item_id, source, vendor_item_id)
      values (${tenantId}, ${alias.vendorId}, ${r.sku}, ${r.hash}, ${alias.normalizedDescription},
              ${alias.catalogItemId}, ${alias.source}, ${vendorItemId})
      on conflict (tenant_id, vendor_id, coalesce(vendor_sku, ''), coalesce(description_hash, ''))
      do update set vendor_item_id = case
                      when item_alias.catalog_item_id = excluded.catalog_item_id
                        then coalesce(excluded.vendor_item_id, item_alias.vendor_item_id)
                      else excluded.vendor_item_id end,
                    catalog_item_id = excluded.catalog_item_id,
                    source = excluded.source,
                    normalized_description = excluded.normalized_description,
                    updated_at = now()
      where item_alias.source = 'auto' or excluded.source = 'human'`);
  }
}

/** The newest decision about a line. */
export async function latestMatch(tx: Tx, tenantId: string, docLineId: string) {
  const [row] = await tx
    .select()
    .from(itemMatch)
    .where(and(eq(itemMatch.tenantId, tenantId), eq(itemMatch.docLineId, docLineId)))
    .orderBy(desc(itemMatch.decidedAt), desc(itemMatch.id))
    .limit(1);
  return row ?? null;
}

export interface SearchInput {
  query?: string | undefined;
  category?: Category | undefined;
  limit?: number | undefined;
}

/** Live catalog items, closest names first when there is a query. */
export async function searchCatalog(tx: Tx, tenantId: string, input: SearchInput) {
  const filters = [eq(catalogItem.tenantId, tenantId), isNull(catalogItem.mergedIntoId)];
  if (input.category) filters.push(eq(catalogItem.category, input.category));
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  if (!input.query?.trim()) {
    return tx
      .select()
      .from(catalogItem)
      .where(and(...filters))
      .orderBy(catalogItem.canonicalName)
      .limit(limit);
  }
  const q = input.query.trim();
  const score = sql<number>`greatest(similarity(${catalogItem.canonicalName}, ${q}), word_similarity(${q}, ${catalogItem.canonicalName}))`;
  return tx
    .select()
    .from(catalogItem)
    .where(
      and(
        ...filters,
        sql`(${catalogItem.canonicalName} % ${q} or ${q} <% ${catalogItem.canonicalName} or ${catalogItem.canonicalName} ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`})`,
      ),
    )
    .orderBy(desc(score), catalogItem.canonicalName)
    .limit(limit);
}

export function itemView(item: CatalogItemRow) {
  return {
    id: item.id,
    category: item.category,
    name: item.canonicalName,
    attributes: item.attributes as Attributes,
    standardUom: item.standardUom,
  };
}
