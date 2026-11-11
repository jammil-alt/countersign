// A vendor's price list into its catalog (docs/plan.md §1.88, "filled further by … an import (a
// vendor's price list as CSV)"): a Save to records write. Each row is the vendor's item by its
// SKU, else by a SKU or wording the vendor used before (its alias), else by the master item the
// row names; it gets the list's name, description, pack, unit, minimum, lead time and list price.
// A row nobody can place stays listed and gets no vendor item (every vendor item has its master
// item: a person, or the matching pipeline on the vendor's next invoice, decides). Nothing here
// calls a model; the embeddings step after it embeds what it made or re-worded.

import { parseCsv } from "@countersign/connectors";
import { toNumeric } from "@countersign/core";
import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { descriptionHash, normalize } from "../catalog/normalize";
import { liveItem } from "../catalog/store";
import { readUom } from "../pricing/uom";
import {
  cleanSku,
  createVendorItem,
  updateVendorItem,
  type VendorItemCreator,
  VendorItemError,
  vendorAlias,
  vendorItemBySku,
} from "./store";

/** One row of a price list, as read (strings as the vendor wrote them). */
export interface PriceListRow {
  sku?: string | null | undefined;
  name?: string | null | undefined;
  description?: string | null | undefined;
  packSize?: string | null | undefined;
  vendorUom?: string | null | undefined;
  stdPerVendorUom?: string | null | undefined;
  minOrderQty?: string | null | undefined;
  leadTimeDays?: string | number | null | undefined;
  listPrice?: string | null | undefined;
  catalogItemId?: string | null | undefined;
}

// DECISION: a price list's columns are found by their header, in these spellings (lower case,
// spaces collapsed); the first one present wins. A list without a SKU or a name column is refused.
export const PRICE_LIST_COLUMNS: Readonly<Record<keyof PriceListRow, readonly string[]>> = {
  sku: ["sku", "item #", "item number", "item no", "part #", "part number", "product code", "code"],
  name: ["name", "item name", "product name", "product", "item", "description"],
  description: ["details", "long description", "item description", "notes"],
  packSize: ["pack", "pack size", "package", "packaging"],
  vendorUom: ["uom", "unit", "unit of measure", "sell unit", "per"],
  stdPerVendorUom: ["units per pack", "per pack", "qty per unit", "std per unit", "conversion"],
  minOrderQty: ["min order", "minimum order", "moq", "min qty", "minimum"],
  leadTimeDays: ["lead time", "lead time days", "lead days"],
  listPrice: ["list price", "price", "unit price", "net price", "cost"],
  catalogItemId: ["master item id", "catalog item id"],
};

const header = (h: string) => h.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");

/** A price list's text as rows. */
export function readPriceList(text: string): PriceListRow[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const names = head.map(header);
  const at = Object.fromEntries(
    Object.entries(PRICE_LIST_COLUMNS).map(([k, spellings]) => [
      k,
      spellings.map((s) => names.indexOf(s)).find((i) => i >= 0) ?? -1,
    ]),
  ) as Record<keyof PriceListRow, number>;
  if (at.sku < 0 && at.name < 0) {
    throw new VendorItemError("bad_input", "a price list needs a SKU or a name column");
  }
  return body.map((cells) => {
    const row: PriceListRow = {};
    for (const [k, i] of Object.entries(at) as [keyof PriceListRow, number][]) {
      const v = i >= 0 ? cells[i]?.trim() : undefined;
      if (v) (row as Record<string, string>)[k] = v;
    }
    return row;
  });
}

const money = (raw: string | null | undefined): string | null => {
  const s = raw?.replace(/[$,\s]/g, "") ?? "";
  return /^\d{1,10}(\.\d{1,4})?$/.test(s) ? toNumeric(s) : null;
};
const days = (raw: string | number | null | undefined): number | null => {
  const n =
    typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "").replace(/\D/g, ""), 10);
  return Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ImportedRow {
  rowNo: number;
  sku: string | null;
  name: string | null;
  outcome: "updated" | "created" | "unplaced" | "skipped";
  vendorItemId: string | null;
  catalogItemId: string | null;
  /** Why a row was skipped or left unplaced. */
  reason: string | null;
}

export interface ImportResult {
  vendorId: string;
  rows: ImportedRow[];
  updated: number;
  created: number;
  unplaced: number;
  skipped: number;
  /** Vendor items made, or whose name or description changed: the embeddings step's input. */
  vendorItemIds: string[];
  testRun: boolean;
}

class RollBack extends Error {
  constructor(readonly result: ImportResult) {
    super("test run: rolled back");
  }
}

/**
 * Imports a vendor's price list into its catalog, in one transaction. A test run does the work
 * and rolls it back, answering what it would have written.
 */
export async function importPriceList(
  db: Db,
  input: {
    tenantId: string;
    vendorId: string;
    rows: readonly PriceListRow[];
    /** The date the list's prices are from. */
    listPriceOn: string;
    by: VendorItemCreator;
    testRun: boolean;
  },
): Promise<ImportResult> {
  try {
    return await withTenant(db, input.tenantId, async (tx) => {
      const result = await importRows(tx, input);
      if (input.testRun) throw new RollBack(result);
      return result;
    });
  } catch (error) {
    if (error instanceof RollBack) return error.result;
    throw error;
  }
}

