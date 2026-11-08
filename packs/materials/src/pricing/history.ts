// Reading prices back: one item's history (`materials.prices.history`), what each vendor charges
// for it (`materials.prices.compare_vendors`), and the week's digest (`materials.weekly-digest`):
// changes, creep, vendor spread, new fees and their dollar impact. Reads only.

import { dec, formatAmount, toNumeric } from "@countersign/core";
import { alert, type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { PACK_ID } from "../ids";
import { catalogItem, priceObservation } from "../schema";
import { daysBefore } from "./rules";

export async function priceHistory(
  tx: Tx,
  tenantId: string,
  input: {
    catalogItemId: string;
    vendorId?: string | undefined;
    days?: number | undefined;
    today: string;
  },
) {
  const since = daysBefore(input.today, input.days ?? 180);
  const filters = [
    eq(priceObservation.tenantId, tenantId),
    eq(priceObservation.catalogItemId, input.catalogItemId),
    gte(priceObservation.observedOn, since),
  ];
  if (input.vendorId) filters.push(eq(priceObservation.vendorId, input.vendorId));
  const rows = await tx
    .select({ o: priceObservation, vendorName: vendor.name })
    .from(priceObservation)
    .innerJoin(vendor, eq(vendor.id, priceObservation.vendorId))
    .where(and(...filters))
    .orderBy(asc(priceObservation.observedOn), asc(priceObservation.createdAt))
    .limit(1000);
  return rows.map(({ o, vendorName }) => ({
    id: o.id,
    vendorId: o.vendorId,
    vendorName,
    observedOn: o.observedOn,
    unitPriceStd: o.unitPriceStd,
    qtyStd: o.qtyStd,
    standardUom: o.standardUom,
    docLineId: o.docLineId,
  }));
}

export async function compareVendors(
  tx: Tx,
  tenantId: string,
  input: { catalogItemId: string; days?: number | undefined; today: string },
) {
  const history = await priceHistory(tx, tenantId, { ...input, days: input.days ?? 90 });
  const byVendor = new Map<string, typeof history>();
  for (const o of history) byVendor.set(o.vendorId, [...(byVendor.get(o.vendorId) ?? []), o]);
  const vendors = [...byVendor.values()].map((obs) => {
    const last = obs.at(-1) as (typeof history)[number];
    const avg = obs.reduce((s, o) => s.plus(o.unitPriceStd), dec("0")).dividedBy(obs.length);
    return {
      vendorId: last.vendorId,
      vendorName: last.vendorName,
      lastPrice: last.unitPriceStd,
      lastOn: last.observedOn,
      averagePrice: toNumeric(avg),
      purchases: obs.length,
      qtyStd: toNumeric(obs.reduce((s, o) => s.plus(o.qtyStd), dec("0"))),
      standardUom: last.standardUom,
    };
  });
  vendors.sort((a, b) => dec(a.lastPrice).comparedTo(dec(b.lastPrice)));
  return { vendors, cheapest: vendors[0]?.vendorId ?? null, sources: history.map((o) => o.id) };
}

/** Last price against the one before, per item and vendor, for prices seen in the period. */
export async function weeklyDigest(
  tx: Tx,
  tenantId: string,
  input: { days?: number | undefined; today: string },
) {
  const days = input.days ?? 7;
  const start = daysBefore(input.today, days - 1);
  const recent = await tx
    .select()
    .from(priceObservation)
    .where(
      and(
        eq(priceObservation.tenantId, tenantId),
        gte(priceObservation.observedOn, start),
        lte(priceObservation.observedOn, input.today),
      ),
    )
    .orderBy(desc(priceObservation.observedOn));
  const itemIds = [...new Set(recent.map((o) => o.catalogItemId))];
  const items =
    itemIds.length > 0
      ? await tx
          .select({ id: catalogItem.id, name: catalogItem.canonicalName })
          .from(catalogItem)
          .where(and(eq(catalogItem.tenantId, tenantId), inArray(catalogItem.id, itemIds)))
      : [];
  const vendors = await tx
    .select({ id: vendor.id, name: vendor.name })
    .from(vendor)
    .where(eq(vendor.tenantId, tenantId));
  const changes: {
    catalogItemId: string;
    item: string;
    vendorId: string;
    vendor: string;
    from: string;
    to: string;
    changePct: string;
  }[] = [];
  const pairs = new Set<string>();
  for (const o of recent) {
    const pair = `${o.catalogItemId}:${o.vendorId}`;
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    const [prev] = await tx
      .select()
      .from(priceObservation)
      .where(
        and(
          eq(priceObservation.tenantId, tenantId),
          eq(priceObservation.catalogItemId, o.catalogItemId),
          eq(priceObservation.vendorId, o.vendorId),
          lte(priceObservation.observedOn, daysBefore(start, 1)),
        ),
      )
      .orderBy(desc(priceObservation.observedOn))
      .limit(1);
    if (!prev || prev.standardUom !== o.standardUom || dec(prev.unitPriceStd).isZero()) continue;
    const c = dec(o.unitPriceStd).minus(prev.unitPriceStd).dividedBy(prev.unitPriceStd).times(100);
    if (c.isZero()) continue;
    changes.push({
      catalogItemId: o.catalogItemId,
      item: items.find((i) => i.id === o.catalogItemId)?.name ?? "An item",
      vendorId: o.vendorId,
      vendor: vendors.find((v) => v.id === o.vendorId)?.name ?? "a vendor",
      from: prev.unitPriceStd,
      to: o.unitPriceStd,
      changePct: c.toDecimalPlaces(1).toString(),
    });
  }
  changes.sort((a, b) => dec(b.changePct).abs().comparedTo(dec(a.changePct).abs()));
  const alerts = await tx
    .select()
    .from(alert)
    .where(
      and(
        eq(alert.tenantId, tenantId),
        eq(alert.pack, PACK_ID),
        gte(alert.createdAt, new Date(`${start}T00:00:00Z`)),
      ),
    )
    .orderBy(desc(alert.createdAt));
  const impact = alerts.reduce((s, a) => s.plus(a.dollarImpact ?? "0"), dec("0"));
  const ups = changes.filter((c) => dec(c.changePct).greaterThan(0)).length;
  const lines = [
    `${recent.length} prices recorded from ${start} to ${input.today}; ${ups} went up and ${changes.length - ups} went down.`,
    alerts.length > 0
      ? `${alerts.length} alerts, about $${formatAmount(impact)} at stake.`
      : "No new alerts.",
    ...changes
      .slice(0, 5)
      .map(
        (c) =>
          `${c.item} at ${c.vendor}: $${formatAmount(c.from)} to $${formatAmount(c.to)} (${dec(c.changePct).greaterThan(0) ? "+" : ""}${c.changePct}%).`,
      ),
    ...alerts.slice(0, 5).map((a) => a.title),
  ];
  return {
    periodStart: start,
    periodEnd: input.today,
    prices: recent.length,
    changes,
    alerts: alerts.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      dollarImpact: a.dollarImpact,
      status: a.status,
    })),
    dollarImpact: toNumeric(impact),
    message: lines.join("\n"),
    sources: [...recent.map((o) => o.id), ...alerts.map((a) => a.id)],
  };
}
