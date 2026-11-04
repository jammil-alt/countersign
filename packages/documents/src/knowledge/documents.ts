// A client's documents in the knowledge base: each document's name, where it came from and its
// latest extraction (header and lines), as searchable passages. What a document says is untrusted
// text: it is stored here as data and reaches models only inside tool results (invariant 9).

import { docExtraction, docLine, document, knowledgeChunk, type Tx } from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { chunkText } from "./chunk";
import { tenantSearchConfig } from "./entries";

/** Documents (re)indexed per call, so one search never does unbounded work. */
export const INDEX_BATCH = 50;

interface Pending {
  id: string;
  filename: string;
  source: string;
  meta: Record<string, unknown>;
  receivedAt: Date;
  extractionId: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// The outer document row, qualified: Drizzle leaves columns of a single-table select unqualified,
// which inside these subqueries would name the subquery's own columns.
const DOC_TENANT = sql.raw(`"document"."tenant_id"`);
const DOC_ID = sql.raw(`"document"."id"`);

/** The latest extraction of each document (null when not read yet), as SQL. */
const latestExtractionId = sql<string | null>`(
  select e.id from ${docExtraction} e
  where e.tenant_id = ${DOC_TENANT} and e.document_id = ${DOC_ID}
  order by e.created_at desc, e.id desc limit 1)`;

/** Documents whose passages are missing or come from an older extraction. */
async function pendingDocuments(tx: Tx, tenantId: string, limit: number): Promise<Pending[]> {
  const rows = await tx
    .select({
      id: document.id,
      filename: document.filename,
      source: document.source,
      meta: document.meta,
      receivedAt: document.receivedAt,
      extractionId: latestExtractionId,
    })
    .from(document)
    .where(
      and(
        eq(document.tenantId, tenantId),
        sql`not exists (
          select 1 from ${knowledgeChunk} c
          where c.tenant_id = ${DOC_TENANT} and c.document_id = ${DOC_ID}
            and c.extraction_id is not distinct from ${latestExtractionId})`,
      ),
    )
    .orderBy(desc(document.receivedAt), desc(document.id))
    .limit(limit);
  return rows.map((r) => ({ ...r, meta: (r.meta ?? {}) as Record<string, unknown> }));
}

/** A document's title and passages, from its name, its email headers and its latest reading. */
async function documentText(
  tx: Tx,
  tenantId: string,
  doc: Pending,
): Promise<{ title: string; passages: string[] }> {
  const parts: string[] = [
    `File ${doc.filename}, received ${doc.receivedAt.toISOString().slice(0, 10)} (${doc.source}).`,
  ];
  const subject = str(doc.meta.subject);
  const from = str(doc.meta.from);
  if (subject) parts.push(`Email subject: ${subject}.`);
  if (from) parts.push(`From: ${from}.`);
  let title = doc.filename;
  const lines: string[] = [];
  if (doc.extractionId) {
    const [x] = await tx
      .select()
      .from(docExtraction)
      .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.id, doc.extractionId)));
    if (x) {
      const h = (x.header ?? {}) as Record<string, unknown>;
      const vendor = str(h.vendorName);
      const number = str(h.invoiceNumber);
      const date = str(h.invoiceDate);
      const po = str(h.poNumber);
      if (vendor && number) title = `Invoice ${number} from ${vendor}`;
      else if (vendor) title = `${vendor}: ${doc.filename}`;
      parts.push(
        [
          vendor ? `Vendor: ${vendor}.` : "",
          number ? `Invoice number: ${number}.` : "",
          date ? `Invoice date: ${date}.` : "",
          po ? `PO: ${po}.` : "",
          `Total: ${x.total} ${x.currency}.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const rows = await tx
        .select()
        .from(docLine)
        .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, x.id)))
        .orderBy(asc(docLine.lineNo));
      for (const l of rows) {
        lines.push(
          [
            `Line ${l.lineNo}:`,
            l.vendorSku ? `${l.vendorSku}` : "",
            l.rawDescription,
            `— ${l.qty}${l.uomRaw ? ` ${l.uomRaw}` : ""} at ${l.unitPrice}, ${l.extPrice}.`,
          ]
            .filter(Boolean)
            .join(" "),
        );
      }
    }
  }
  // One line per paragraph, so passages break between lines, not inside them.
  const passages = chunkText([parts.join(" "), ...lines].join("\n\n"));
  return { title, passages };
}

/**
 * Indexes the client's documents that are new or were read again since they were indexed, up to
 * `limit` per call. Returns how many were indexed.
 */
// DECISION: documents are indexed lazily, before each knowledge read (search, the Knowledge tab),
// rather than from the extraction path: packages/documents' store and extract stay as they are,
// and a document read before the knowledge base existed is indexed the first time anyone looks.
export async function indexDocuments(
  tx: Tx,
  tenantId: string,
  options: { limit?: number } = {},
): Promise<number> {
  const pending = await pendingDocuments(tx, tenantId, options.limit ?? INDEX_BATCH);
  if (pending.length === 0) return 0;
  const config = await tenantSearchConfig(tx, tenantId);
  await tx.delete(knowledgeChunk).where(
    and(
      eq(knowledgeChunk.tenantId, tenantId),
      inArray(
        knowledgeChunk.documentId,
        pending.map((d) => d.id),
      ),
    ),
  );
  for (const doc of pending) {
    const { title, passages } = await documentText(tx, tenantId, doc);
    await tx.insert(knowledgeChunk).values(
      passages.map((body, chunkNo) => ({
        tenantId,
        sourceType: "document" as const,
        documentId: doc.id,
        extractionId: doc.extractionId,
        chunkNo,
        title,
        body,
        config,
        tsv: sql`setweight(to_tsvector(${config}::regconfig, ${title}), 'A') || setweight(to_tsvector(${config}::regconfig, ${body}), 'B')`,
      })),
    );
  }
  return pending.length;
}

export interface IndexedDocumentView {
  id: string;
  filename: string;
  source: string;
  status: string;
  receivedAt: Date;
  /** The extraction its passages were read from, if any. */
  extractionId: string | null;
  title: string | null;
  passages: number;
  /** Indexed from its latest extraction (or from its name, when it has none yet). */
  indexed: boolean;
}

/** The client's documents, newest first, with what the knowledge base holds of each. */
export async function indexedDocuments(
  tx: Tx,
  tenantId: string,
  options: { limit?: number } = {},
): Promise<IndexedDocumentView[]> {
  const rows = await tx
    .select({
      id: document.id,
      filename: document.filename,
      source: document.source,
      status: document.status,
      receivedAt: document.receivedAt,
      latest: latestExtractionId,
      extractionId: sql<string | null>`(select c.extraction_id from ${knowledgeChunk} c
        where c.tenant_id = ${DOC_TENANT} and c.document_id = ${DOC_ID} limit 1)`,
      title: sql<string | null>`(select c.title from ${knowledgeChunk} c
        where c.tenant_id = ${DOC_TENANT} and c.document_id = ${DOC_ID}
        order by c.chunk_no limit 1)`,
      passages: sql<number>`(select count(*)::int from ${knowledgeChunk} c
        where c.tenant_id = ${DOC_TENANT} and c.document_id = ${DOC_ID})`,
    })
    .from(document)
    .where(eq(document.tenantId, tenantId))
    .orderBy(desc(document.receivedAt), desc(document.id))
    .limit(options.limit ?? 200);
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    source: r.source,
    status: r.status,
    receivedAt: r.receivedAt,
    extractionId: r.extractionId,
    title: r.title,
    passages: Number(r.passages),
    indexed: Number(r.passages) > 0 && r.extractionId === r.latest,
  }));
}
