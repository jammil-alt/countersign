// Books health (docs/plan.md §1.216): a QuickBooks connection's synced records as the checks
// library's snapshot (core `checkBooks`). Each record's latest version, never a deleted one, with
// the raw record it came from as its evidence. Read inside the caller's `withTenant()`; the query
// also names the client (invariant 1). Kept here, beside the sync that writes these records, so the
// platform's report and a pack (the Close pack) read the books the same way.

import type { BooksRecord, BooksSnapshot } from "@countersign/core";
import { rawRecord, type Tx } from "@countersign/db";
import { sql } from "drizzle-orm";

/** The entities the checks read. */
export const BOOKS_ENTITIES = [
  "Account",
  "Vendor",
  "Bill",
  "Purchase",
  "Invoice",
  "Payment",
] as const;

// DECISION: the latest raw record of each record as the first look reads it (setup/tools-chapter):
// by when it was synced, then a deletion, then the higher SyncToken; a deleted one is left out.
export async function loadQboBooks(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    /** Account id → the last day it was reconciled through, where the caller knows it. */
    reconciledThrough?: Record<string, string>;
  },
): Promise<BooksSnapshot> {
  const rows = await tx.execute<{
    id: string;
    entity_type: string;
    external_id: string;
    payload: unknown;
    is_deleted: boolean;
  }>(sql`
    select * from (
      select distinct on (${rawRecord.entityType}, ${rawRecord.externalId})
        ${rawRecord.id} as id, ${rawRecord.entityType} as entity_type,
        ${rawRecord.externalId} as external_id, ${rawRecord.payload} as payload,
        ${rawRecord.isDeleted} as is_deleted
      from ${rawRecord}
      where ${rawRecord.tenantId} = ${input.tenantId}
        and ${rawRecord.connectionId} = ${input.connectionId}
        and ${rawRecord.entityType} in (${sql.join(
          BOOKS_ENTITIES.map((e) => sql`${e}`),
          sql`, `,
        )})
      order by ${rawRecord.entityType}, ${rawRecord.externalId}, ${rawRecord.syncedAt} desc,
        ${rawRecord.isDeleted} desc,
        (case when ${rawRecord.externalVersion} ~ '^[0-9]{1,18}$'
          then ${rawRecord.externalVersion}::bigint end) desc nulls last,
        ${rawRecord.id} desc
    ) latest
    where not is_deleted
    order by entity_type, external_id`);
  const records: BooksRecord[] = [...rows].map((r) => ({
    entity: r.entity_type,
    externalId: r.external_id,
    source: r.id,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
  }));
  return {
    currency: homeCurrency(records),
    records,
    ...(input.reconciledThrough ? { reconciledThrough: input.reconciledThrough } : {}),
  };
}

// DECISION: the home currency is the one most transactions are in (USD when none say); the checks
// add amounts as QuickBooks keeps them, so a company with foreign-currency bills reads them at face
// value (not built: converting with the exchange rate).
function homeCurrency(records: readonly BooksRecord[]): string {
  const n = new Map<string, number>();
  for (const r of records) {
    const c = (r.payload as { CurrencyRef?: { value?: unknown } } | null)?.CurrencyRef?.value;
    if (typeof c === "string" && /^[A-Za-z]{3}$/.test(c)) {
      n.set(c.toUpperCase(), (n.get(c.toUpperCase()) ?? 0) + 1);
    }
  }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "USD";
}
