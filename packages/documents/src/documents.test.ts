import { readFileSync } from "node:fs";
import { type InvoiceExtraction, InvoiceExtraction as Schema } from "@countersign/core";
import {
  docExtraction,
  docLine,
  document,
  event,
  inboxItem,
  transaction,
  vendor,
} from "@countersign/db";
import { createLlmClient, FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";
import { extractDocument } from "./extract";
import { findSupport } from "./find-support";
import { getDocument } from "./get";
import { GOLDEN_INVOICES, goldenProblems, invoicePath } from "./golden.test-helper";
import { type Client, createHarness, type Harness } from "./harness.test-helper";
import { linkToTransaction, shiftDate } from "./link";
import { PDF_PAGES_PER_CALL } from "./split";
import { countPages, DocumentError, storeDocument } from "./store";

const h = await createHarness();
afterAll(() => h?.close());

const read = (name: string) => new Uint8Array(readFileSync(invoicePath(name)));
const expectedOf = (stem: string) =>
  Schema.parse(JSON.parse(readFileSync(invoicePath(`${stem}.expected.json`), "utf8")));

async function store(
  c: Client,
  file: string,
  mimeType: string,
  source: "upload" | "email" = "upload",
  meta = {},
) {
  const harness = h as Harness;
  return harness.as(c, (tx) =>
    storeDocument(tx, harness.content, {
      tenantId: c.tenantId,
      source,
      connectionId: c.uploadConnectionId,
      bytes: read(file),
      filename: file,
      mimeType,
      meta,
    }),
  );
}

/** A model that answers once with this extraction. */
function answering(x: InvoiceExtraction) {
  return createLlmClient({
    transport: new FakeModel([{ toolUse: { name: "record_invoice", input: x } }]),
  });
}

async function addTransaction(c: Client, vendorName: string, total: string, txnDate: string) {
  const harness = h as Harness;
  return harness.as(c, async (tx) => {
    const key = vendorName
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    await tx
      .insert(vendor)
      .values({ tenantId: c.tenantId, name: vendorName, normalizedName: key })
      .onConflictDoNothing();
    const [v] = await tx
      .select()
      .from(vendor)
      .where(and(eq(vendor.tenantId, c.tenantId), eq(vendor.normalizedName, key)));
    const [row] = await tx
      .insert(transaction)
      .values({
        tenantId: c.tenantId,
        kind: "purchase",
        connector: "upload",
        vendorId: v?.id ?? null,
        txnDate,
        total,
        externalId: crypto.randomUUID(),
      })
      .returning();
    if (!row) throw new Error("no transaction");
    return row;
  });
}

describe.skipIf(!h)("documents", () => {
  const harness = h as Harness;
  const { A, B } = harness;

  describe("golden extraction (replay)", () => {
    for (const inv of GOLDEN_INVOICES) {
      it(`${inv.stem} matches its expected JSON within tolerance`, async () => {
        const { document: doc } = await store(A, inv.file, inv.mimeType);
        const r = await extractDocument(harness.deps(), {
          tenantId: A.tenantId,
          documentId: doc.id,
        });
        expect(goldenProblems(r.extraction, expectedOf(inv.stem))).toEqual([]);
        expect(r.status).toBe("extracted");
        expect(r.totalsMatch).toBe(true);
        const view = await harness.as(A, (tx) => getDocument(tx, A.tenantId, doc.id));
        expect(view?.document.status).toBe("extracted");
        expect(view?.extraction?.lines).toHaveLength(expectedOf(inv.stem).lines.length);
        expect(view?.extraction?.total).toBe(`${expectedOf(inv.stem).total}00`);
        expect(view?.document.pageCount).toBe(expectedOf(inv.stem).header.pageCount);
      });
    }

    it("sends a PDF as a document block and an image as an image block, never in the system prompt", async () => {
      const model = new FakeModel([
        { toolUse: { name: "record_invoice", input: expectedOf("cedar-ridge-7731") } },
      ]);
      const { document: doc } = await store(B, "cedar-ridge-7731.png", "image/png");
      await extractDocument(harness.deps(createLlmClient({ transport: model })), {
        tenantId: B.tenantId,
        documentId: doc.id,
      });
      const req = model.requests[0];
      const content = req?.messages[0]?.content as {
        type: string;
        source?: { media_type: string };
      }[];
      expect(content[0]?.type).toBe("image");
      expect(content[0]?.source?.media_type).toBe("image/png");
      expect(JSON.stringify(req?.system)).not.toContain("Cedar Ridge");
    });
  });

  it("stores a file once per client and sha256, and the same file for another client apart", async () => {
    const before = harness.objects.size;
    const first = await store(A, "northline-20418.pdf", "application/pdf");
    const again = await store(A, "northline-20418.pdf", "application/pdf", "email");
    expect(again.created).toBe(false);
    expect(again.document.id).toBe(first.document.id);
    expect(again.document.source).toBe(first.document.source);
    const other = await store(B, "northline-20418.pdf", "application/pdf");
    expect(other.document.id).not.toBe(first.document.id);
    expect(other.document.storageKey).not.toBe(first.document.storageKey);
    expect(harness.objects.size).toBeLessThanOrEqual(before + 1);
    const rows = await harness.as(A, (tx) =>
      tx.select().from(document).where(eq(document.sha256, first.document.sha256)),
    );
    expect(rows).toHaveLength(1);
  });

  it("emits document.received only for a new document", async () => {
    const { document: doc } = await store(A, "keystone-55102.pdf", "application/pdf");
    const events = await harness.as(A, (tx) =>
      tx
        .select()
        .from(event)
        .where(and(eq(event.type, "document.received"), eq(event.subjectId, doc.id))),
    );
    expect(events).toHaveLength(1);
  });

  it("refuses files that are not PDFs or images", async () => {
    await expect(
      harness.as(A, (tx) =>
        storeDocument(tx, harness.content, {
          tenantId: A.tenantId,
          source: "upload",
          connectionId: null,
          bytes: new Uint8Array([1, 2, 3]),
          filename: "x.zip",
          mimeType: "application/zip",
        }),
      ),
    ).rejects.toBeInstanceOf(DocumentError);
  });

  it("re-extraction inserts a new extraction and keeps the old one", async () => {
    const { document: doc } = await store(A, "northline-20418.pdf", "application/pdf");
    const x = expectedOf("northline-20418");
    const one = await extractDocument(harness.deps(answering(x)), {
      tenantId: A.tenantId,
      documentId: doc.id,
    });
    const two = await extractDocument(harness.deps(answering(x)), {
      tenantId: A.tenantId,
      documentId: doc.id,
    });
    expect(two.extractionId).not.toBe(one.extractionId);
    const rows = await harness.as(A, (tx) =>
      tx.select().from(docExtraction).where(eq(docExtraction.documentId, doc.id)),
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const view = await harness.as(A, (tx) => getDocument(tx, A.tenantId, doc.id));
    expect(view?.extraction?.id).toBe(two.extractionId);
    const lines = await harness.as(A, (tx) =>
      tx.select().from(docLine).where(eq(docLine.extractionId, one.extractionId)),
    );
    expect(lines).toHaveLength(x.lines.length);
  });

  // v0.14 W4-B (docs/plan.md §1.6 "Long PDFs").
  it("reads a PDF over the page limit in parts, stores it once and records one merged reading", async () => {
    const pages = PDF_PAGES_PER_CALL + 20;
    const long = await PDFDocument.create();
    for (let i = 0; i < pages; i++) long.addPage([100, 100]);
    const bytes = await long.save();
    const x = expectedOf("northline-20418");
    const firstPart = { ...x, lines: x.lines.map((l) => ({ ...l, page: 1 })) };
    const lastPart = { ...x, lines: [{ ...(x.lines[0] as (typeof x.lines)[number]), page: 3 }] };
    const model = new FakeModel([
      { toolUse: { name: "record_invoice", input: { ...firstPart, total: "0" } } },
      { toolUse: { name: "record_invoice", input: lastPart } },
    ]);
    const calls: number[] = [];
    const before = harness.objects.size;
    const { document: doc } = await harness.as(B, (tx) =>
      storeDocument(tx, harness.content, {
        tenantId: B.tenantId,
        source: "upload",
        connectionId: B.uploadConnectionId,
        bytes,
        filename: "long.pdf",
        mimeType: "application/pdf",
      }),
    );
    expect(harness.objects.size).toBe(before + 1);
    const r = await extractDocument(harness.deps(createLlmClient({ transport: model })), {
      tenantId: B.tenantId,
      documentId: doc.id,
      onCall: (rec) => {
        calls.push(rec.usage.inputTokens);
      },
    });
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(
      `pages ${PDF_PAGES_PER_CALL + 1} to ${pages} of a ${pages}-page invoice`,
    );
    expect(calls).toHaveLength(2);
    expect(r.extraction.header.pageCount).toBe(pages);
    expect(r.extraction.total).toBe(x.total);
    expect(r.lineCount).toBe(x.lines.length + 1);
    expect(r.extraction.lines.at(-1)?.page).toBe(PDF_PAGES_PER_CALL + 3);
    // The original is stored once; splitting stores nothing.
    expect(harness.objects.size).toBe(before + 1);
  });

  it("sends a document whose totals don't add up to review, with an inbox item", async () => {
    const x = expectedOf("cedar-ridge-7731");
    const wrong = { ...x, total: "5900.00" };
    const { document: doc } = await store(A, "cedar-ridge-7731.png", "image/png");
    const r = await extractDocument(harness.deps(answering(wrong)), {
      tenantId: A.tenantId,
      documentId: doc.id,
    });
    expect(r.status).toBe("needs_review");
    expect(r.problems.join(" ")).toContain("total is 5,900.00");
    const [item] = await harness.as(A, (tx) =>
      tx
        .select()
        .from(inboxItem)
        .where(eq(inboxItem.id, r.inboxItemId ?? "")),
    );
    expect(item?.kind).toBe("extraction_review");
    expect(item?.assigneeRole).toBe("client_admin");
    expect((item?.payload as { sources?: string[] } | undefined)?.sources).toContain(doc.id);
  });

  it("marks the document failed when the model gives no usable answer", async () => {
    const { document: doc } = await store(B, "keystone-55102.pdf", "application/pdf");
    const llm = createLlmClient({ transport: new FakeModel([{ text: "I can't read this." }]) });
    await expect(
      extractDocument(harness.deps(llm), { tenantId: B.tenantId, documentId: doc.id }),
    ).rejects.toThrow(/without calling record_invoice/);
    const view = await harness.as(B, (tx) => getDocument(tx, B.tenantId, doc.id));
    expect(view?.document.status).toBe("failed");
  });

  it("can't read or extract another client's document", async () => {
    const { document: doc } = await store(A, "northline-20418.pdf", "application/pdf");
    expect(await harness.as(B, (tx) => getDocument(tx, B.tenantId, doc.id))).toBeNull();
    await expect(
      extractDocument(harness.deps(answering(expectedOf("northline-20418"))), {
        tenantId: B.tenantId,
        documentId: doc.id,
      }),
    ).rejects.toBeInstanceOf(DocumentError);
  });

  describe("linking (vendor + total + date ± 7 days)", () => {
    async function extracted(
      c: Client,
      x: InvoiceExtraction,
      file: string,
      mime: string,
      meta = {},
    ) {
      const { document: doc } = await store(c, file, mime, "upload", meta);
      await extractDocument(harness.deps(answering(x)), {
        tenantId: c.tenantId,
        documentId: doc.id,
      });
      return doc;
    }

    it("links at the edge of the window and not past it", async () => {
      // Fresh client so earlier tests' documents don't interfere.
      const C = await freshClient("Window shop");
      const x = expectedOf("northline-20418");
      await addTransaction(
        C,
        "Northline Panel Supply",
        x.total,
        shiftDate(x.header.invoiceDate, 8),
      );
      const doc = await extracted(C, x, "northline-20418.pdf", "application/pdf");
      expect((await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, doc.id))).status).toBe(
        "no_match",
      );
      const inWindow = await addTransaction(
        C,
        "Northline Panel Supply",
        x.total,
        shiftDate(x.header.invoiceDate, 7),
      );
      expect(await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, doc.id))).toEqual({
        status: "linked",
        transactionId: inWindow.id,
      });
      const [t] = await harness.as(C, (tx) =>
        tx.select().from(transaction).where(eq(transaction.id, inWindow.id)),
      );
      expect(t?.status).toBe("extracted");
    });

    it("needs the same total and vendor, and leaves two equal candidates to a person", async () => {
      const C = await freshClient("Ambiguous shop");
      const x = expectedOf("cedar-ridge-7731");
      await addTransaction(C, "Cedar Ridge Hardwoods", "5843.34", x.header.invoiceDate);
      await addTransaction(C, "Someone Else", x.total, x.header.invoiceDate);
      const doc = await extracted(C, x, "cedar-ridge-7731.png", "image/png");
      expect((await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, doc.id))).status).toBe(
        "no_match",
      );
      await addTransaction(
        C,
        "Cedar Ridge Hardwoods",
        x.total,
        shiftDate(x.header.invoiceDate, -2),
      );
      await addTransaction(C, "Cedar Ridge Hardwoods", x.total, shiftDate(x.header.invoiceDate, 3));
      const r = await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, doc.id));
      expect(r.status).toBe("ambiguous");
    });

    it("finds a forwarded document's vendor by sender domain, and remembers the domain", async () => {
      const C = await freshClient("Domain shop");
      const x = expectedOf("keystone-55102");
      const txn = await addTransaction(
        C,
        "Keystone Hardware & Finishes",
        x.total,
        x.header.invoiceDate,
      );
      const doc = await extracted(C, x, "keystone-55102.pdf", "application/pdf", {
        email: { from: "billing@keystonehw.example" },
      });
      expect(await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, doc.id))).toEqual({
        status: "linked",
        transactionId: txn.id,
      });
      const [v] = await harness.as(C, (tx) =>
        tx
          .select()
          .from(vendor)
          .where(eq(vendor.id, txn.vendorId ?? "")),
      );
      expect((v?.ext as { domains?: string[] } | undefined)?.domains).toEqual([
        "keystonehw.example",
      ]);
      // A second invoice from the same domain naming the vendor differently still finds it.
      const D = expectedOf("keystone-55102");
      const renamed = { ...D, header: { ...D.header, vendorName: "KHF Supply" } };
      const txn2 = await addTransaction(C, "Keystone Hardware & Finishes", "100.00", "2026-11-20");
      const rx = {
        ...renamed,
        lines: [{ ...D.lines[0], extPrice: "100.00" } as InvoiceExtraction["lines"][number]],
        subtotal: "100.00",
        freight: "0",
        tax: "0",
        total: "100.00",
        header: { ...renamed.header, invoiceDate: "2026-11-19" },
      };
      const { document: other } = await harness.as(C, (tx) =>
        storeDocument(tx, harness.content, {
          tenantId: C.tenantId,
          source: "email",
          connectionId: C.uploadConnectionId,
          bytes: new Uint8Array([37, 80, 68, 70, 45, 49, 10, 1]),
          filename: "khf.pdf",
          mimeType: "application/pdf",
          meta: { email: { from: "ap@keystonehw.example" } },
        }),
      );
      await extractDocument(harness.deps(answering(rx)), {
        tenantId: C.tenantId,
        documentId: other.id,
      });
      expect(await harness.as(C, (tx) => linkToTransaction(tx, C.tenantId, other.id))).toEqual({
        status: "linked",
        transactionId: txn2.id,
      });
    });

    it("findSupport: found when linked, links a fitting document, else missing", async () => {
      const C = await freshClient("Support shop");
      const x = expectedOf("northline-20418");
      const txn = await addTransaction(C, "Northline Panel Supply", x.total, x.header.invoiceDate);
      const none = await harness.as(C, (tx) => findSupport(tx, C.tenantId, txn.id));
      expect(none.status).toBe("missing");
      const doc = await extracted(C, x, "northline-20418.pdf", "application/pdf");
      const found = await harness.as(C, (tx) => findSupport(tx, C.tenantId, txn.id));
      expect(found).toEqual({
        status: "found",
        transactionId: txn.id,
        documentIds: [doc.id],
        linkedNow: true,
      });
      const again = await harness.as(C, (tx) => findSupport(tx, C.tenantId, txn.id));
      expect(again).toMatchObject({ status: "found", linkedNow: false });
    });
  });

  async function freshClient(name: string): Promise<Client> {
    const { tenant } = await import("@countersign/db");
    const { ensureUploadConnection } = await import("@countersign/connectors");
    const { withTenant } = await import("@countersign/db");
    const [row] = await harness.t.db.insert(tenant).values({ name }).returning();
    if (!row) throw new Error("no tenant");
    const conn = await withTenant(harness.db, row.id, (tx) => ensureUploadConnection(tx, row.id));
    return { tenantId: row.id, uploadConnectionId: conn.id };
  }
});

describe("countPages", () => {
  it("counts an image as one page and an unreadable PDF as unknown", () => {
    expect(countPages(new Uint8Array([1]), "image/png")).toBe(1);
    expect(
      countPages(
        new TextEncoder().encode("%PDF /Type /Pages /Type /Page /Type /Page"),
        "application/pdf",
      ),
    ).toBe(2);
    expect(countPages(new Uint8Array([1]), "application/zip")).toBeNull();
  });
});
