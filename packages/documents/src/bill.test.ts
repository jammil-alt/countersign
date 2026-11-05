// Bills behind invoices (docs/plan.md §1.30, "Bill clerk"): the match over synced bills (vendor,
// currency and total to the cent, date window, document number, deletions, one client only), the
// plan from the bill as the tool has it now, and the new lines built from the invoice with only
// the item or account chosen from outside.

import { readFileSync } from "node:fs";
import { type InvoiceExtraction, InvoiceExtraction as Schema } from "@countersign/core";
import { transaction, vendor } from "@countersign/db";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  BillLinesError,
  billLines,
  docNumbersAgree,
  type InvoiceForBill,
  matchBill,
  planBill,
  type ToolBill,
} from "./bill";
import { extractDocument } from "./extract";
import { invoicePath } from "./golden.test-helper";
import { type Client, createHarness, type Harness } from "./harness.test-helper";
import { shiftDate } from "./link";
import { storeDocument } from "./store";

const expectedOf = (stem: string) =>
  Schema.parse(JSON.parse(readFileSync(invoicePath(`${stem}.expected.json`), "utf8")));

// ── Pure: the plan and the lines ─────────────────────────────────────────────────────────────────

const invoice = (over: Partial<InvoiceForBill> = {}): InvoiceForBill => ({
  documentId: "doc-1",
  extractionId: "x-1",
  source: "upload",
  transactionId: null,
  header: { vendorName: "Northline Panel Supply", invoiceNumber: "20418", poNumber: "J-1182" },
  total: "300.0000",
  lines: [
    {
      lineNo: 1,
      description: "Birch 3/4",
      qty: "2.0000",
      unitPrice: "100.0000",
      extPrice: "200.0000",
    },
    {
      lineNo: 2,
      description: "Edge banding",
      qty: "1.0000",
      unitPrice: "37.5000",
      extPrice: "100.0000",
    },
  ],
  ...over,
});

const toolBill = (over: Partial<ToolBill> = {}): ToolBill => ({
  id: "150",
  syncToken: "3",
  docNumber: "20418",
  vendor: { id: "60", name: "Northline Panel Supply" },
  total: "300.0000",
  currency: "USD",
  memo: null,
  tax: null,
  lines: [
    { id: "1", amount: "300.0000", account: { id: "80", name: "Job Materials" }, item: null },
  ],
  ...over,
});

describe("planBill", () => {
  it("itemizes a one-line bill whose total the invoice's lines add up to", () => {
    expect(planBill(invoice(), toolBill())).toMatchObject({
      decision: "itemize",
      invoiceLineCount: 2,
      billLineCount: 1,
      lineTotal: "300.00",
      billTotal: "300.00",
      attach: true,
      setMemo: true,
      memo: "Northline Panel Supply invoice 20418, PO J-1182",
      billNumber: "20418",
    });
  });

  it("leaves a bill that already has its lines, and keeps an existing memo", () => {
    const two = toolBill({
      memo: "Shop stock",
      lines: [
        { id: "1", amount: "200.0000", account: { id: "80", name: null }, item: null },
        { id: "2", amount: "100.0000", account: { id: "80", name: null }, item: null },
      ],
    });
    expect(planBill(invoice(), two)).toMatchObject({ decision: "nothing_to_do", setMemo: false });
  });

  it("sends anything else to a person, with the reason", () => {
    const cases: [InvoiceForBill, ToolBill | null, RegExp][] = [
      [invoice(), null, /no longer in QuickBooks/],
      [invoice(), toolBill({ total: "301.0000" }), /total is 301\.00 now/],
      [invoice(), toolBill({ tax: "12.0000" }), /has tax/],
      [
        invoice({ total: "320.0000" }),
        toolBill({
          total: "320.0000",
          lines: [{ id: "1", amount: "320.0000", account: null, item: null }],
        }),
        /add up to 300\.00 and the bill to 320\.00/,
      ],
      [
        invoice({
          lines: [
            { lineNo: 1, description: "a", qty: "1", unitPrice: "320", extPrice: "320.0000" },
            { lineNo: 2, description: "credit", qty: "1", unitPrice: "-20", extPrice: "-20.0000" },
          ],
        }),
        toolBill(),
        /Line 2 of the invoice is a credit/,
      ],
      [
        invoice(),
        toolBill({ lines: [{ id: null, amount: "300", account: null, item: null }] }),
        /no id/,
      ],
    ];
    for (const [inv, b, reason] of cases) {
      const plan = planBill(inv, b);
      expect(plan.decision, String(reason)).toBe("needs_person");
      expect(plan.reason).toMatch(reason);
    }
  });

  it("doesn't attach the bill's own attachment again", () => {
    const own = invoice({ source: "connector", transactionId: "txn-1" });
    expect(planBill(own, toolBill()).attach).toBe(false);
  });
});

