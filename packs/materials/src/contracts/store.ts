// Vendor contracts (docs/plan.md §1.104): a vendor's contract or agreed price sheet with this
// client, kept in the Purchasing area. Its terms are a `vendor_contract` row; its item prices are
// the vendor's catalog (`vendor_item`), each agreed price a list price that names the contract,
// written by the price list import (one path for a vendor's prices, §1.88). Saving the same
// contract again (the same vendor and start date) updates it. Nothing here calls a model.

import { findOrCreateVendor, findVendor } from "@countersign/connectors";
import { dec, toNumeric } from "@countersign/core";
import { type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { ContractPrice, ContractTerms } from "../pricing/contract";
import { type FreightTerm, vendorContract, vendorItem } from "../schema";
import { type ImportResult, importPriceListRows, type PriceListRow } from "../vendor/import";
import { type VendorItemCreator, VendorItemError } from "../vendor/store";

export type ContractRow = typeof vendorContract.$inferSelect;

/** A contract row as the rules and tools read it. */
export function contractTerms(r: ContractRow): ContractTerms {
  return {
    id: r.id,
    vendorId: r.vendorId,
    name: r.name,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    paymentTerms: r.paymentTerms,
    netDays: r.netDays,
    earlyPayDiscountPct: r.earlyPayDiscountPct,
    earlyPayDays: r.earlyPayDays,
    freight: r.freight,
    minOrderAmount: r.minOrderAmount,
    currency: r.currency,
    documentId: r.documentId,
    sources: r.sources,
  };
}

/** The vendor's contracts, newest start first. */
export async function vendorContracts(
  tx: Tx,
  tenantId: string,
  vendorId: string,
): Promise<ContractTerms[]> {
  const rows = await tx
    .select()
    .from(vendorContract)
    .where(and(eq(vendorContract.tenantId, tenantId), eq(vendorContract.vendorId, vendorId)))
    .orderBy(desc(vendorContract.effectiveFrom));
  return rows.map(contractTerms);
}

export interface AgreedPrice extends ContractPrice {
  contractId: string;
  sku: string | null;
  name: string;
  priceOn: string | null;
  currency: string;
}

/** The agreed prices of these contracts: the active vendor items whose list price names one. */
export async function agreedPrices(
  tx: Tx,
  tenantId: string,
  contractIds: readonly string[],
): Promise<AgreedPrice[]> {
  if (contractIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(vendorItem)
    .where(
      and(
        eq(vendorItem.tenantId, tenantId),
        inArray(vendorItem.contractId, [...contractIds]),
        eq(vendorItem.status, "active"),
      ),
    )
    .orderBy(asc(vendorItem.sku), asc(vendorItem.id));
  return rows.flatMap((r) =>
    r.listPrice && r.contractId
      ? [
          {
            contractId: r.contractId,
            vendorItemId: r.id,
            catalogItemId: r.catalogItemId,
            sku: r.sku,
            name: r.name,
            price: r.listPrice,
            priceOn: r.listPriceOn,
            vendorUom: r.vendorUom,
            stdPerVendorUom: r.stdPerVendorUom,
            currency: r.currency,
          },
        ]
      : [],
  );
}

/** What a contract says, as a person or the contract reading gives it. */
export interface ContractInput {
  name: string;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  paymentTerms?: string | null | undefined;
  netDays?: number | null | undefined;
  earlyPayDiscountPct?: string | null | undefined;
  earlyPayDays?: number | null | undefined;
  freight?: FreightTerm | undefined;
  minOrderAmount?: string | null | undefined;
  currency?: string | undefined;
  notes?: string | null | undefined;
}

export interface SaveContractInput {
  tenantId: string;
  /** The vendor by id, else by name (found by name or alias, added when new). */
  vendorId?: string | null | undefined;
  vendorName?: string | null | undefined;
  /** The signed contract or price sheet it was read from. */
  documentId?: string | null | undefined;
  contract: ContractInput;
  /** Its item prices, as price list rows (`listPrice` is the agreed price). */
  items: readonly PriceListRow[];
  /** The records it was read from (invariant 10). */
  sources?: readonly string[] | undefined;
  by: VendorItemCreator;
}

export interface SavedContract {
  contract: ContractRow;
  created: boolean;
  vendorId: string;
  vendorName: string;
  vendorCreated: boolean;
  prices: ImportResult;
}

/**
 * Saves a vendor's contract and its agreed prices in the caller's transaction: the terms (one row
 * per vendor and start date, updated when saved again), then its items through the price list
 * import, each price dated the contract's start and naming the contract.
 */
export async function saveContract(tx: Tx, input: SaveContractInput): Promise<SavedContract> {
  const { tenantId } = input;
  let vendorRow: { id: string; name: string } | null = null;
  let vendorCreated = false;
  if (input.vendorId) {
    const [v] = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.id, input.vendorId), eq(vendor.tenantId, tenantId)))
      .limit(1);
    vendorRow = v ?? null;
  } else if (input.vendorName?.trim()) {
    const known = await findVendor(tx, tenantId, input.vendorName);
    vendorRow = known ?? (await findOrCreateVendor(tx, tenantId, input.vendorName));
    vendorCreated = !known && vendorRow !== null;
  }
  if (!vendorRow) throw new VendorItemError("not_found", "the contract's vendor isn't known");
  const c = input.contract;
  if (c.effectiveTo && c.effectiveTo < c.effectiveFrom) {
    throw new VendorItemError("bad_input", "a contract can't end before it starts");
  }
  const by =
    "agentVersionId" in input.by
      ? { createdByAgentVersionId: input.by.agentVersionId || null }
      : { createdByUserId: input.by.userId };
  const fields = {
    name: c.name.trim().slice(0, 300),
    effectiveTo: c.effectiveTo ?? null,
    paymentTerms: c.paymentTerms?.trim().slice(0, 300) || null,
    netDays: c.netDays ?? null,
    earlyPayDiscountPct:
      c.earlyPayDiscountPct && c.earlyPayDays !== null && c.earlyPayDays !== undefined
        ? dec(c.earlyPayDiscountPct).toFixed(2)
        : null,
    earlyPayDays:
      c.earlyPayDiscountPct && c.earlyPayDays !== null && c.earlyPayDays !== undefined
        ? c.earlyPayDays
        : null,
    freight: c.freight ?? "unknown",
    minOrderAmount: c.minOrderAmount ? toNumeric(c.minOrderAmount) : null,
    currency: c.currency ?? "USD",
    documentId: input.documentId ?? null,
    sources: [
      ...new Set([...(input.documentId ? [input.documentId] : []), ...(input.sources ?? [])]),
    ],
    notes: c.notes?.trim() || null,
  };
  const [existing] = await tx
    .select({ id: vendorContract.id })
    .from(vendorContract)
    .where(
      and(
        eq(vendorContract.tenantId, tenantId),
        eq(vendorContract.vendorId, vendorRow.id),
        eq(vendorContract.effectiveFrom, c.effectiveFrom),
      ),
    )
    .for("update");
  const [row] = existing
    ? await tx
        .update(vendorContract)
        .set({ ...fields, updatedAt: new Date() })
        .where(and(eq(vendorContract.id, existing.id), eq(vendorContract.tenantId, tenantId)))
        .returning()
    : await tx
        .insert(vendorContract)
        .values({
          tenantId,
          vendorId: vendorRow.id,
          effectiveFrom: c.effectiveFrom,
          ...fields,
          ...by,
        })
        .returning();
  if (!row) throw new Error("contract save returned nothing");
  const prices = await importPriceListRows(tx, {
    tenantId,
    vendorId: vendorRow.id,
    rows: input.items,
    listPriceOn: c.effectiveFrom,
    by: input.by,
    testRun: false,
    contractId: row.id,
  });
  return {
    contract: row,
    created: !existing,
    vendorId: vendorRow.id,
    vendorName: vendorRow.name,
    vendorCreated,
    prices,
  };
}
