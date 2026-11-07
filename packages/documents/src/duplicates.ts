// Duplicate invoices: the same invoice arriving twice ("northline-20418 copy.pdf"). A file with the
// same bytes is already one document (`document_sha256_key`); a copy saved again has other bytes,
// so it is known only once read: the same vendor and invoice number as a document that came first.
// A duplicate keeps its reading but starts nothing: no `document.extracted` event, so no run.

import { type ExtractedHeader, normalizeVendorName } from "@countersign/core";
import { docExtraction, document, type Tx } from "@countersign/db";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { DocumentRow } from "./store";

/** The document a duplicate repeats, as `document.meta.duplicateOf` holds it. */
export interface DuplicateOf {
  documentId: string;
  filename: string;
}

/** An invoice number on letters and digits only, upper case ("INV-20418" and "inv 20418" agree). */
export function invoiceKey(invoiceNumber: string | null | undefined): string {
  return (invoiceNumber ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The document this one repeats, from its meta; null when it is not a duplicate. */
// DECISION: no migration: the mark lives in `document.meta.duplicateOf` (jsonb, already there),
// with the original's id and file name, so lists show "Duplicate of …" without another query.
export function duplicateOfMeta(meta: unknown): DuplicateOf | null {
  const d = (meta as { duplicateOf?: unknown } | null)?.duplicateOf;
  if (!d || typeof d !== "object") return null;
  const { documentId, filename } = d as Record<string, unknown>;
  return typeof documentId === "string" && typeof filename === "string"
    ? { documentId, filename }
    : null;
}

/**
 * The document that came before `doc` with the same vendor and invoice number (any of its
 * readings), itself not a duplicate; null when there is none or the reading has no number.
 */
// DECISION: "the same invoice" is the same vendor (normalized name) and invoice number (letters
// and digits), whatever the total: a copy read a little differently is still the same invoice. The
// first to arrive is the original; ties on the time go to the smaller id.
export async function findDuplicate(
  tx: Tx,
  tenantId: string,
  doc: Pick<DocumentRow, "id" | "receivedAt">,
  header: Pick<ExtractedHeader, "vendorName" | "invoiceNumber">,
): Promise<DuplicateOf | null> {
  const key = invoiceKey(header.invoiceNumber);
  const vendor = normalizeVendorName(header.vendorName ?? "");
  if (!key || !vendor) return null;
  const rows = await tx
    .select({
      documentId: document.id,
      filename: document.filename,
      vendorName: sql<string | null>`${docExtraction.header}->>'vendorName'`,
    })
    .from(docExtraction)
    .innerJoin(
      document,
      and(eq(document.id, docExtraction.documentId), eq(document.tenantId, docExtraction.tenantId)),
    )
    .where(
      and(
        eq(docExtraction.tenantId, tenantId),
        ne(document.id, doc.id),
        or(
          lt(document.receivedAt, doc.receivedAt),
          and(eq(document.receivedAt, doc.receivedAt), lt(document.id, doc.id)),
        ),
        isNull(sql`${document.meta}->'duplicateOf'`),
        sql`upper(regexp_replace(coalesce(${docExtraction.header}->>'invoiceNumber', ''), '[^A-Za-z0-9]', '', 'g')) = ${key}`,
      ),
    )
    .orderBy(asc(document.receivedAt), asc(document.id))
    .limit(50);
  const hit = rows.find((r) => normalizeVendorName(r.vendorName ?? "") === vendor);
  return hit ? { documentId: hit.documentId, filename: hit.filename } : null;
}

/** Marks `doc` a duplicate of `of` (its meta keeps everything else). */
export async function markDuplicate(
  tx: Tx,
  tenantId: string,
  doc: Pick<DocumentRow, "id" | "meta">,
  of: DuplicateOf,
): Promise<void> {
  await tx
    .update(document)
    .set({ meta: { ...(doc.meta as Record<string, unknown>), duplicateOf: of } })
    .where(and(eq(document.id, doc.id), eq(document.tenantId, tenantId)));
}
