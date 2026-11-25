// Our own records by record type (docs/step-model-plan.md §10f): every record type the platform
// (the shared records) and the registered packs declare, each with its store. The one place the
// record types meet; nothing in packages/* names a pack (invariant 2).

import {
  type RecordStore,
  type RecordType,
  recordTypesProblems,
  SHARED_RECORD_TYPES,
  TRANSACTION_RECORD_TYPE,
  VENDOR_RECORD_TYPE,
} from "@countersign/core";
import { type Tx, tableRecordStore, transaction, vendor } from "@countersign/db";
import type { RegisteredPack } from "../packs";

/** The shared records' stores: vendors and transactions, on the platform's own tables. */
export const SHARED_RECORD_STORES: readonly RecordStore<Tx>[] = [
  tableRecordStore({
    type: VENDOR_RECORD_TYPE,
    table: vendor,
    id: vendor.id,
    tenantId: vendor.tenantId,
    ext: vendor.ext,
    order: vendor.createdAt,
    columns: { name: vendor.name, createdAt: vendor.createdAt },
  }),
  tableRecordStore({
    type: TRANSACTION_RECORD_TYPE,
    table: transaction,
    id: transaction.id,
    tenantId: transaction.tenantId,
    ext: transaction.ext,
    order: transaction.createdAt,
    columns: {
      kind: transaction.kind,
      vendorId: transaction.vendorId,
      txnDate: transaction.txnDate,
      total: transaction.total,
      currency: transaction.currency,
      memo: transaction.memo,
      status: transaction.status,
    },
  }),
];

export interface RecordCatalog {
  /** Every declared record type, the shared ones first. */
  types: readonly RecordType[];
  type(id: string): RecordType | undefined;
  store(id: string): RecordStore<Tx> | undefined;
}

/**
 * The deployment's record types and stores. A pack declares its record types on its manifest and
 * gives their stores (`records`); one without a store, a store without a declaration, an id two
 * areas declare, or a link to an undeclared type stops the Worker from starting.
 */
export function recordCatalog(packs: readonly RegisteredPack[]): RecordCatalog {
  const types = [...SHARED_RECORD_TYPES, ...packs.flatMap((p) => p.manifest.recordTypes)];
  const stores = [...SHARED_RECORD_STORES, ...packs.flatMap((p) => p.records ?? [])];
  const problems = recordTypesProblems(types);
  const byStore = new Map(stores.map((s) => [s.type.id, s]));
  for (const t of types) {
    if (!byStore.has(t.id)) problems.push(`record type ${t.id} has no store`);
  }
  for (const s of stores) {
    if (!types.some((t) => t.id === s.type.id)) {
      problems.push(`a store is registered for ${s.type.id}, which no manifest declares`);
    }
  }
  if (problems.length > 0) throw new Error(`record types: ${problems.join("; ")}`);
  const byType = new Map(types.map((t) => [t.id, t]));
  return {
    types,
    type: (id) => byType.get(id),
    store: (id) => byStore.get(id),
  };
}
