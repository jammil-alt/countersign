// Store (ARCHITECTURE §7): originals in object storage keyed by client and sha256, never mutated;
// one `document` row per client and sha256. A new document emits `document.received`.

import { type ContentStore, isDocumentType } from "@countersign/connectors";
import { document, type Tx } from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, eq } from "drizzle-orm";

export type DocumentRow = typeof document.$inferSelect;
export type DocumentSource = DocumentRow["source"];

export class DocumentError extends Error {
  override name = "DocumentError";
  constructor(
    readonly code: "unsupported_type" | "too_large" | "empty" | "not_found" | "not_extractable",
    message: string,
  ) {
    super(message);
  }
}

// DECISION: 32 MB per document, the Anthropic API's request limit for a PDF; Email Routing's
// 25 MB message limit is lower anyway.
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Pages in a PDF, from its page objects; null when it can't tell (or for images, 1). */
export function countPages(bytes: Uint8Array, mimeType: string): number | null {
  if (mimeType.startsWith("image/")) return 1;
  if (mimeType !== "application/pdf") return null;
  // latin1 keeps every byte as one char, so binary streams can't break the search.
  let text = "";
  for (let i = 0; i < bytes.length; i += 65536) {
    text += String.fromCharCode(...bytes.subarray(i, i + 65536));
  }
  const n = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
  return n > 0 ? n : null;
}

export interface StoreDocumentInput {
  tenantId: string;
  source: DocumentSource;
  connectionId: string | null;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  /** Who uploaded it, or a forwarded email's headers. Never a body. */
  meta?: Record<string, unknown>;
}

export interface StoredDocument {
  document: DocumentRow;
  /** False when this client already had the same bytes: the existing document is returned. */
  created: boolean;
}

/**
 * Stores the bytes once (per client and sha256) and the document row once. A repeat gives back
 * the first document unchanged. Runs in the caller's transaction, which also gets the event.
 */
export async function storeDocument(
  tx: Tx,
  content: ContentStore,
  input: StoreDocumentInput,
): Promise<StoredDocument> {
  if (input.bytes.length === 0) throw new DocumentError("empty", "the file is empty");
  if (input.bytes.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentError("too_large", "documents can be at most 32 MB");
  }
  if (!isDocumentType(input.mimeType)) {
    throw new DocumentError(
      "unsupported_type",
      "documents are PDFs or images (PNG, JPEG, GIF, WebP)",
    );
  }
  const stored = await content.put({
    tenantId: input.tenantId,
    bytes: input.bytes,
    contentType: input.mimeType,
    metadata: { filename: input.filename.slice(0, 200) },
  });
  const [row] = await tx
    .insert(document)
    .values({
      tenantId: input.tenantId,
      source: input.source,
      connectionId: input.connectionId,
      storageKey: stored.key,
      mimeType: input.mimeType,
      filename: input.filename.slice(0, 255) || "document",
      sizeBytes: input.bytes.length,
      sha256: stored.sha256,
      pageCount: countPages(input.bytes, input.mimeType),
      meta: input.meta ?? {},
    })
    .onConflictDoNothing({ target: [document.tenantId, document.sha256] })
    .returning();
  if (row) {
    await emit(tx, {
      tenantId: input.tenantId,
      type: "document.received",
      subjectId: row.id,
      payload: {
        documentId: row.id,
        source: row.source,
        filename: row.filename,
        mimeType: row.mimeType,
        sha256: row.sha256,
      },
    });
    return { document: row, created: true };
  }
  const [existing] = await tx
    .select()
    .from(document)
    .where(and(eq(document.tenantId, input.tenantId), eq(document.sha256, stored.sha256)));
  if (!existing) throw new Error("document vanished after a conflicting insert");
  return { document: existing, created: false };
}
