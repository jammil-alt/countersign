// Purchases from invoices (docs/plan.md §1.104, ARCHITECTURE §5.2): a client with no accounting
// tool still has purchases. An invoice that came in by email or upload, read with totals that add
// up, makes its own purchase record: its vendor (found by name, alias or the forwarding sender's
// domain, else created), a `transaction` from the document, and the document linked to it. A
// purchase already synced from a tool is linked instead (linking's rule, ./link.ts), and a bill
// the client's tool syncs later takes over the record the document made (`documentPurchaseFor`),
// so the same purchase is never kept twice.
//
// DECISION: a document-made purchase has no raw_record. raw_record is what a connector synced, as
// it came (append-only, with its connection); a document is not a connector's record, and its own
// immutable rows (the document, its doc_extraction and doc_lines, invariant 3) already keep what
// it said. The transaction names them in `ext.document` (invariant 10) and its connector is
// `document`, with the document's id as its external id, so recording it twice finds the one row.

import { findOrCreateVendor } from "@countersign/connectors";
import { dec, type ExtractedHeader } from "@countersign/core";
import { document, type Tx, transaction, vendor } from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, eq, gte, lte } from "drizzle-orm";
import { docNumbersAgree } from "./bill";
import {
  attach,
  candidateTransactions,
  LINK_WINDOW_DAYS,
  latestExtraction,
  shiftDate,
  type TransactionRow,
  vendorForDocument,
} from "./link";
import { DocumentError } from "./store";

/** The connector a purchase made from a document names (`transaction.connector`). */
export const DOCUMENT_CONNECTOR = "document";

export type RecordPurchaseStatus =
  /** A purchase was made from the document (a test run: would be). */
  | "created"
  /** A purchase already here (synced from a tool) fit the invoice; the document is linked to it. */
  | "linked"
  | "already_linked"
  /** Several purchases fit: a person picks. */
  | "ambiguous"
  /** Not read yet, totals that don't add up, or a copy of another document. */
  | "not_ready";

export interface RecordPurchaseResult {
  status: RecordPurchaseStatus;
  documentId: string;
  /** Null in a test run's `created` (nothing is written) and when nothing was linked. */
  transactionId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** The vendor was new to the client's records (a test run: would be). */
  vendorCreated: boolean;
  candidates: string[];
  /** Plain words, for the run view and the person who decides. */
  reason: string;
  sources: string[];
}

/** What the document-made purchase keeps of its invoice (`transaction.ext.document`). */
export interface DocumentPurchaseExt {
  id: string;
  extractionId: string;
  docNumber: string;
  dueDate: string | null;
  paymentTerms: string | null;
}

/**
 * Makes the purchase record of an invoice read with valid totals, or links the one already here.
 * A test run writes nothing and answers what it would do.
 */
