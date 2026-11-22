// What the client bought before, for purchasing (docs/plan.md §1.67): which vendors sold an item
// (`materials.vendors-for-items`) and what the client buys most (`materials.frequent-items`).
// From price observations (what was paid, in the item's standard unit), item aliases (a vendor
// that has a name for the item sold it, even before a price was recorded) and the vendor catalog
// (a vendor with an active item for it sells it; the client's preferred one first, §1.189). Reads
// only, one client.

import { dec, toNumeric } from "@countersign/core";
import { type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { liveItem } from "../catalog/store";
import { fromLatestReading } from "../pricing/record";
import { daysBefore } from "../pricing/rules";
import { type Category, catalogItem, itemAlias, priceObservation, vendorItem } from "../schema";

export interface VendorForItem {
  vendorId: string;
  vendorName: string;
  /** The last price paid, per standard unit; null when only an alias says the vendor sells it. */
  lastPrice: string | null;
  lastOn: string | null;
  timesBought: number;
  qtyStd: string;
  currency: string | null;
  /** §1.189: the client's preferred vendor for the item (its vendor item marked preferred). */
  preferred: boolean;
  /** Observation, alias and vendor item ids behind this row (invariant 10). */
  sources: string[];
}

export interface ItemVendors {
  catalogItemId: string;
  /** The id asked for, when it was merged into `catalogItemId`. */
  askedId: string;
  name: string;
  standardUom: string;
  vendors: VendorForItem[];
}

/**
 * For each item, the vendors that sold it, the client's preferred vendor first, then cheapest
 * last price first (vendors known only by an alias or the vendor catalog last). DECISION: over
 * the last `days` (default 365) of prices; aliases and vendor items have no date.
 */
// DECISION (§1.189): the preferred vendor leads the list whatever its price, so it is always
// among the vendors asked; which vendor is ordered from stays the comparison's (cheapest first,
// the preferred one on a tie) and a person's.
export async function vendorsForItems(
  tx: Tx,
  tenantId: string,
  input: { catalogItemIds: readonly string[]; days?: number | undefined; today: string },
): Promise<{ items: ItemVendors[]; missing: string[] }> {
  const since = daysBefore(input.today, input.days ?? 365);
  const items: ItemVendors[] = [];
  const missing: string[] = [];
  const names = new Map(
    (
      await tx
        .select({ id: vendor.id, name: vendor.name })
        .from(vendor)
        .where(eq(vendor.tenantId, tenantId))
    ).map((v) => [v.id, v.name]),
  );
  for (const askedId of new Set(input.catalogItemIds)) {
    const item = await liveItem(tx, tenantId, askedId);
    if (!item) {
      missing.push(askedId);
      continue;
    }
    const observations = await tx
      .select()
      .from(priceObservation)
      .where(
        and(
          eq(priceObservation.tenantId, tenantId),
          eq(priceObservation.catalogItemId, item.id),
          // Invariant 7: only prices in the item's own unit.
          eq(priceObservation.standardUom, item.standardUom),
          gte(priceObservation.observedOn, since),
          lte(priceObservation.observedOn, input.today),
          // A document read again counts once: its latest reading's prices only.
          fromLatestReading(),
        ),
      )
      .orderBy(desc(priceObservation.observedOn), desc(priceObservation.createdAt))
      .limit(2000);
    const aliases = await tx
      .select({ id: itemAlias.id, vendorId: itemAlias.vendorId })
      .from(itemAlias)
      .where(and(eq(itemAlias.tenantId, tenantId), eq(itemAlias.catalogItemId, item.id)));
    const listed = await tx
      .select({ id: vendorItem.id, vendorId: vendorItem.vendorId, preferred: vendorItem.preferred })
      .from(vendorItem)
      .where(
        and(
          eq(vendorItem.tenantId, tenantId),
          eq(vendorItem.catalogItemId, item.id),
          eq(vendorItem.status, "active"),
        ),
      )
      .orderBy(desc(vendorItem.preferred), asc(vendorItem.createdAt));
    const preferredVendor = listed.find((v) => v.preferred)?.vendorId ?? null;
    // DECISION (review of fix/materials, finding 6): a vendor's row is per currency (a price in
    // one is never compared with one in another, nor added to its quantity), and a price whose
    // unit was assumed (a line with no unit, a QuickBooks bill line) counts as a purchase but not
    // as a price or a quantity.
    const byVendor = new Map<string, VendorForItem>();
    for (const o of observations.filter((x) => x.ext?.uomAssumed !== true)) {
      const key = `${o.vendorId}|${o.currency}`;
      const row = byVendor.get(key);
      if (!row) {
        byVendor.set(key, {
          vendorId: o.vendorId,
          vendorName: names.get(o.vendorId) ?? "A vendor",
          lastPrice: o.unitPriceStd,
          lastOn: o.observedOn,
          timesBought: 1,
          qtyStd: toNumeric(o.qtyStd),
          currency: o.currency,
          preferred: o.vendorId === preferredVendor,
          sources: [o.id],
        });
      } else {
        row.timesBought += 1;
        row.qtyStd = toNumeric(dec(row.qtyStd).plus(o.qtyStd));
        row.sources.push(o.id);
      }
    }
    const rowsOf = (vendorId: string) =>
      [...byVendor.values()].filter((r) => r.vendorId === vendorId);
    for (const o of observations.filter((x) => x.ext?.uomAssumed === true)) {
      const row = rowsOf(o.vendorId)[0];
      if (row) {
        row.timesBought += 1;
        row.sources.push(o.id);
      } else {
        byVendor.set(`${o.vendorId}|assumed`, {
          vendorId: o.vendorId,
          vendorName: names.get(o.vendorId) ?? "A vendor",
          lastPrice: null,
          lastOn: o.observedOn,
          timesBought: 1,
          qtyStd: toNumeric("0"),
          currency: null,
          preferred: o.vendorId === preferredVendor,
          sources: [o.id],
        });
      }
    }
    for (const a of aliases) {
      const row = rowsOf(a.vendorId)[0];
      if (row) row.sources.push(a.id);
      else {
        byVendor.set(`${a.vendorId}|alias`, {
          vendorId: a.vendorId,
          vendorName: names.get(a.vendorId) ?? "A vendor",
          lastPrice: null,
          lastOn: null,
          timesBought: 0,
          qtyStd: toNumeric("0"),
          currency: null,
          preferred: a.vendorId === preferredVendor,
          sources: [a.id],
        });
      }
    }
    for (const v of listed) {
      const row = rowsOf(v.vendorId)[0];
      if (row) row.sources.push(v.id);
      else {
        byVendor.set(`${v.vendorId}|catalog`, {
          vendorId: v.vendorId,
          vendorName: names.get(v.vendorId) ?? "A vendor",
          lastPrice: null,
          lastOn: null,
          timesBought: 0,
          qtyStd: toNumeric("0"),
          currency: null,
          preferred: v.vendorId === preferredVendor,
          sources: [v.id],
        });
      }
    }
    // Cheapest first within the currency most vendors are priced in, then the other currencies.
    const perCurrency = new Map<string, number>();
    for (const r of byVendor.values()) {
      if (r.currency) perCurrency.set(r.currency, (perCurrency.get(r.currency) ?? 0) + 1);
    }
    const order = [...perCurrency.entries()]
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          Number(b[0] === "USD") - Number(a[0] === "USD") ||
          a[0].localeCompare(b[0]),
      )
      .map(([c]) => c);
    const vendors = [...byVendor.values()].sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      const ca = a.currency === null ? order.length : order.indexOf(a.currency);
      const cb = b.currency === null ? order.length : order.indexOf(b.currency);
      if (ca !== cb) return ca - cb;
      if (a.lastPrice === null || b.lastPrice === null) {
        return a.lastPrice === b.lastPrice
          ? a.vendorName.localeCompare(b.vendorName)
          : a.lastPrice === null
            ? 1
            : -1;
      }
      return (
        dec(a.lastPrice).comparedTo(dec(b.lastPrice)) ||
        b.timesBought - a.timesBought ||
        a.vendorName.localeCompare(b.vendorName)
      );
    });
    items.push({
      catalogItemId: item.id,
      askedId,
      name: item.canonicalName,
      standardUom: item.standardUom,
      vendors,
    });
  }
  return { items, missing };
}

