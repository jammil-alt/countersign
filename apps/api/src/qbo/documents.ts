// Stored documents for connector calls (ConnectorServices.documents): a tool that sends one of the
// client's documents to the client's tool (QuickBooks' attachment upload) reads it here, scoped to
// the connection's client, so a document id from another client reads as unknown.

import type { ConnectionRef, ContentStore, DocumentServices } from "@countersign/connectors";
import { type Db, document, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";

export function dbDocumentServices(
  db: Db,
  conn: Pick<ConnectionRef, "tenantId">,
  content: ContentStore,
): DocumentServices {
  return {
    async read(documentId) {
      if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;
      const row = await withTenant(db, conn.tenantId, async (tx) => {
        const [r] = await tx
          .select()
          .from(document)
          .where(and(eq(document.id, documentId), eq(document.tenantId, conn.tenantId)));
        return r;
      });
      if (!row) return null;
      const stored = await content.get(conn.tenantId, row.sha256);
      if (!stored) return null;
      return {
        id: row.id,
        bytes: stored.bytes,
        filename: row.filename,
        mimeType: row.mimeType,
        sha256: row.sha256,
      };
    },
  };
}
