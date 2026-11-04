// A document with its latest extraction and lines: what `docs.get` and `GET /api/documents/:id`
// answer (with a signed URL added by the caller).

import { docLine, document, type Tx } from "@countersign/db";
import { and, asc, eq } from "drizzle-orm";
import { type ExtractionRow, latestExtraction } from "./link";
import type { DocumentRow } from "./store";

export type DocLineRow = typeof docLine.$inferSelect;

export interface DocumentView {
  document: DocumentRow;
  extraction: (ExtractionRow & { lines: DocLineRow[] }) | null;
}

export async function getDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<DocumentView | null> {
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, documentId), eq(document.tenantId, tenantId)));
  if (!doc) return null;
  const x = await latestExtraction(tx, tenantId, doc.id);
  if (!x) return { document: doc, extraction: null };
  const lines = await tx
    .select()
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, x.id)))
    .orderBy(asc(docLine.lineNo));
  return { document: doc, extraction: { ...x, lines } };
}
