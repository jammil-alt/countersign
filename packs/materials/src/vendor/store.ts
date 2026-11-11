// The vendor catalog's reads and writes (docs/plan.md §1.88), each inside the caller's
// client-scoped transaction (withTenant: RLS shows one client's rows, invariant 1); queries also
// filter by tenant_id. Nothing here calls a model: embeddings are made between transactions
// (./tools.ts) and only their vectors reach these queries.

import { dec, toNumeric } from "@countersign/core";
import { type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { liveItem } from "../catalog/store";
import {
  type Category,
  catalogItem,
  itemAlias,
  type VendorPriceSource,
  vendorItem,
} from "../schema";

export type VendorItemRow = typeof vendorItem.$inferSelect;

/** A vendor's SKU as matching reads it: trimmed, upper case; null when empty or too long. */
export function cleanSku(raw: string | null | undefined): string | null {
  const s = raw?.trim().toUpperCase() ?? "";
  return s.length > 0 && s.length <= 100 ? s : null;
}

/** A vector as pgvector reads it (`[0.1,0.2,…]`). */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

export async function vendorItemById(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<VendorItemRow | null> {
  const [row] = await tx
    .select()
    .from(vendorItem)
    .where(and(eq(vendorItem.id, id), eq(vendorItem.tenantId, tenantId)))
    .limit(1);
  return row ?? null;
}

/** The vendor's item with this SKU (discontinued ones too: the vendor still invoiced it). */
export async function vendorItemBySku(
  tx: Tx,
  tenantId: string,
  vendorId: string,
  sku: string,
): Promise<VendorItemRow | null> {
  const [row] = await tx
    .select()
    .from(vendorItem)
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        eq(vendorItem.vendorId, vendorId),
        eq(vendorItem.sku, sku),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The vendor's items for one master item, active first, newest price first. */
export async function vendorItemsFor(
  tx: Tx,
  tenantId: string,
  vendorId: string,
  catalogItemId: string,
): Promise<VendorItemRow[]> {
  return tx
    .select()
    .from(vendorItem)
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        eq(vendorItem.vendorId, vendorId),
        eq(vendorItem.catalogItemId, catalogItemId),
      ),
    )
    .orderBy(
      sql`${vendorItem.status} = 'active' desc`,
      desc(vendorItem.lastPriceOn),
      asc(vendorItem.createdAt),
    );
}

export interface AliasHit {
  /** The vendor item the alias names; null for an alias kept before the vendor catalog (0047). */
  item: VendorItemRow | null;
  /** The master item, live (a merge followed). */
  catalogItemId: string;
  via: "sku" | "description";
  aliasSource: "auto" | "human";
}

/**
 * What a vendor's wording (or an older SKU alias) names: its vendor item when the alias says so,
 * else the vendor's only item for the alias's master item. An alias the previous Worker wrote has
 * no vendor item (0047); it still gives the master item.
 */
export async function vendorAlias(
  tx: Tx,
  tenantId: string,
  key: { vendorId: string; sku: string | null; descriptionHash: string },
): Promise<AliasHit | null> {
  const lookups: { via: "sku" | "description"; sku: string; hash: string }[] = [];
  if (key.sku) lookups.push({ via: "sku", sku: key.sku, hash: "" });
  lookups.push({ via: "description", sku: "", hash: key.descriptionHash });
  for (const l of lookups) {
    // The same expressions as the unique index (0032), so the lookup uses it.
    const [hit] = await tx
      .select({
        catalogItemId: itemAlias.catalogItemId,
        vendorItemId: itemAlias.vendorItemId,
        source: itemAlias.source,
      })
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
    const live = await liveItem(tx, tenantId, hit.catalogItemId);
    if (!live) continue;
    let item = hit.vendorItemId ? await vendorItemById(tx, tenantId, hit.vendorItemId) : null;
    if (!item) {
      const pair = await vendorItemsFor(tx, tenantId, key.vendorId, live.id);
      item = pair.length === 1 ? (pair[0] ?? null) : null;
    }
    return { item, catalogItemId: live.id, via: l.via, aliasSource: hit.source };
  }
  return null;
}

/**
 * The vendor item a decided line is: its SKU's, else the one the semantic match named, else the
 * vendor's item for that master item in the line's unit, else its only one. Null: a new one.
 */
// DECISION: a vendor item without a SKU is (vendor, master item, unit); a line in another unit
// than the vendor's items for that master item is another vendor item (a box, not each).
export async function resolveVendorItem(
  tx: Tx,
  tenantId: string,
  key: {
    vendorId: string;
    catalogItemId: string;
    sku: string | null;
    vendorUom: string | null;
    hintId?: string | null | undefined;
  },
): Promise<VendorItemRow | null> {
  if (key.sku) {
    const bySku = await vendorItemBySku(tx, tenantId, key.vendorId, key.sku);
    if (bySku) return bySku;
  }
  if (key.hintId) {
    const hinted = await vendorItemById(tx, tenantId, key.hintId);
    if (
      hinted &&
      hinted.vendorId === key.vendorId &&
      hinted.catalogItemId === key.catalogItemId &&
      (!key.sku || !hinted.sku)
    ) {
      return hinted;
    }
  }
  const pair = (await vendorItemsFor(tx, tenantId, key.vendorId, key.catalogItemId)).filter(
    // A line with a SKU never takes another SKU's item.
    (v) => !key.sku || !v.sku,
  );
  const sameUnit = pair.filter((v) => (v.vendorUom ?? "") === (key.vendorUom ?? ""));
  if (sameUnit.length > 0) return sameUnit[0] ?? null;
  if (pair.length === 1 && !key.vendorUom) return pair[0] ?? null;
  return null;
}

export interface VendorItemFields {
  vendorId: string;
  catalogItemId: string;
  sku?: string | null | undefined;
  name: string;
  description?: string | null | undefined;
  packSize?: string | null | undefined;
  vendorUom?: string | null | undefined;
  stdPerVendorUom?: string | null | undefined;
  minOrderQty?: string | null | undefined;
  leadTimeDays?: number | null | undefined;
  listPrice?: string | null | undefined;
  listPriceOn?: string | null | undefined;
  currency?: string | undefined;
}

export type VendorItemCreator = { agentVersionId: string } | { userId: string };

/**
 * Creates a vendor item, or answers the one already there (the same SKU, or the same master
 * item and unit without one): two runs registering the same item end with one row.
 */
export async function createVendorItem(
  tx: Tx,
  tenantId: string,
  f: VendorItemFields,
  by: VendorItemCreator,
): Promise<{ item: VendorItemRow; created: boolean }> {
  const sku = cleanSku(f.sku);
  const [row] = await tx
    .insert(vendorItem)
    .values({
      tenantId,
      vendorId: f.vendorId,
      catalogItemId: f.catalogItemId,
      sku,
      name: f.name.slice(0, 500),
      description: f.description ?? null,
      packSize: f.packSize ?? null,
      vendorUom: f.vendorUom ?? null,
      stdPerVendorUom: f.stdPerVendorUom ?? null,
      minOrderQty: f.minOrderQty ?? null,
      leadTimeDays: f.leadTimeDays ?? null,
      listPrice: f.listPrice ?? null,
      listPriceOn: f.listPrice ? (f.listPriceOn ?? null) : null,
      currency: f.currency ?? "USD",
      ...("agentVersionId" in by
        ? { createdByAgentVersionId: by.agentVersionId || null }
        : { createdByUserId: by.userId }),
    })
    .onConflictDoNothing()
    .returning();
  if (row) return { item: row, created: true };
  const existing = sku
    ? await vendorItemBySku(tx, tenantId, f.vendorId, sku)
    : ((
        await tx
          .select()
          .from(vendorItem)
          .where(
            and(
              eq(vendorItem.tenantId, tenantId),
              eq(vendorItem.vendorId, f.vendorId),
              eq(vendorItem.catalogItemId, f.catalogItemId),
              isNull(vendorItem.sku),
              sql`coalesce(${vendorItem.vendorUom}, '') = ${f.vendorUom ?? ""}`,
            ),
          )
          .limit(1)
      )[0] ?? null);
  if (!existing) throw new Error("vendor item insert returned nothing");
  return { item: existing, created: false };
}

/** Changes the fields given (undefined leaves one as it is); the master item only on purpose. */
export async function updateVendorItem(
  tx: Tx,
  tenantId: string,
  id: string,
  f: { [K in keyof Omit<VendorItemFields, "vendorId">]?: VendorItemFields[K] | undefined },
): Promise<VendorItemRow> {
  const set: Omit<Partial<typeof vendorItem.$inferInsert>, "ext"> & { ext?: SQL } = {
    updatedAt: new Date(),
  };
  if (f.catalogItemId !== undefined) set.catalogItemId = f.catalogItemId;
  if (f.sku !== undefined) set.sku = cleanSku(f.sku);
  if (f.name !== undefined) set.name = f.name.slice(0, 500);
  if (f.description !== undefined) set.description = f.description;
  if (f.packSize !== undefined) set.packSize = f.packSize;
  if (f.vendorUom !== undefined) set.vendorUom = f.vendorUom;
  if (f.stdPerVendorUom !== undefined) set.stdPerVendorUom = f.stdPerVendorUom;
  if (f.minOrderQty !== undefined) set.minOrderQty = f.minOrderQty;
  if (f.leadTimeDays !== undefined) set.leadTimeDays = f.leadTimeDays;
  if (f.listPrice !== undefined) {
    set.listPrice = f.listPrice;
    set.listPriceOn = f.listPrice === null ? null : (f.listPriceOn ?? null);
  }
  if (f.currency !== undefined) set.currency = f.currency;
  // What the vendor item is embedded from changed: forget the text it was embedded from, so the
  // embedding write makes it again (the old vector serves the searches until then).
  const changes = [
    set.name !== undefined ? sql`${vendorItem.name} is distinct from ${set.name}` : null,
    set.description !== undefined
      ? sql`${vendorItem.description} is distinct from ${set.description}`
      : null,
    set.catalogItemId !== undefined
      ? sql`${vendorItem.catalogItemId} is distinct from ${set.catalogItemId}`
      : null,
  ].filter((c) => c !== null);
  if (changes.length > 0) {
    set.ext = sql`case when ${sql.join(changes, sql` or `)} then ${vendorItem.ext} - 'embedding' else ${vendorItem.ext} end`;
  }
  const [row] = await tx
    .update(vendorItem)
    .set(set)
    .where(and(eq(vendorItem.id, id), eq(vendorItem.tenantId, tenantId)))
    .returning();
  if (!row) throw new VendorItemError("not_found", `vendor item ${id} not found`);
  return row;
}

export class VendorItemError extends Error {
  override name = "VendorItemError";
  constructor(
    readonly code: "not_found" | "discontinued" | "conflict" | "bad_input",
    message: string,
  ) {
    super(message);
  }
}

export interface LastPrice {
  /** In the vendor's unit. */
  price: string;
  /** Per standard unit; null without a conversion (invariant 7). */
  priceStd: string | null;
  on: string;
  source: VendorPriceSource;
  sourceId: string | null;
  currency: string;
}

/**
 * Sets the vendor item's last price unless it already has a newer one: the newest date wins, so
 * an older document never overwrites a newer price (on the same date, the later record does).
 */
export async function recordLastPrice(
  tx: Tx,
  tenantId: string,
  vendorItemId: string,
  p: LastPrice,
): Promise<boolean> {
  const rows = await tx
    .update(vendorItem)
    .set({
      lastPrice: toNumeric(p.price),
      lastPriceStd: p.priceStd === null ? null : toNumeric(p.priceStd),
      lastPriceOn: p.on,
      lastPriceSource: p.source,
      lastPriceSourceId: p.sourceId,
      currency: p.currency,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vendorItem.id, vendorItemId),
        eq(vendorItem.tenantId, tenantId),
        sql`(${vendorItem.lastPriceOn} is null or ${vendorItem.lastPriceOn} <= ${p.on})`,
      ),
    )
    .returning({ id: vendorItem.id });
  return rows.length > 0;
}

