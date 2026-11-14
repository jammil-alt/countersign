// Merging two catalog items (a person's decision, from the back office): the duplicate is marked
// `merged_into_id`, never deleted (no DELETE grant), and its aliases and price history follow
// the item it was merged into. Past matching decisions keep the id they named; readers resolve it
// through `merged_into_id` (store.ts liveItem). One transaction, one client.

import { type Db, withTenant } from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { catalogItem, itemAlias, priceObservation } from "../schema";
import { moveVendorItemsOnMerge } from "../vendor/store";
import { compareKeys } from "./keys";
import { MatchError } from "./match";
import { liveItem } from "./store";

export interface MergeInput {
  tenantId: string;
  /** The duplicate. */
  fromId: string;
  /** The item that stays. */
  intoId: string;
  userId: string;
}

export interface MergeResult {
  intoId: string;
  merged: string[];
  aliasesMoved: number;
  pricesMoved: number;
  /** §1.88: vendor items moved to the item that stays (or folded into its own). */
  vendorItemsMoved: number;
  /** Key attributes the two items stated differently (a person may still merge them). */
  differingKeys: string[];
}

export async function mergeItems(db: Db, input: MergeInput): Promise<MergeResult> {
  return withTenant(db, input.tenantId, async (tx) => {
    const from = await liveItem(tx, input.tenantId, input.fromId);
    const into = await liveItem(tx, input.tenantId, input.intoId);
    if (!from || !into) throw new MatchError("not_found", "catalog item not found");
    if (from.id === into.id)
      throw new MatchError("same_item", "an item can't be merged into itself");
    if (from.category !== into.category) {
      throw new MatchError("different_category", "items in different categories can't be merged");
    }
    // Invariant 7: prices in different units are never compared, so never pooled by a merge.
    if (from.standardUom !== into.standardUom) {
      throw new MatchError("different_uom", "items priced in different units can't be merged");
    }
    // DECISION: a person may merge items whose key attributes differ (a parser misread one); the
    // differences are answered and recorded on the merged item, never silently dropped.
    const differingKeys = compareKeys(
      { category: from.category, attributes: from.attributes as Record<string, string> },
      { category: into.category, attributes: into.attributes as Record<string, string> },
    ).differ;
    const merged = await tx
      .update(catalogItem)
      .set({
        mergedIntoId: into.id,
        ext: sql`${catalogItem.ext} || ${JSON.stringify({
          merge: { by: input.userId, at: new Date().toISOString(), differingKeys },
        })}::jsonb`,
      })
      .where(
        and(
          eq(catalogItem.tenantId, input.tenantId),
          sql`(${catalogItem.id} = ${from.id} or ${catalogItem.mergedIntoId} = ${from.id})`,
        ),
      )
      .returning({ id: catalogItem.id });
    const aliases = await tx
      .update(itemAlias)
      .set({ catalogItemId: into.id, updatedAt: new Date() })
      .where(and(eq(itemAlias.tenantId, input.tenantId), eq(itemAlias.catalogItemId, from.id)))
      .returning({ id: itemAlias.id });
    const prices = await tx
      .update(priceObservation)
      .set({ catalogItemId: into.id })
      .where(
        and(
          eq(priceObservation.tenantId, input.tenantId),
          eq(priceObservation.catalogItemId, from.id),
        ),
      )
      .returning({ id: priceObservation.id });
    // §1.88: the vendor items follow too, so a vendor's SKU keeps finding the item that stays.
    const vendorItems = await moveVendorItemsOnMerge(
      tx,
      input.tenantId,
      merged.map((r) => r.id),
      into.id,
    );
    return {
      intoId: into.id,
      merged: merged.map((r) => r.id),
      aliasesMoved: aliases.length,
      pricesMoved: prices.length,
      vendorItemsMoved: vendorItems.moved.length + vendorItems.folded.length,
      differingKeys,
    };
  });
}