export interface FrequentItem {
  catalogItemId: string;
  name: string;
  category: Category;
  standardUom: string;
  purchases: number;
  qtyStd: string;
  /** What was paid in the period: Σ unit price × quantity, in standard units. */
  spend: string;
  currency: string;
  lastOn: string;
  lastVendorId: string;
  lastVendorName: string;
  lastPrice: string;
  /** The newest observation ids, at most 20 (invariant 10). */
  sources: string[];
}

// DECISION: what the client buys most is counted in purchases (price observations, one per
// invoice or bill line), then spend; at most 5000 observations a period are read.
const FREQUENT_SCAN_LIMIT = 5000;
const SOURCES_PER_ITEM = 20;

export async function frequentItems(
  tx: Tx,
  tenantId: string,
  input: {
    from: string;
    to: string;
    limit?: number | undefined;
    category?: Category | undefined;
  },
): Promise<FrequentItem[]> {
  const filters = [
    eq(priceObservation.tenantId, tenantId),
    gte(priceObservation.observedOn, input.from),
    lte(priceObservation.observedOn, input.to),
    eq(priceObservation.standardUom, catalogItem.standardUom),
    isNull(catalogItem.mergedIntoId),
    fromLatestReading(),
  ];
  if (input.category) filters.push(eq(catalogItem.category, input.category));
  const rows = await tx
    .select({ o: priceObservation, item: catalogItem, vendorName: vendor.name })
    .from(priceObservation)
    .innerJoin(
      catalogItem,
      and(
        eq(catalogItem.id, priceObservation.catalogItemId),
        eq(catalogItem.tenantId, priceObservation.tenantId),
      ),
    )
    .innerJoin(vendor, eq(vendor.id, priceObservation.vendorId))
    .where(and(...filters))
    .orderBy(
      desc(priceObservation.observedOn),
      desc(priceObservation.createdAt),
      asc(priceObservation.id),
    )
    .limit(FREQUENT_SCAN_LIMIT);
  const byItem = new Map<string, FrequentItem>();
  for (const { o, item, vendorName } of rows) {
    const spend = dec(o.unitPriceStd).times(o.qtyStd);
    const row = byItem.get(item.id);
    if (!row) {
      byItem.set(item.id, {
        catalogItemId: item.id,
        name: item.canonicalName,
        category: item.category,
        standardUom: item.standardUom,
        purchases: 1,
        qtyStd: toNumeric(o.qtyStd),
        spend: toNumeric(spend),
        currency: o.currency,
        lastOn: o.observedOn,
        lastVendorId: o.vendorId,
        lastVendorName: vendorName,
        lastPrice: o.unitPriceStd,
        sources: [o.id],
      });
      continue;
    }
    row.purchases += 1;
    row.qtyStd = toNumeric(dec(row.qtyStd).plus(o.qtyStd));
    // DECISION: spend adds only prices in the item's first-seen currency; others are left out
    // rather than added across currencies.
    if (o.currency === row.currency) row.spend = toNumeric(dec(row.spend).plus(spend));
    if (row.sources.length < SOURCES_PER_ITEM) row.sources.push(o.id);
  }
  return [...byItem.values()]
    .sort(
      (a, b) =>
        b.purchases - a.purchases ||
        dec(b.spend).comparedTo(dec(a.spend)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.min(Math.max(input.limit ?? 20, 1), 100));
}