/** Marks a vendor item the client's first choice for its master item; the others lose it. */
export async function setPreferred(
  tx: Tx,
  tenantId: string,
  id: string,
): Promise<{ item: VendorItemRow; cleared: string[] }> {
  const item = await vendorItemById(tx, tenantId, id);
  if (!item) throw new VendorItemError("not_found", `vendor item ${id} not found`);
  if (item.status !== "active") {
    throw new VendorItemError("discontinued", "a discontinued item can't be the preferred one");
  }
  const cleared = await tx
    .update(vendorItem)
    .set({ preferred: false, updatedAt: new Date() })
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        eq(vendorItem.catalogItemId, item.catalogItemId),
        eq(vendorItem.preferred, true),
        ne(vendorItem.id, id),
      ),
    )
    .returning({ id: vendorItem.id });
  const [row] = await tx
    .update(vendorItem)
    .set({ preferred: true, updatedAt: new Date() })
    .where(and(eq(vendorItem.id, id), eq(vendorItem.tenantId, tenantId)))
    .returning();
  if (!row) throw new VendorItemError("not_found", `vendor item ${id} not found`);
  return { item: row, cleared: cleared.map((r) => r.id) };
}

/** The vendor no longer sells it: discontinued, and no longer preferred. Nothing is deleted. */
export async function discontinue(tx: Tx, tenantId: string, id: string): Promise<VendorItemRow> {
  const [row] = await tx
    .update(vendorItem)
    .set({ status: "discontinued", preferred: false, updatedAt: new Date() })
    .where(and(eq(vendorItem.id, id), eq(vendorItem.tenantId, tenantId)))
    .returning();
  if (!row) throw new VendorItemError("not_found", `vendor item ${id} not found`);
  return row;
}