export async function recordPurchase(
  tx: Tx,
  tenantId: string,
  documentId: string,
  options: { testRun?: boolean } = {},
): Promise<RecordPurchaseResult> {
  const testRun = options.testRun === true;
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, documentId), eq(document.tenantId, tenantId)))
    .for("update");
  if (!doc) throw new DocumentError("not_found", `document ${documentId} not found`);
  const out = (
    status: RecordPurchaseStatus,
    reason: string,
    rest: Partial<RecordPurchaseResult> = {},
  ): RecordPurchaseResult => {
    const transactionId = rest.transactionId ?? null;
    const candidates = rest.candidates ?? [];
    return {
      status,
      documentId,
      transactionId,
      vendorId: rest.vendorId ?? null,
      vendorName: rest.vendorName ?? null,
      vendorCreated: rest.vendorCreated ?? false,
      candidates,
      reason,
      sources: [
        documentId,
        ...(rest.sources ?? []),
        ...(transactionId ? [transactionId] : []),
        ...candidates,
      ],
    };
  };
  if (doc.transactionId) {
    const [t] = await tx
      .select({ vendorId: transaction.vendorId, vendorName: vendor.name })
      .from(transaction)
      .leftJoin(vendor, eq(vendor.id, transaction.vendorId))
      .where(and(eq(transaction.id, doc.transactionId), eq(transaction.tenantId, tenantId)));
    return out("already_linked", "The invoice already belongs to a purchase.", {
      transactionId: doc.transactionId,
      vendorId: t?.vendorId ?? null,
      vendorName: t?.vendorName ?? null,
    });
  }
  const duplicate = (doc.meta as { duplicateOf?: { documentId?: unknown } }).duplicateOf;
  if (duplicate && typeof duplicate.documentId === "string") {
    return out(
      "not_ready",
      "This invoice is a copy of one already here; the first copy holds the purchase.",
      { sources: [duplicate.documentId] },
    );
  }
  const x = await latestExtraction(tx, tenantId, documentId);
  if (!x) return out("not_ready", "The invoice hasn't been read yet.");
  if (!x.totalsMatch) {
    return out(
      "not_ready",
      "The invoice's totals don't add up as read; a person checks the reading first.",
      { sources: [x.id] },
    );
  }
  const header = x.header as unknown as ExtractedHeader & { paymentTerms?: string | null };
  const read = [x.id];
  const found = await vendorForDocument(tx, tenantId, doc, header);
  if (found) {
    // A purchase of that vendor, total and date already here (synced, or a CSV row): linking's rule.
    const candidates = await candidateTransactions(tx, tenantId, {
      vendorId: found.id,
      total: x.total,
      date: header.invoiceDate,
    });
    const named = { vendorId: found.id, vendorName: found.name, sources: read };
    if (candidates.length > 1) {
      return out(
        "ambiguous",
        `${candidates.length} purchases from ${found.name} have this total and a date within ${LINK_WINDOW_DAYS} days; a person picks one.`,
        { ...named, candidates: candidates.map((c) => c.id) },
      );
    }
    const only = candidates[0];
    if (only) {
      if (!testRun) await attach(tx, tenantId, doc, only, { testRun });
      return out("linked", `Linked to the purchase from ${found.name} already in your records.`, {
        ...named,
        transactionId: only.id,
      });
    }
  }
  if (testRun) {
    return out(
      "created",
      found
        ? `Would record the purchase from ${found.name}.`
        : `Would add ${header.vendorName} as a vendor and record the purchase.`,
      {
        vendorId: found?.id ?? null,
        vendorName: found?.name ?? header.vendorName,
        vendorCreated: !found,
        sources: read,
      },
    );
  }
  const v = found ?? (await findOrCreateVendor(tx, tenantId, header.vendorName));
  if (!v) return out("not_ready", "The invoice names no vendor.", { sources: read });
  const ext: DocumentPurchaseExt = {
    id: doc.id,
    extractionId: x.id,
    docNumber: header.invoiceNumber,
    dueDate: header.dueDate ?? null,
    paymentTerms: typeof header.paymentTerms === "string" ? header.paymentTerms : null,
  };
  // DECISION: a document-made purchase is a `bill` (an invoice to pay), dated the invoice's date,
  // for its total and currency as read; its lines stay the reading's doc_lines (no
  // transaction_line copy), and it starts `extracted`: its document is here and read.
  const [inserted] = await tx
    .insert(transaction)
    .values({
      tenantId,
      kind: "bill",
      connector: DOCUMENT_CONNECTOR,
      externalId: doc.id,
      vendorId: v.id,
      txnDate: header.invoiceDate,
      total: x.total,
      currency: x.currency,
      memo: null,
      status: "extracted",
      ext: { [DOCUMENT_CONNECTOR]: ext },
    })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted ??
    (
      await tx
        .select()
        .from(transaction)
        .where(
          and(
            eq(transaction.tenantId, tenantId),
            eq(transaction.connector, DOCUMENT_CONNECTOR),
            eq(transaction.externalId, doc.id),
          ),
        )
    )[0];
  if (!row) throw new Error("purchase insert returned nothing");
  await attach(tx, tenantId, doc, row, { testRun });
  if (inserted) {
    await emit(tx, {
      tenantId,
      type: "transaction.created",
      subjectId: row.id,
      payload: {
        transactionId: row.id,
        source: DOCUMENT_CONNECTOR,
        vendorId: v.id,
        total: { amount: row.total, currency: row.currency },
        txnDate: row.txnDate,
      },
    });
  }
  return out(
    "created",
    found
      ? `Recorded the purchase from ${v.name}.`
      : `Added ${v.name} as a vendor and recorded the purchase.`,
    {
      transactionId: row.id,
      vendorId: v.id,
      vendorName: v.name,
      vendorCreated: !found,
      sources: read,
    },
  );
}

/** The document-made purchase's own facts, as `recordPurchase` kept them. */
export function documentPurchaseExt(t: Pick<TransactionRow, "ext">): DocumentPurchaseExt | null {
  const e = (t.ext as Record<string, unknown>)[DOCUMENT_CONNECTOR];
  if (!e || typeof e !== "object") return null;
  const d = e as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.docNumber === "string"
    ? (d as unknown as DocumentPurchaseExt)
    : null;
}

/**
 * The one purchase a document made that a bill synced from the client's tool is: the same vendor,
 * currency and total to the cent, a date within linking's window, and a document number that
 * agrees (`docNumbersAgree`). Null when none or several fit; the sync then keeps its own record.
 */
// DECISION: the client's tool stays the system of record (ARCHITECTURE §12.0 rule 3): when its bill
// arrives, the sync takes over the document-made row (its connector, id and fields become the
// tool's) instead of adding a second purchase; its document, prices and alerts keep pointing at it.
export async function documentPurchaseFor(
  tx: Tx,
  tenantId: string,
  input: {
    vendorId: string | null;
    total: string;
    currency: string;
    txnDate: string | null;
    docNumber: string | null;
  },
): Promise<TransactionRow | null> {
  if (!input.vendorId || !input.txnDate) return null;
  const near = await tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.connector, DOCUMENT_CONNECTOR),
        eq(transaction.vendorId, input.vendorId),
        gte(transaction.txnDate, shiftDate(input.txnDate, -LINK_WINDOW_DAYS)),
        lte(transaction.txnDate, shiftDate(input.txnDate, LINK_WINDOW_DAYS)),
      ),
    )
    .limit(20);
  const fits = near.filter((t) => {
    const own = documentPurchaseExt(t);
    return (
      t.currency === input.currency &&
      dec(t.total).equals(dec(input.total)) &&
      (own === null || docNumbersAgree(own.docNumber, input.docNumber))
    );
  });
  return fits.length === 1 ? (fits[0] as TransactionRow) : null;
}
