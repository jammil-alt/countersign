// A CSV of purchases (ARCHITECTURE §6.3): each valid row is stored as it came, as
// `raw_record(connector='upload', entity_type='Purchase')`, then mapped by core's
// `mapUploadPurchase` into a transaction. Importing the same rows again creates nothing.

import {
  MapperError,
  mapUploadPurchase,
  missingPurchaseColumns,
  normalizeHeader,
  type TransactionInput,
} from "@countersign/core";
import { rawRecord, type Tx, transaction } from "@countersign/db";
import { findOrCreateVendor } from "../records/vendors";
import { fromUtf8, utf8 } from "../runtime";
import { sha256Hex } from "../storage/content";
import { CsvError, parseCsv } from "./csv";
import { UPLOAD_CONNECTOR_ID } from "./manifest";

export type TransactionRow = typeof transaction.$inferSelect;

export class PurchasesCsvError extends Error {
  override name = "PurchasesCsvError";
}

export interface ImportResult {
  /** Data rows in the file. */
  rows: number;
  created: TransactionRow[];
  /** Rows already imported (from this file or another with the same row). */
  duplicates: number;
  /** Rows that could not be read; nothing is stored for them. */
  errors: { row: number; message: string }[];
}

/** At most this many rows per file. */
export const MAX_CSV_ROWS = 5000;

export async function importPurchasesCsv(
  tx: Tx,
  input: { tenantId: string; connectionId: string; filename: string; bytes: Uint8Array },
): Promise<ImportResult> {
  let table: string[][];
  try {
    table = parseCsv(fromUtf8(input.bytes));
  } catch (error) {
    throw new PurchasesCsvError(error instanceof CsvError ? error.message : "not a CSV file");
  }
  const [header, ...rows] = table;
  if (!header) throw new PurchasesCsvError("the file is empty");
  const missing = missingPurchaseColumns(header);
  if (missing.length > 0) {
    throw new PurchasesCsvError(`the file has no ${missing.join(", ")} column`);
  }
  if (rows.length > MAX_CSV_ROWS) {
    throw new PurchasesCsvError(`at most ${MAX_CSV_ROWS} rows per file`);
  }
  const keys = header.map(normalizeHeader);
  const fileSha = await sha256Hex(input.bytes);
  const result: ImportResult = { rows: rows.length, created: [], duplicates: 0, errors: [] };
  const seen = new Map<string, number>();

  for (const [i, cellsList] of rows.entries()) {
    const rowNo = i + 1;
    const cells: Record<string, string> = {};
    keys.forEach((k, j) => {
      if (k) cells[k] = cellsList[j] ?? "";
    });
    // DECISION: a row's external id is the sha256 of its cells (plus how many identical rows came
    // before it in the file), not its position, so a later export that repeats earlier rows
    // creates no duplicates.
    const rowHash = await sha256Hex(utf8(JSON.stringify(keys.map((k) => [k, cells[k] ?? ""]))));
    const n = (seen.get(rowHash) ?? 0) + 1;
    seen.set(rowHash, n);
    const externalId = `${rowHash}:${n}`;
    const payload = { cells, file: { sha256: fileSha, filename: input.filename, row: rowNo } };
    let mapped: TransactionInput;
    try {
      mapped = mapUploadPurchase(payload, externalId);
    } catch (error) {
      if (error instanceof MapperError) {
        result.errors.push({ row: rowNo, message: error.message });
        continue;
      }
      throw error;
    }
    const [raw] = await tx
      .insert(rawRecord)
      .values({
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        connector: UPLOAD_CONNECTOR_ID,
        entityType: "Purchase",
        externalId,
        externalVersion: null,
        payload,
      })
      .onConflictDoNothing()
      .returning({ id: rawRecord.id });
    if (!raw) {
      result.duplicates += 1;
      continue;
    }
    const v = mapped.vendorName
      ? await findOrCreateVendor(tx, input.tenantId, mapped.vendorName)
      : null;
    const [created] = await tx
      .insert(transaction)
      .values({
        tenantId: input.tenantId,
        kind: mapped.kind,
        connector: mapped.connector,
        vendorId: v?.id ?? null,
        txnDate: mapped.txnDate,
        total: mapped.total,
        currency: mapped.currency,
        purchaserRef: mapped.purchaserRef,
        paymentType: mapped.paymentType,
        memo: mapped.memo,
        sourceRawRecordId: raw.id,
        externalId: mapped.externalId,
      })
      .onConflictDoNothing()
      .returning();
    if (created) result.created.push(created);
    else result.duplicates += 1;
  }
  return result;
}