/** A vendor item as tools and screens show it. */
export function vendorItemView(
  v: VendorItemRow,
  master?: { name: string; standardUom: string; category: Category } | null,
) {
  return {
    id: v.id,
    vendorId: v.vendorId,
    catalogItemId: v.catalogItemId,
    catalogItemName: master?.name ?? null,
    category: master?.category ?? null,
    standardUom: master?.standardUom ?? null,
    sku: v.sku,
    name: v.name,
    description: v.description,
    packSize: v.packSize,
    vendorUom: v.vendorUom,
    stdPerVendorUom: v.stdPerVendorUom,
    minOrderQty: v.minOrderQty,
    leadTimeDays: v.leadTimeDays,
    listPrice: v.listPrice,
    listPriceOn: v.listPriceOn,
    lastPrice: v.lastPrice,
    lastPriceStd: v.lastPriceStd,
    lastPriceOn: v.lastPriceOn,
    lastPriceSource: v.lastPriceSource,
    lastPriceSourceId: v.lastPriceSourceId,
    currency: v.currency,
    preferred: v.preferred,
    status: v.status,
  };
}
export type VendorItemView = ReturnType<typeof vendorItemView>;

/** One vendor's catalog: every item it sells the client, by name; discontinued ones last. */
export async function vendorCatalog(
  tx: Tx,
  tenantId: string,
  vendorId: string,
  options: { includeDiscontinued?: boolean | undefined; limit?: number | undefined } = {},
): Promise<VendorItemView[]> {
  const rows = await tx
    .select({
      v: vendorItem,
      name: catalogItem.canonicalName,
      standardUom: catalogItem.standardUom,
      category: catalogItem.category,
    })
    .from(vendorItem)
    .innerJoin(
      catalogItem,
      and(
        eq(catalogItem.id, vendorItem.catalogItemId),
        eq(catalogItem.tenantId, vendorItem.tenantId),
      ),
    )
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        eq(vendorItem.vendorId, vendorId),
        options.includeDiscontinued ? undefined : eq(vendorItem.status, "active"),
      ),
    )
    .orderBy(sql`${vendorItem.status} = 'active' desc`, asc(vendorItem.name), asc(vendorItem.id))
    .limit(Math.min(Math.max(options.limit ?? 500, 1), 2000));
  return rows.map((r) => vendorItemView(r.v, r));
}

