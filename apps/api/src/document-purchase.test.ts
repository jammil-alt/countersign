// §1.104: an invoice that made its own purchase record (no accounting tool yet), then the same
// bill synced from QuickBooks: the sync takes the document's purchase over (one transaction, now
// QuickBooks', its document still linked, the invoice's facts kept), rather than adding a second.
// A bill that doesn't fit (another number) is its own purchase. Client B's sync never reaches A's.

import { ContentStore, findOrCreateVendor } from "@countersign/connectors";
import {
  connection,
  docExtraction,
  document,
  event,
  transaction,
  withTenant,
} from "@countersign/db";
import { recordPurchase } from "@countersign/documents";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness } from "./api.test-helper";
import { storeQboPage } from "./qbo/store";

const h = await createApiHarness();
afterAll(() => h?.close());

function bill(id: string, docNumber: string, total: number) {
  return {
    entityType: "Bill",
    externalId: id,
    externalVersion: "0",
    payload: {
      Id: id,
      SyncToken: "0",
      CurrencyRef: { value: "USD" },
      TxnDate: "2026-10-29",
      DocNumber: docNumber,
      TotalAmt: total,
      VendorRef: { value: "57", name: "Northline Panel Supply" },
      Line: [
        {
          Id: "1",
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: total,
          AccountBasedExpenseLineDetail: { AccountRef: { value: "7", name: "Materials" } },
        },
      ],
    },
  };
}

describe.skipIf(!h)("a document's purchase, then the bill from QuickBooks", () => {
  const H = h as ApiHarness;

  /** An emailed invoice from Northline, read with totals that add up. */
  async function invoice(tenantId: string, sha: string) {
    const [d] = await H.t.db
      .insert(document)
      .values({
        tenantId,
        source: "email",
        storageKey: `tenants/${tenantId}/content/${sha.slice(0, 2)}/${sha}`,
        mimeType: "application/pdf",
        filename: "northline-20418.pdf",
        sizeBytes: 10,
        sha256: sha,
        status: "extracted",
      })
      .returning();
    if (!d) throw new Error("no document");
    await H.t.db.insert(docExtraction).values({
      tenantId,
      documentId: d.id,
      model: "test-model",
      header: {
        vendorName: "Northline Panel Supply",
        invoiceNumber: "20418",
        invoiceDate: "2026-10-28",
        dueDate: "2026-11-27",
        currency: "USD",
      },
      subtotal: "9742.35",
      total: "9742.35",
      linesSum: "9742.35",
      totalsMatch: true,
    });
    return d.id;
  }

  async function qbo(tenantId: string) {
    const [row] = await H.t.db
      .insert(connection)
      .values({ tenantId, connector: "qbo", status: "connected", externalAccountId: tenantId })
      .returning();
    if (!row) throw new Error("no connection");
    return row.id;
  }

  const sync = (tenantId: string, connectionId: string, records: ReturnType<typeof bill>[]) =>
    withTenant(H.db, tenantId, (tx) =>
      storeQboPage(tx, new ContentStore(H.objects), {
        tenantId,
        connectionId,
        records,
        files: new Map(),
        cursor: {},
        initial: false,
        now: new Date("2026-11-15T12:00:00Z"),
      }),
    );

  it("takes the document's purchase over, and keeps a bill that doesn't fit apart", async () => {
    const A = H.A.tenantId;
    const documentId = await invoice(A, "a".repeat(64));
    const made = await withTenant(H.db, A, async (tx) => {
      await findOrCreateVendor(tx, A, "Northline Panel Supply");
      return recordPurchase(tx, A, documentId);
    });
    expect(made.status).toBe("created");

    // B has its own QuickBooks and the same bill: it never touches A's purchase.
    await sync(H.B.tenantId, await qbo(H.B.tenantId), [bill("147", "20418", 9742.35)]);
    const connectionId = await qbo(A);
    const r = await sync(A, connectionId, [bill("147", "20418", 9742.35)]);
    expect(r.transactions).toEqual({ created: 0, updated: 1 });
    const rows = await withTenant(H.db, A, (tx) =>
      tx.select().from(transaction).where(eq(transaction.tenantId, A)),
    );
    expect(rows).toHaveLength(1);
    const [t] = rows;
    expect(t).toMatchObject({
      id: made.transactionId,
      connector: "qbo",
      externalId: "Bill:147",
      total: "9742.3500",
      txnDate: "2026-10-29",
    });
    expect(t?.sourceRawRecordId).not.toBeNull();
    const ext = t?.ext as { document?: { id: string }; qbo?: { docNumber: string } };
    expect(ext.document?.id).toBe(documentId);
    expect(ext.qbo?.docNumber).toBe("20418");
    const [doc] = await H.t.db.select().from(document).where(eq(document.id, documentId));
    expect(doc?.transactionId).toBe(made.transactionId);
    const updated = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, A), eq(event.subjectId, made.transactionId as string)));
    expect(updated.map((e) => e.type)).toContain("transaction.updated");

    // Another bill with another number is a purchase of its own.
    const other = await sync(A, connectionId, [bill("148", "20500", 9742.35)]);
    expect(other.transactions).toEqual({ created: 1, updated: 0 });
  });
});
