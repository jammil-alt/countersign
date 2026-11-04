// Locate support for a transaction (ARCHITECTURE §7): a document already linked; else, in order,
// connector attachments (none until QBO, M9), forwarded documents, then uploads, matched on vendor
// + total + date (± 7 days); else a person has to be asked (`docs.request_from_person`).

import { document, type Tx, transaction, vendor } from "@countersign/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { attach, extractionFits, latestExtraction, type TransactionRow } from "./link";
import type { DocumentRow } from "./store";

export type FindSupportResult =
  | { status: "found"; transactionId: string; documentIds: string[]; linkedNow: boolean }
  | { status: "candidates"; transactionId: string; documentIds: string[] }
  | {
      status: "missing";
      transactionId: string;
      /** Unlinked documents not read yet: extracting them may find it. */
      unextractedDocumentIds: string[];
    };

export class SupportError extends Error {
  override name = "SupportError";
}

// DECISION: forwarded documents are searched before uploads, as ARCHITECTURE §7 orders the
// sources; within one source the most recent come first. At most 200 unlinked documents per
// source are considered.
const SOURCE_ORDER = ["connector", "email", "upload"] as const;

export async function findSupport(
  tx: Tx,
  tenantId: string,
  transactionId: string,
  options: { testRun?: boolean } = {},
): Promise<FindSupportResult> {
  const [txn] = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.tenantId, tenantId)));
  if (!txn) throw new SupportError(`transaction ${transactionId} not found`);
  const linked = await tx
    .select({ id: document.id })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.transactionId, txn.id)));
  if (linked.length > 0) {
    return {
      status: "found",
      transactionId,
      documentIds: linked.map((d) => d.id),
      linkedNow: false,
    };
  }
  const v = txn.vendorId
    ? (
        await tx
          .select()
          .from(vendor)
          .where(and(eq(vendor.id, txn.vendorId), eq(vendor.tenantId, tenantId)))
      )[0]
    : undefined;
  const unextracted: string[] = [];
  for (const source of SOURCE_ORDER) {
    const docs = await tx
      .select()
      .from(document)
      .where(
        and(
          eq(document.tenantId, tenantId),
          eq(document.source, source),
          isNull(document.transactionId),
        ),
      )
      .orderBy(desc(document.receivedAt))
      .limit(200);
    const fits: DocumentRow[] = [];
    for (const d of docs) {
      if (d.status === "stored" || d.status === "extracting") {
        unextracted.push(d.id);
        continue;
      }
      if (!v) continue;
      const x = await latestExtraction(tx, tenantId, d.id);
      if (x && extractionFits(x, txn, v)) fits.push(d);
    }
    if (fits.length === 1) {
      await attach(tx, tenantId, fits[0] as DocumentRow, txn as TransactionRow, options);
      return {
        status: "found",
        transactionId,
        documentIds: [(fits[0] as DocumentRow).id],
        linkedNow: true,
      };
    }
    if (fits.length > 1) {
      return { status: "candidates", transactionId, documentIds: fits.map((d) => d.id) };
    }
  }
  return { status: "missing", transactionId, unextractedDocumentIds: unextracted.slice(0, 50) };
}
