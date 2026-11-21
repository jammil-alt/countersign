// Table files as documents (docs/plan.md §1.164): what Read table reads and Write table makes. A
// table document's bytes are read here for code (never for a model: `readingFile` refuses them),
// and a file Write table made is stored as the client's document, source `generated`, quietly (no
// `document.received`: it is ours, not something that came in to be read), naming the documents
// it was made from.

import { type ContentStore, isDocumentType } from "@countersign/connectors";
import { isTableType, processes } from "@countersign/core";
import { type Db, document, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { DocumentError, storeDocument } from "./store";

export interface TableFile {
  documentId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

const MB = Math.round(processes.TABLE_MAX_BYTES / (1024 * 1024));

/**
 * A client's table document (.csv, .xlsx, .json), whole, for Read table. Refuses another type
 * and a file over the 5 MB limit, saying so.
 */
export async function tableFile(
  deps: { db: Db; content: ContentStore },
  tenantId: string,
  documentId: string,
): Promise<TableFile> {
  const doc = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(document)
      .where(and(eq(document.id, documentId), eq(document.tenantId, tenantId)))
      .limit(1);
    return row ?? null;
  });
  if (!doc) throw new DocumentError("not_found", `document ${documentId} not found`);
  if (!isTableType(doc.mimeType)) {
    throw new DocumentError(
      "unsupported_type",
      `${doc.filename} is not a table: Read table reads .csv, .xlsx and .json files`,
    );
  }
  if (doc.sizeBytes > processes.TABLE_MAX_BYTES) {
    throw new DocumentError(
      "too_large",
      `${doc.filename} is over ${MB} MB; we read files of at most ${MB} MB`,
    );
  }
  const stored = await deps.content.get(tenantId, doc.sha256);
  if (!stored) throw new DocumentError("not_found", "the document's file is missing");
  return {
    documentId: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    bytes: stored.bytes,
  };
}

/**
 * Stores a table file a step made as the client's document (source `generated`, no event): once
 * per client and sha256, so the same rows written twice are one document. `meta.sources` names the
 * documents it was made from (invariant 10).
 */
export async function storeTableFile(
  deps: { db: Db; content: ContentStore },
  input: {
    tenantId: string;
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
    sources: readonly string[];
    agentVersionId: string;
    runId: string;
    testRun: boolean;
  },
): Promise<{ documentId: string; created: boolean }> {
  if (!isTableType(input.mimeType)) {
    throw new DocumentError("unsupported_type", `a ${input.mimeType} file is not a table`);
  }
  return withTenant(deps.db, input.tenantId, async (tx) => {
    const stored = await storeDocument(tx, deps.content, {
      tenantId: input.tenantId,
      source: "generated",
      connectionId: null,
      bytes: input.bytes,
      filename: input.filename,
      mimeType: input.mimeType,
      allowType: isDocumentType,
      announce: false,
      meta: {
        kind: "table",
        sources: [...input.sources],
        agentVersionId: input.agentVersionId,
        runId: input.runId,
        ...(input.testRun ? { testRun: true } : {}),
      },
    });
    return { documentId: stored.document.id, created: stored.created };
  });
}