/**
 * Every vendor's version of a master item, side by side in its standard unit: the preferred one
 * first, then the cheapest per standard unit; a price with no conversion sorts last, never compared
 * (invariant 7).
 */
export async function vendorsForItem(
  tx: Tx,
  tenantId: string,
  catalogItemId: string,
  options: { includeDiscontinued?: boolean | undefined } = {},
) {
  const master = await liveItem(tx, tenantId, catalogItemId);
  if (!master) throw new VendorItemError("not_found", `catalog item ${catalogItemId} not found`);
  const rows = await tx
    .select({ v: vendorItem, vendorName: vendor.name })
    .from(vendorItem)
    .innerJoin(
      vendor,
      and(eq(vendor.id, vendorItem.vendorId), eq(vendor.tenantId, vendorItem.tenantId)),
    )
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        eq(vendorItem.catalogItemId, master.id),
        options.includeDiscontinued ? undefined : eq(vendorItem.status, "active"),
      ),
    );
  const view = (r: (typeof rows)[number]) => ({
    ...vendorItemView(r.v, {
      name: master.canonicalName,
      standardUom: master.standardUom,
      category: master.category,
    }),
    vendorName: r.vendorName,
  });
  const out = rows.map(view);
  out.sort((a, b) => {
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    if (a.lastPriceStd === null || b.lastPriceStd === null) {
      return a.lastPriceStd === null ? (b.lastPriceStd === null ? 0 : 1) : -1;
    }
    return dec(a.lastPriceStd).cmp(dec(b.lastPriceStd)) || a.vendorName.localeCompare(b.vendorName);
  });
  return {
    item: {
      id: master.id,
      name: master.canonicalName,
      category: master.category,
      standardUom: master.standardUom,
      attributes: master.attributes as Record<string, string>,
    },
    vendors: out,
  };
}

