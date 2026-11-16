// Mezonas's copy of QuickBooks bills (the price checker's step 2, owner 2026-11-11). The QuickBooks
// sync already brings every bill and its attachments in, every 15 minutes and once each; this only
// finds, for bills read from QuickBooks, the transaction the sync stored and its documents.

import { QBO_CONNECTOR_ID, qboTransactionExternalId } from "@countersign/core";
import { document, type Tx, transaction } from "@countersign/db";
import { and, eq, inArray } from "drizzle-orm";

export interface QboBillCopy {
  /** The bill's id in QuickBooks, as read. */
  qboId: string;
  /** "in": the sync has stored it; "not_yet": it hasn't (it syncs within 15 minutes). */
  status: "in" | "not_yet";
  transactionId: string | null;
  /** Its attachments, stored as documents; empty when it has none. */
  documentIds: string[];
}

export async function findQboBills(
  tx: Tx,
  tenantId: string,
  qboIds: readonly string[],
): Promise<QboBillCopy[]> {
  const ids = [...new Set(qboIds)];
  if (ids.length === 0) return [];
  const externalIds = ids.map((id) => qboTransactionExternalId("Bill", id));
  const txns = await tx
    .select({ id: transaction.id, externalId: transaction.externalId })
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.connector, QBO_CONNECTOR_ID),
        inArray(transaction.externalId, externalIds),
      ),
    );
  const byExternal = new Map(txns.map((t) => [t.externalId, t.id]));
  const docs = txns.length
    ? await tx
        .select({ id: document.id, transactionId: document.transactionId })
        .from(document)
        .where(
          and(
            eq(document.tenantId, tenantId),
            inArray(
              document.transactionId,
              txns.map((t) => t.id),
            ),
          ),
        )
    : [];
  return ids.map((qboId) => {
    const transactionId = byExternal.get(qboTransactionExternalId("Bill", qboId)) ?? null;
    return {
      qboId,
      status: transactionId ? "in" : "not_yet",
      transactionId,
      documentIds: transactionId
        ? docs.filter((d) => d.transactionId === transactionId).map((d) => d.id)
        : [],
    };
  });
}
