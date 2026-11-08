// Stored documents for connector calls (ConnectorServices.documents): a tool that sends one of the
// client's documents to the client's tool (QuickBooks' attachment upload) reads it here, scoped to
// the connection's client, so a document id from another client reads as unknown.

import {
  type ConnectionRef,
  type ContentStore,
  type DocumentServices,
  SIGNED_URL_TTL_SECONDS,
  type UrlSigner,
} from "@countersign/connectors";
import { type Db, document, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";

export function dbDocumentServices(
  db: Db,
  conn: Pick<ConnectionRef, "tenantId">,
  content: ContentStore,
  // P-3: attachments both ways (docs/plan.md §1.65): 5-minute links for Twilio and Meta.
  signer?: UrlSigner | null,
): DocumentServices {
  const row = async (documentId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return null;
    return withTenant(db, conn.tenantId, async (tx) => {
      const [r] = await tx
        .select()
        .from(document)
        .where(and(eq(document.id, documentId), eq(document.tenantId, conn.tenantId)));
      return r ?? null;
    });
  };
  return {
    async read(documentId) {
      const r = await row(documentId);
      if (!r) return null;
      const stored = await content.get(conn.tenantId, r.sha256);
      if (!stored) return null;
      return {
        id: r.id,
        bytes: stored.bytes,
        filename: r.filename,
        mimeType: r.mimeType,
        sha256: r.sha256,
      };
    },
    // P-3
    async describe(documentId) {
      const r = await row(documentId);
      return r
        ? { id: r.id, filename: r.filename, mimeType: r.mimeType, sizeBytes: r.sizeBytes }
        : null;
    },
    ...(signer
      ? {
          async signedUrl(documentId: string) {
            const r = await row(documentId);
            if (!r) return null;
            // DECISION (plan §1.65): the same 5-minute link the documents pages use; the
            // provider fetches the file when it sends the message.
            return signer.signedGetUrl(r.storageKey, { expiresInSeconds: SIGNED_URL_TTL_SECONDS });
          },
        }
      : {}),
  };
}