describe("billLines", () => {
  it("takes every amount from the invoice and only the place from the choices", () => {
    const change = billLines(invoice(), toolBill(), [
      { lineNo: 1, itemId: "21" },
      { lineNo: 2, accountId: "80" },
    ]);
    expect(change).toEqual({
      id: "150",
      syncToken: "3",
      expectedTotal: "300.00",
      currency: "USD",
      replaceLineIds: ["1"],
      lines: [
        { itemId: "21", description: "Birch 3/4", qty: "2", unitPrice: "100", amount: "200.00" },
        { accountId: "80", description: "Edge banding", amount: "100.00" },
      ],
    });
  });

  it("refuses a choice that is missing, repeated, unknown, off the bill or not qty × price", () => {
    const bad: [Parameters<typeof billLines>[2], RegExp][] = [
      [[{ lineNo: 1, itemId: "21" }], /line 2 has no item or account/],
      [
        [
          { lineNo: 1, itemId: "21" },
          { lineNo: 1, itemId: "22" },
        ],
        /chosen twice/,
      ],
      [[{ lineNo: 3, itemId: "21" }], /no line 3/],
      [
        [
          { lineNo: 1, itemId: "21", accountId: "80" },
          { lineNo: 2, accountId: "80" },
        ],
        /exactly one/,
      ],
      [
        [
          { lineNo: 1, accountId: "99" },
          { lineNo: 2, accountId: "80" },
        ],
        /account 99 is not on the bill/,
      ],
      [
        [
          { lineNo: 1, itemId: "21" },
          { lineNo: 2, itemId: "23" },
        ],
        /line 2: its amount 100\.00 is not its quantity times its unit price/,
      ],
    ];
    for (const [choices, message] of bad) {
      expect(() => billLines(invoice(), toolBill(), choices)).toThrow(message);
    }
    expect(() => billLines(invoice(), toolBill({ tax: "1" }), [])).toThrow(BillLinesError);
  });
});

describe("docNumbersAgree", () => {
  it("compares letters and digits, allows a prefix, and never rules out a bill with no number", () => {
    expect(docNumbersAgree("20418", "20418")).toBe(true);
    expect(docNumbersAgree("INV-20418", "20418")).toBe(true);
    expect(docNumbersAgree("cr 7731", "CR-7731")).toBe(true);
    expect(docNumbersAgree("20418", null)).toBe(true);
    expect(docNumbersAgree("20418", "20419")).toBe(false);
  });
});

// ── The match, over synced bills ────────────────────────────────────────────────────────────────

