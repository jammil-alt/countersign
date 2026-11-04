// Linking (ARCHITECTURE §6.3, §7): a document belongs to a transaction when the vendor matches,
// the total is equal and the dates are within 7 days. Forwarded documents add the sender's domain
// as a vendor signal (§6.5). Exactly one match links; none or several leave it for a person.

import { findVendor } from "@countersign/connectors";
import { dec, type ExtractedHeader, normalizeVendorName } from "@countersign/core";
import { docExtraction, document, type Tx, transaction, vendor } from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, desc, eq, gte, isNull, lte, notExists, sql } from "drizzle-orm";
import type { DocumentRow } from "./store";

export const LINK_WINDOW_DAYS = 7;

export type ExtractionRow = typeof docExtraction.$inferSelect;
export type TransactionRow = typeof transaction.$inferSelect;
type VendorRow = typeof vendor.$inferSelect;

export type LinkResult =
  | { status: "linked"; transactionId: string }
  | { status: "already_linked"; transactionId: string }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "no_match"; reason: string }
  | { status: "not_extracted" };

/** yyyy-mm-dd shifted by whole days (UTC; dates have no time of day). */
export function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function latestExtraction(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<ExtractionRow | null> {
  const [row] = await tx
    .select()
    .from(docExtraction)
    .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, documentId)))
    .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
    .limit(1);
  return row ?? null;
}

/** The sender's domain of a forwarded document, from its kept headers. */
export function senderDomain(doc: Pick<DocumentRow, "meta">): string | null {
  const from = (doc.meta as { email?: { from?: unknown } }).email?.from;
  if (typeof from !== "string") return null;
  const at = from.lastIndexOf("@");
  return at < 0 ? null : from.slice(at + 1).toLowerCase();
}

function vendorDomains(v: Pick<VendorRow, "ext">): string[] {
  const d = (v.ext as { domains?: unknown }).domains;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
}

/** The client's vendor a document's header names, else the one its sender's domain belongs to. */
export async function vendorForDocument(
  tx: Tx,
  tenantId: string,
  doc: Pick<DocumentRow, "meta">,
  header: Pick<ExtractedHeader, "vendorName">,
): Promise<VendorRow | null> {
  const byName = await findVendor(tx, tenantId, header.vendorName);
  if (byName) return byName;
  const domain = senderDomain(doc);
  if (!domain) return null;
  const [byDomain] = await tx
    .select()
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), sql`${vendor.ext} -> 'domains' ? ${domain}`))
    .limit(2);
  return byDomain ?? null;
}

/** Transactions of `vendorId` with this total, dated within the window, with no document yet. */
export async function candidateTransactions(
  tx: Tx,
  tenantId: string,
  input: { vendorId: string; total: string; date: string },
): Promise<TransactionRow[]> {
  return tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.vendorId, input.vendorId),
        eq(transaction.total, input.total),
        gte(transaction.txnDate, shiftDate(input.date, -LINK_WINDOW_DAYS)),
        lte(transaction.txnDate, shiftDate(input.date, LINK_WINDOW_DAYS)),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(document)
            .where(
              and(eq(document.tenantId, tenantId), eq(document.transactionId, transaction.id)),
            ),
        ),
      ),
    )
    .orderBy(transaction.txnDate)
    .limit(10);
}

/** Links the document to the transaction, moves the transaction on, and remembers the domain. */
export async function attach(
  tx: Tx,
  tenantId: string,
  doc: DocumentRow,
  txn: TransactionRow,
  options: { testRun?: boolean } = {},
): Promise<void> {
  await tx
    .update(document)
    .set({ transactionId: txn.id })
    .where(
      and(eq(document.id, doc.id), eq(document.tenantId, tenantId), isNull(document.transactionId)),
    );
  // A transaction waiting for its document now has one ("extracted" when it is already read).
  const waiting = txn.status === "needs_doc" || txn.status === "doc_requested";
  const nextStatus = doc.status === "extracted" ? "extracted" : "doc_found";
  if (waiting) {
    await tx
      .update(transaction)
      .set({ status: nextStatus })
      .where(and(eq(transaction.id, txn.id), eq(transaction.tenantId, tenantId)));
    await emit(
      tx,
      {
        tenantId,
        type: "transaction.updated",
        subjectId: txn.id,
        payload: {
          transactionId: txn.id,
          source: txn.connector,
          vendorId: txn.vendorId,
          total: { amount: txn.total, currency: txn.currency },
          txnDate: txn.txnDate,
          changed: ["status", "document"],
        },
      },
      { testRun: options.testRun === true },
    );
  }
  const domain = senderDomain(doc);
  if (domain && txn.vendorId) {
    const [v] = await tx
      .select()
      .from(vendor)
      .where(and(eq(vendor.id, txn.vendorId), eq(vendor.tenantId, tenantId)));
    if (v && !vendorDomains(v).includes(domain)) {
      await tx
        .update(vendor)
        .set({ ext: { ...v.ext, domains: [...vendorDomains(v), domain] } })
        .where(and(eq(vendor.id, v.id), eq(vendor.tenantId, tenantId)));
    }
  }
}

/** Links a document to its transaction by vendor + total + date (± 7 days), when exactly one fits. */
export async function linkToTransaction(
  tx: Tx,
  tenantId: string,
  documentId: string,
  options: { testRun?: boolean } = {},
): Promise<LinkResult> {
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, documentId), eq(document.tenantId, tenantId)));
  if (!doc) return { status: "no_match", reason: "no such document" };
  if (doc.transactionId) return { status: "already_linked", transactionId: doc.transactionId };
  const x = await latestExtraction(tx, tenantId, documentId);
  if (!x) return { status: "not_extracted" };
  const header = x.header as unknown as ExtractedHeader;
  const v = await vendorForDocument(tx, tenantId, doc, header);
  if (!v) return { status: "no_match", reason: `no vendor named ${header.vendorName}` };
  const candidates = await candidateTransactions(tx, tenantId, {
    vendorId: v.id,
    total: x.total,
    date: header.invoiceDate,
  });
  if (candidates.length === 0) {
    return { status: "no_match", reason: "no transaction of that vendor, total and date" };
  }
  if (candidates.length > 1)
    return { status: "ambiguous", candidates: candidates.map((c) => c.id) };
  const txn = candidates[0] as TransactionRow;
  await attach(tx, tenantId, doc, txn, options);
  return { status: "linked", transactionId: txn.id };
}

/** Whether an extraction fits a transaction: same vendor, equal total, dates within the window. */
export function extractionFits(
  x: Pick<ExtractionRow, "header" | "total">,
  txn: Pick<TransactionRow, "total" | "txnDate">,
  v: Pick<VendorRow, "normalizedName" | "aliases">,
): boolean {
  const header = x.header as unknown as ExtractedHeader;
  const name = normalizeVendorName(header.vendorName ?? "");
  if (name !== v.normalizedName && !v.aliases.includes(name)) return false;
  if (!dec(x.total).equals(dec(txn.total))) return false;
  if (!txn.txnDate) return false;
  return (
    txn.txnDate >= shiftDate(header.invoiceDate, -LINK_WINDOW_DAYS) &&
    txn.txnDate <= shiftDate(header.invoiceDate, LINK_WINDOW_DAYS)
  );
}
