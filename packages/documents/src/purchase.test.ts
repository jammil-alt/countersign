// §1.104: an invoice that makes its own purchase record, against a throwaway database as cs_worker.
// A read invoice with valid totals gets its vendor (found, or added) and a purchase linked to it,
// once; a purchase already here (vendor, total, date) is linked instead; an unread, unbalanced or
// copied invoice makes nothing; a test run writes nothing; one client's invoice never reaches
// another client's vendors or purchases (invariant 1); and a bill synced later finds the purchase
// the document made (`documentPurchaseFor`) rather than making a second one.

import { readFileSync } from "node:fs";
import { type InvoiceExtraction, InvoiceExtraction as Schema } from "@countersign/core";
import { event, transaction, vendor } from "@countersign/db";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { extractDocument } from "./extract";
import { invoicePath } from "./golden.test-helper";
import { type Client, createHarness, type Harness } from "./harness.test-helper";
import { DOCUMENT_CONNECTOR, documentPurchaseFor, recordPurchase } from "./purchase";
import { storeDocument } from "./store";

const h = await createHarness();
afterAll(() => h?.close());

const expectedOf = (stem: string) =>
  Schema.parse(JSON.parse(readFileSync(invoicePath(`${stem}.expected.json`), "utf8")));

describe.skipIf(!h)("recordPurchase", () => {
  const harness = h as Harness;
  const x = expectedOf("northline-20418");
  let clients = 0;

  async function freshClient(): Promise<Client> {
    const { tenant, withTenant } = await import("@countersign/db");
    const { ensureUploadConnection } = await import("@countersign/connectors");
    const [row] = await harness.t.db
      .insert(tenant)
      .values({ name: `Purchase shop ${++clients}` })
      .returning();
    if (!row) throw new Error("no tenant");
    const conn = await withTenant(harness.db, row.id, (tx) => ensureUploadConnection(tx, row.id));
    return { tenantId: row.id, uploadConnectionId: conn.id };
  }

  /** The golden invoice, stored and read as `extraction` says (no live model). */
  async function read(c: Client, extraction: InvoiceExtraction, file = "northline-20418.pdf") {
    const { document: doc } = await harness.as(c, (tx) =>
      storeDocument(tx, harness.content, {
        tenantId: c.tenantId,
        source: "email",
        connectionId: c.uploadConnectionId,
        bytes: new Uint8Array(readFileSync(invoicePath(file))),
        filename: file,
        mimeType: file.endsWith(".png") ? "image/png" : "application/pdf",
        meta: { email: { from: "billing@northlinepanel.com", subject: "Invoice 20418" } },
      }),
    );
    await extractDocument(
      harness.deps(
        createLlmClient({
          transport: new FakeModel([{ toolUse: { name: "record_invoice", input: extraction } }]),
        }),
      ),
      { tenantId: c.tenantId, documentId: doc.id },
    );
    return doc.id;
  }

  const record = (c: Client, documentId: string, testRun = false) =>
    harness.as(c, (tx) => recordPurchase(tx, c.tenantId, documentId, { testRun }));

  it("adds the vendor and a purchase from the invoice, linked, once", async () => {
    const C = await freshClient();
    const documentId = await read(C, x);
    const r = await record(C, documentId);
    expect(r).toMatchObject({
      status: "created",
      vendorName: "Northline Panel Supply",
      vendorCreated: true,
    });
    expect(r.sources).toEqual(expect.arrayContaining([documentId, r.transactionId]));
    const [t] = await harness.as(C, (tx) =>
      tx.select().from(transaction).where(eq(transaction.tenantId, C.tenantId)),
    );
    expect(t).toMatchObject({
      kind: "bill",
      connector: DOCUMENT_CONNECTOR,
      externalId: documentId,
      txnDate: x.header.invoiceDate,
      total: "9742.3500",
      status: "extracted",
      sourceRawRecordId: null,
    });
    expect((t?.ext as { document?: { docNumber: string } } | undefined)?.document?.docNumber).toBe(
      "20418",
    );
    // The sender's domain is remembered for the next invoice (as linking does).
    const [v] = await harness.as(C, (tx) =>
      tx.select().from(vendor).where(eq(vendor.tenantId, C.tenantId)),
    );
    expect((v?.ext as { domains?: string[] } | undefined)?.domains).toEqual(["northlinepanel.com"]);
    const created = await harness.as(C, (tx) =>
      tx
        .select()
        .from(event)
        .where(and(eq(event.tenantId, C.tenantId), eq(event.type, "transaction.created"))),
    );
    expect(created.map((e) => (e.payload as { source: string }).source)).toEqual(["document"]);

    // Again: the invoice already belongs to it.
    const again = await record(C, documentId);
    expect(again).toMatchObject({ status: "already_linked", transactionId: r.transactionId });
  });

  it("links the purchase already here instead of making another", async () => {
    const C = await freshClient();
    const synced = await harness.as(C, async (tx) => {
      const [v] = await tx
        .insert(vendor)
        .values({
          tenantId: C.tenantId,
          name: "Northline Panel Supply",
          normalizedName: "northline panel supply",
        })
        .returning();
      const [t] = await tx
        .insert(transaction)
        .values({
          tenantId: C.tenantId,
          kind: "purchase",
          connector: "upload",
          vendorId: v?.id ?? null,
          txnDate: "2026-10-30",
          total: x.total,
          externalId: "row-1",
        })
        .returning();
      return t;
    });
    const documentId = await read(C, x);
    const r = await record(C, documentId);
    expect(r).toMatchObject({ status: "linked", transactionId: synced?.id, vendorCreated: false });
    const rows = await harness.as(C, (tx) =>
      tx.select().from(transaction).where(eq(transaction.tenantId, C.tenantId)),
    );
    expect(rows).toHaveLength(1);
  });

  it("makes nothing from an invoice whose totals don't add up, or in a test run", async () => {
    const C = await freshClient();
    const off = await read(C, { ...x, total: "9999.99" });
    expect(await record(C, off)).toMatchObject({ status: "not_ready", transactionId: null });
    const D = await freshClient();
    const documentId = await read(D, x);
    const dry = await record(D, documentId, true);
    expect(dry).toMatchObject({ status: "created", transactionId: null, vendorCreated: true });
    for (const c of [C, D]) {
      const rows = await harness.as(c, (tx) =>
        tx.select().from(transaction).where(eq(transaction.tenantId, c.tenantId)),
      );
      expect(rows).toEqual([]);
    }
  });

  it("keeps each client's vendors and purchases its own", async () => {
    const C = await freshClient();
    const D = await freshClient();
    const mine = await read(C, x);
    await record(C, mine);
    const theirs = await read(D, x);
    const r = await record(D, theirs);
    // D's invoice from the same vendor adds D's own vendor and purchase: nothing of C's is found.
    expect(r).toMatchObject({ status: "created", vendorCreated: true });
    const seen = await harness.as(D, (tx) => tx.select().from(transaction));
    expect(seen.map((t) => t.tenantId)).toEqual([D.tenantId]);
    // And C's invoice is not D's to record.
    await expect(record(D, mine)).rejects.toThrow(/not found/);
  });

  it("finds the purchase a document made for the bill the tool syncs later", async () => {
    const C = await freshClient();
    const documentId = await read(C, x);
    const r = await record(C, documentId);
    const find = (o: Partial<Parameters<typeof documentPurchaseFor>[2]>) =>
      harness.as(C, (tx) =>
        documentPurchaseFor(tx, C.tenantId, {
          vendorId: r.vendorId,
          total: "9742.35",
          currency: "USD",
          txnDate: "2026-10-29",
          docNumber: "INV-20418",
          ...o,
        }),
      );
    expect((await find({}))?.id).toBe(r.transactionId);
    expect((await find({ docNumber: null }))?.id).toBe(r.transactionId);
    expect(await find({ docNumber: "20419" })).toBeNull();
    expect(await find({ total: "9742.36" })).toBeNull();
    expect(await find({ txnDate: "2026-11-15" })).toBeNull();
  });
});
