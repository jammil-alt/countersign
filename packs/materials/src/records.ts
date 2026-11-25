// The Purchasing area's record types (docs/step-model-plan.md §10f): master items and vendor
// items, on the tables the area already owns. The platform offers Find, Get by id and Update on
// each; Create stays off, since items are added by Register lines and the other saves that make
// them with their keys and embeddings (§10d).

import { type RecordStore, RecordType } from "@countersign/core";
import { type Tx, tableRecordStore } from "@countersign/db";
import { sql } from "drizzle-orm";
import { catalogItem, vendorItem } from "./schema";

/** A master item: one thing the client buys, vendor-neutral (`catalog_item`). */
export const MASTER_ITEM_RECORD_TYPE: RecordType = RecordType.parse({
  id: "master_item",
  name: "Master item",
  plural: "Master items",
  area: "purchasing",
  about: "One thing the client buys, whoever sells it.",
  fields: [
    { name: "name", type: "text", required: true, about: "The item's name" },
    { name: "category", type: "text", required: true },
    { name: "standardUom", type: "text", required: true, about: "The unit prices compare in" },
    { name: "createdAt", type: "date", required: true },
  ],
  // DECISION: Update sets custom fields only; an item's name and keys are the matching's.
  operations: { update: true },
});

/** A vendor item: one item a vendor sells this client, with its SKU and last price. */
export const VENDOR_ITEM_RECORD_TYPE: RecordType = RecordType.parse({
  id: "vendor_item",
  name: "Vendor item",
  plural: "Vendor items",
  area: "purchasing",
  about: "One item a vendor sells this client: its SKU, unit and last price.",
  fields: [
    { name: "vendorId", type: "record", record: "vendor", required: true },
    { name: "masterItemId", type: "record", record: "master_item", required: true },
    { name: "sku", type: "text", required: false },
    { name: "name", type: "text", required: true, about: "The item as the vendor writes it" },
    { name: "vendorUom", type: "text", required: false },
    { name: "lastPrice", type: "money", required: false, about: "In the vendor's unit" },
    { name: "lastPriceOn", type: "date", required: false },
    { name: "currency", type: "text", required: true },
    { name: "preferred", type: "yes_no", required: true },
    { name: "status", type: "text", required: true, about: "active or discontinued" },
  ],
  keys: ["sku"],
  links: [
    { name: "vendor", to: "vendor", field: "vendorId" },
    { name: "masterItem", to: "master_item", field: "masterItemId" },
  ],
  operations: { update: true },
});

export const MATERIALS_RECORD_TYPES: readonly RecordType[] = [
  MASTER_ITEM_RECORD_TYPE,
  VENDOR_ITEM_RECORD_TYPE,
];

export const MATERIALS_RECORD_STORES: readonly RecordStore<Tx>[] = [
  tableRecordStore({
    type: MASTER_ITEM_RECORD_TYPE,
    table: catalogItem,
    id: catalogItem.id,
    tenantId: catalogItem.tenantId,
    ext: catalogItem.ext,
    order: catalogItem.createdAt,
    // A merged item lives on as the item it was merged into.
    where: sql`${catalogItem.mergedIntoId} is null`,
    columns: {
      name: catalogItem.canonicalName,
      category: catalogItem.category,
      standardUom: catalogItem.standardUom,
      createdAt: catalogItem.createdAt,
    },
  }),
  tableRecordStore({
    type: VENDOR_ITEM_RECORD_TYPE,
    table: vendorItem,
    id: vendorItem.id,
    tenantId: vendorItem.tenantId,
    ext: vendorItem.ext,
    order: vendorItem.updatedAt,
    columns: {
      vendorId: vendorItem.vendorId,
      masterItemId: vendorItem.catalogItemId,
      sku: vendorItem.sku,
      name: vendorItem.name,
      vendorUom: vendorItem.vendorUom,
      lastPrice: vendorItem.lastPrice,
      lastPriceOn: vendorItem.lastPriceOn,
      currency: vendorItem.currency,
      preferred: vendorItem.preferred,
      status: vendorItem.status,
    },
  }),
];
