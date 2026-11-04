// `seed:demo-prices` (docs/plan.md M8): six months of prices for the demo client, about ten items
// from three vendors, so Price watch and Catalog have something to show before real invoices
// arrive. Adds the vendors and catalog items, a price every two weeks per item and vendor (with
// steady creep, one jump and one cheaper vendor), and the alerts the rules raise on each pair's
// latest price. Idempotent: a second run adds nothing.
// DECISION: it doesn't switch the pack on: the operator does that in the back office, which also
// installs the Pia template, as for any client.
//
// Demo data only: observations carry no document line (no invoice behind them), and the items
// and alerts no agent version. Never run it against a real client.

import { findOrCreateVendor } from "@countersign/connectors";
import { dec, toNumeric } from "@countersign/core";
import { alert, type Db, withTenant } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { canonicalName, keySignature, parseLine } from "./catalog/keys";
import { PACK_ID } from "./ids";
import { toObservation } from "./pricing/check";
import { checkObservation, daysBefore, dedupeKey, priceSettingsFrom } from "./pricing/rules";
import { catalogItem, priceObservation } from "./schema";

export const DEMO_VENDORS = ["Northline Panel Supply", "Keystone Lumber", "Cedar Ridge Supply"];

/** Description, base price per standard unit, qty per purchase, and which vendors sell it. */
const DEMO_ITEMS: [string, string, string, number[]][] = [
  ['3/4" BB/BB BALTIC BIRCH 5X5', "62.50", "40", [0, 1, 2]],
  ['1/2" BB/BB BALTIC BIRCH 5X5', "48.00", "25", [0, 1]],
  ['3/4" MAPLE PLY 4X8 PREFINISHED', "88.00", "30", [0, 2]],
  ['3/4" MDF 4X8', "38.50", "20", [0, 1, 2]],
  ['3/4" WHITE MELAMINE 4X8', "45.00", "36", [0, 2]],
  ['1/4" HARDBOARD 4X8 TEMPERED', "17.25", "15", [0]],
  ["4/4 RED OAK FAS ROUGH", "4.85", "300", [1, 2]],
  ["8/4 HARD MAPLE FAS ROUGH", "7.40", "150", [1]],
  ["BLUM 71B3550 HINGE", "4.10", "200", [1, 2]],
  ["TITEBOND III WOOD GLUE 1 GAL", "21.00", "6", [2]],
];

/** The same numbers every run: a small hash of the inputs. */
function wobble(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of parts.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

export interface DemoPricesResult {
  vendors: number;
  items: number;
  observations: number;
  alerts: number;
}

export async function seedDemoPrices(
  db: Db,
  tenantId: string,
  options: { today?: string } = {},
): Promise<DemoPricesResult> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  return withTenant(db, tenantId, async (tx) => {
    const vendors: { id: string; name: string }[] = [];
    for (const name of DEMO_VENDORS) {
      const v = await findOrCreateVendor(tx, tenantId, name);
      if (!v) throw new Error(`seed:demo-prices: vendor ${name} missing`);
      vendors.push(v);
    }
    let observations = 0;
    let itemCount = 0;
    let alerts = 0;
    for (const [index, [description, base, qty, sellers]] of DEMO_ITEMS.entries()) {
      const parsed = parseLine(description);
      const signature = keySignature(parsed.category, parsed.attributes);
      await tx
        .insert(catalogItem)
        .values({
          tenantId,
          category: parsed.category,
          canonicalName: canonicalName(parsed.category, parsed.attributes, parsed.normalized),
          attributes: parsed.attributes,
          standardUom: parsed.standardUom,
          keySignature: signature,
          ext: { parsedBy: parsed.parsedBy, firstDescription: parsed.normalized, demo: true },
        })
        .onConflictDoNothing();
      const [item] = await tx
        .select()
        .from(catalogItem)
        .where(
          and(
            eq(catalogItem.tenantId, tenantId),
            signature
              ? eq(catalogItem.keySignature, signature)
              : eq(catalogItem.canonicalName, description),
            isNull(catalogItem.mergedIntoId),
          ),
        )
        .limit(1);
      if (!item) throw new Error(`seed:demo-prices: item ${description} missing`);
      itemCount++;
      const existing = await tx
        .select({ id: priceObservation.id })
        .from(priceObservation)
        .where(
          and(eq(priceObservation.tenantId, tenantId), eq(priceObservation.catalogItemId, item.id)),
        )
        .limit(1);
      if (existing.length > 0) continue;

      for (const s of sellers) {
        const v = vendors[s];
        if (!v) continue;
        // Vendor 2 is a little cheaper; prices creep about 0.4% every two weeks.
        let price = dec(base).times(s === 2 ? "0.93" : s === 1 ? "1.02" : "1");
        for (let week = 26; week >= 0; week -= 2) {
          const on = daysBefore(today, week * 7 + s);
          price = price.times(1 + 0.004 + (wobble(description, s, week) - 0.5) * 0.006);
          // The first item's main vendor jumps 9% on the latest invoice: Price watch's alert.
          const unit = index === 0 && s === 0 && week === 0 ? price.times("1.09") : price;
          await tx.insert(priceObservation).values({
            tenantId,
            catalogItemId: item.id,
            vendorId: v.id,
            observedOn: on,
            unitPriceStd: toNumeric(unit.toDecimalPlaces(2)),
            qtyStd: toNumeric(
              dec(qty)
                .times(0.8 + wobble(qty, s, week) * 0.4)
                .round(),
            ),
            standardUom: item.standardUom,
            ext: { demo: true },
          });
          observations++;
        }
      }
      // What the rules say about each vendor's latest price.
      const history = (
        await tx
          .select()
          .from(priceObservation)
          .where(
            and(
              eq(priceObservation.tenantId, tenantId),
              eq(priceObservation.catalogItemId, item.id),
            ),
          )
      ).map(toObservation);
      for (const v of vendors) {
        const mine = history
          .filter((o) => o.vendorId === v.id)
          .sort((a, b) => a.observedOn.localeCompare(b.observedOn));
        const latest = mine.at(-1);
        if (!latest) continue;
        const drafts = checkObservation(latest, history, priceSettingsFrom({}), {
          item: item.canonicalName,
          vendor: (id) => vendors.find((x) => x.id === id)?.name ?? "another vendor",
        });
        for (const d of drafts) {
          const [row] = await tx
            .insert(alert)
            .values({
              tenantId,
              pack: PACK_ID,
              kind: d.kind,
              subjectType: "catalog_item",
              subjectId: item.id,
              severity: d.severity,
              title: d.title,
              body: d.body,
              evidence: d.evidence,
              facts: {
                ...d.facts,
                vendorId: d.vendorId,
                catalogItemId: d.catalogItemId,
                demo: true,
              },
              dollarImpact: d.dollarImpact,
              dedupeKey: dedupeKey(d),
            })
            .onConflictDoNothing()
            .returning({ id: alert.id });
          if (row) alerts++;
        }
      }
    }
    return { vendors: vendors.length, items: itemCount, observations, alerts };
  });
}