const h = await createHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("matchBill", () => {
  const harness = h as Harness;
  const x = expectedOf("northline-20418");

  async function freshClient(name: string): Promise<Client> {
    const { tenant, withTenant } = await import("@countersign/db");
    const { ensureUploadConnection } = await import("@countersign/connectors");
    const [row] = await harness.t.db.insert(tenant).values({ name }).returning();
    if (!row) throw new Error("no tenant");
    const conn = await withTenant(harness.db, row.id, (tx) => ensureUploadConnection(tx, row.id));
    return { tenantId: row.id, uploadConnectionId: conn.id };
  }

  async function read(c: Client, extraction: InvoiceExtraction) {
    const { document: doc } = await harness.as(c, (tx) =>
      storeDocument(tx, harness.content, {
        tenantId: c.tenantId,
        source: "upload",
        connectionId: c.uploadConnectionId,
        bytes: new Uint8Array(readFileSync(invoicePath("northline-20418.pdf"))),
        filename: "northline-20418.pdf",
        mimeType: "application/pdf",
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

  /** A bill synced from QuickBooks, as the mapper stores it. */
  async function syncedBill(
    c: Client,
    id: string,
    o: { vendor?: string; total?: string; date?: string; doc?: string | null; deleted?: boolean },
  ) {
    return harness.as(c, async (tx) => {
      const name = o.vendor ?? "Northline Panel Supply";
      const key = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      await tx
        .insert(vendor)
        .values({ tenantId: c.tenantId, name, normalizedName: key })
        .onConflictDoNothing();
      const [v] = await tx
        .select()
        .from(vendor)
        .where(and(eq(vendor.tenantId, c.tenantId), eq(vendor.normalizedName, key)));
      const [row] = await tx
        .insert(transaction)
        .values({
          tenantId: c.tenantId,
          kind: "bill",
          connector: "qbo",
          vendorId: v?.id ?? null,
          txnDate: o.date ?? x.header.invoiceDate,
          total: o.total ?? x.total,
          externalId: `Bill:${id}`,
          ext: {
            qbo: {
              entity: "Bill",
              id,
              docNumber: o.doc === undefined ? x.header.invoiceNumber : o.doc,
              ...(o.deleted ? { deleted: true } : {}),
            },
          },
        })
        .returning();
      if (!row) throw new Error("no transaction");
      return row;
    });
  }

  const match = (c: Client, documentId: string) =>
    harness.as(c, (tx) => matchBill(tx, c.tenantId, { documentId, connector: "qbo" }));

  it("finds the one bill of the same vendor, total, number and dates", async () => {
    const C = await freshClient("Match shop");
    const documentId = await read(C, x);
    const b = await syncedBill(C, "150", { date: shiftDate(x.header.invoiceDate, 7) });
    // Bills that don't fit: past the window, another total, another number, deleted, another vendor.
    await syncedBill(C, "151", { date: shiftDate(x.header.invoiceDate, 8) });
    await syncedBill(C, "152", { total: "9742.34" });
    await syncedBill(C, "153", { doc: "20419" });
    await syncedBill(C, "154", { deleted: true });
    await syncedBill(C, "155", { vendor: "Cedar Ridge Hardwoods" });
    const r = await match(C, documentId);
    expect(r).toMatchObject({
      status: "matched",
      invoice: { documentId, number: "20418", total: "9742.3500", currency: "USD" },
      bill: { transactionId: b.id, recordId: "150", docNumber: "20418", total: "9742.3500" },
      candidates: [b.id],
    });
    expect(r.sources).toEqual([documentId, r.invoice.extractionId, b.id]);
  });

  it("names the vendor's other bills when none fits, and both when two do", async () => {
    const C = await freshClient("Two bills shop");
    const documentId = await read(C, x);
    const off = await syncedBill(C, "160", { total: "9700.00" });
    const none = await match(C, documentId);
    expect(none).toMatchObject({ status: "none", bill: null, candidates: [off.id] });
    expect(none.reason).toMatch(/^No bill from Northline Panel Supply for USD 9742\.35/);
    expect(none.sources).toContain(off.id);

    const a = await syncedBill(C, "161", { doc: null });
    const b = await syncedBill(C, "162", { doc: null, date: shiftDate(x.header.invoiceDate, 1) });
    const two = await match(C, documentId);
    expect(two).toMatchObject({ status: "ambiguous", bill: null, candidates: [a.id, b.id] });
    // The same number settles it.
    const same = await syncedBill(C, "163", {});
    expect(await match(C, documentId)).toMatchObject({
      status: "matched",
      bill: { transactionId: same.id },
    });
  });

  it("matches nothing for a vendor it doesn't know, and nothing of another client", async () => {
    const C = await freshClient("Unknown vendor shop");
    const D = await freshClient("Other client");
    const documentId = await read(C, x);
    await syncedBill(D, "170", {});
    const r = await match(C, documentId);
    expect(r).toMatchObject({ status: "none", candidates: [] });
    expect(r.reason).toBe("No vendor in your records is named Northline Panel Supply.");
    await expect(match(D, documentId)).rejects.toThrow(/not found/);
  });
});