export interface SimilarVendorItem {
  item: VendorItemRow;
  /** Cosine similarity (1 is the same direction), when found by its embedding. */
  similarity: number | null;
  /** Trigram similarity of names, when found by name. */
  nameSimilarity: number | null;
}

/**
 * This vendor's active items closest to a line: by embedding (exact cosine distance over the
 * vendor's rows, which the btree index narrows), then by name (trigrams) as a backstop for items
 * not embedded yet. Never another vendor's, never another client's.
 */
// DECISION: no approximate (HNSW) index: a search is filtered by client and vendor (or client and
// category), and an approximate index orders every client's rows first and filters after, which
// can return fewer than asked (pgvector before 0.8 has no iterative scans). An exact scan over one
// vendor's items is small; an index is for when a client's catalog passes tens of thousands.
export async function similarVendorItems(
  tx: Tx,
  tenantId: string,
  vendorId: string,
  query: { vector: readonly number[] | null; text: string },
  limit = 5,
): Promise<SimilarVendorItem[]> {
  const scope = and(
    eq(vendorItem.tenantId, tenantId),
    eq(vendorItem.vendorId, vendorId),
    eq(vendorItem.status, "active"),
  );
  const out: SimilarVendorItem[] = [];
  const seen = new Set<string>();
  if (query.vector) {
    const distance = sql<number>`(${vendorItem.embedding} <=> ${vectorLiteral(query.vector)}::vector)`;
    const rows = await tx
      .select({ item: vendorItem, distance })
      .from(vendorItem)
      .where(and(scope, isNotNull(vendorItem.embedding)))
      .orderBy(distance, asc(vendorItem.id))
      .limit(limit);
    for (const r of rows) {
      seen.add(r.item.id);
      out.push({ item: r.item, similarity: 1 - Number(r.distance), nameSimilarity: null });
    }
  }
  if (query.text.trim()) {
    const sim = sql<number>`similarity(lower(${vendorItem.name}), ${query.text})`;
    const rows = await tx
      .select({ item: vendorItem, sim })
      .from(vendorItem)
      .where(and(scope, sql`lower(${vendorItem.name}) % ${query.text}`))
      .orderBy(desc(sim), asc(vendorItem.id))
      .limit(limit);
    for (const r of rows) {
      if (seen.has(r.item.id)) continue;
      seen.add(r.item.id);
      out.push({ item: r.item, similarity: null, nameSimilarity: Number(r.sim) });
    }
  }
  return out;
}

/** The client's live master items closest to a line's embedding, in its category when given. */
export async function similarMasterItems(
  tx: Tx,
  tenantId: string,
  vector: readonly number[],
  options: { category?: Category | undefined; limit?: number } = {},
) {
  const distance = sql<number>`(${catalogItem.embedding} <=> ${vectorLiteral(vector)}::vector)`;
  const rows = await tx
    .select({ item: catalogItem, distance })
    .from(catalogItem)
    .where(
      and(
        eq(catalogItem.tenantId, tenantId),
        isNull(catalogItem.mergedIntoId),
        isNotNull(catalogItem.embedding),
        options.category ? eq(catalogItem.category, options.category) : undefined,
      ),
    )
    .orderBy(distance, asc(catalogItem.id))
    .limit(options.limit ?? 5);
  return rows.map((r) => ({ item: r.item, similarity: 1 - Number(r.distance) }));
}