async function importRows(
  tx: Tx,
  input: Parameters<typeof importPriceList>[1],
): Promise<ImportResult> {
  const { tenantId, vendorId } = input;
  const [v] = await tx
    .select({ id: vendor.id, ext: vendor.ext })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId), eq(vendor.tenantId, tenantId)))
    .limit(1);
  if (!v) throw new VendorItemError("not_found", `vendor ${vendorId} not found`);
  const abbreviations =
    ((v.ext as { abbreviations?: Record<string, string> }).abbreviations as
      | Record<string, string>
      | undefined) ?? {};
  const result: ImportResult = {
    vendorId,
    rows: [],
    updated: 0,
    created: 0,
    unplaced: 0,
    skipped: 0,
    vendorItemIds: [],
    testRun: input.testRun,
  };
  const seen = new Set<string>();
  for (const [i, r] of input.rows.entries()) {
    const rowNo = i + 1;
    const sku = cleanSku(r.sku);
    const name = (r.name ?? r.description)?.trim().slice(0, 500) || null;
    const base = { rowNo, sku, name };
    const skip = (reason: string) => {
      result.skipped++;
      result.rows.push({
        ...base,
        outcome: "skipped",
        vendorItemId: null,
        catalogItemId: null,
        reason,
      });
    };
    if (!sku && !name) {
      skip("no SKU and no name");
      continue;
    }
    const key = sku ? `sku:${sku}` : `name:${normalize(name ?? "", { abbreviations })}`;
    if (seen.has(key)) {
      skip("the same item is on the list twice");
      continue;
    }
    seen.add(key);
    const listPrice = money(r.listPrice);
    const vendorUom = r.vendorUom?.trim()
      ? (readUom(r.vendorUom) ?? r.vendorUom.trim().toLowerCase())
      : undefined;
    const stdPer = money(r.stdPerVendorUom);
    const fields = {
      ...(r.description && r.name ? { description: r.description.trim() } : {}),
      ...(r.packSize?.trim() ? { packSize: r.packSize.trim() } : {}),
      ...(vendorUom ? { vendorUom } : {}),
      ...(stdPer && stdPer !== "0.0000" ? { stdPerVendorUom: stdPer } : {}),
      ...(money(r.minOrderQty) ? { minOrderQty: money(r.minOrderQty) } : {}),
      ...(days(r.leadTimeDays) !== null ? { leadTimeDays: days(r.leadTimeDays) } : {}),
      ...(listPrice ? { listPrice, listPriceOn: input.listPriceOn } : {}),
    };
    // The vendor's item: by its SKU, else by an alias the vendor used before.
    let item = sku ? await vendorItemBySku(tx, tenantId, vendorId, sku) : null;
    let catalogItemId = item?.catalogItemId ?? null;
    if (!item && name) {
      const hit = await vendorAlias(tx, tenantId, {
        vendorId,
        sku,
        descriptionHash: await descriptionHash(normalize(name, { abbreviations })),
      });
      if (hit) {
        // An alias's vendor item with another SKU is another item: only its master item counts.
        item = hit.item && (!sku || !hit.item.sku) ? hit.item : null;
        catalogItemId = hit.catalogItemId;
      }
    }
    if (!catalogItemId && r.catalogItemId && UUID.test(r.catalogItemId.trim())) {
      const live = await liveItem(tx, tenantId, r.catalogItemId.trim());
      catalogItemId = live?.id ?? null;
    }
    if (item) {
      const before = { name: item.name, description: item.description };
      const updated = await updateVendorItem(tx, tenantId, item.id, {
        ...fields,
        ...(name ? { name } : {}),
        ...(sku && !item.sku ? { sku } : {}),
      });
      if (updated.name !== before.name || updated.description !== before.description) {
        result.vendorItemIds.push(updated.id);
      }
      result.updated++;
      result.rows.push({
        ...base,
        outcome: "updated",
        vendorItemId: updated.id,
        catalogItemId: updated.catalogItemId,
        reason: null,
      });
      continue;
    }
    if (!catalogItemId || !name) {
      result.unplaced++;
      result.rows.push({
        ...base,
        outcome: "unplaced",
        vendorItemId: null,
        catalogItemId: null,
        reason: name ? "no master item is known for it" : "no name to make it with",
      });
      continue;
    }
    const made = await createVendorItem(
      tx,
      tenantId,
      { ...fields, vendorId, catalogItemId, sku, name },
      input.by,
    );
    if (made.created) {
      result.created++;
      result.vendorItemIds.push(made.item.id);
    } else {
      await updateVendorItem(tx, tenantId, made.item.id, fields);
      result.updated++;
    }
    result.rows.push({
      ...base,
      outcome: made.created ? "created" : "updated",
      vendorItemId: made.item.id,
      catalogItemId,
      reason: null,
    });
  }
  return result;
}
