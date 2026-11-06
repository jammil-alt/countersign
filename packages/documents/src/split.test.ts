// v0.14 W4-B: long PDFs read in parts (docs/plan.md §1.6 "Long PDFs"). No database: splitting and
// merging are pure.

import type { InvoiceExtraction } from "@countersign/core";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { sumRecords } from "./extract";
import { mergeExtractions, PdfSplitError, partRequest, splitPdf } from "./split";

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    doc.addPage([200, 200]).drawText(`page ${i + 1}`, { x: 10, y: 10 });
  return doc.save();
}

function reading(over: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    header: {
      vendorName: "Northline Lumber",
      vendorAddress: null,
      invoiceNumber: "20418",
      invoiceDate: "2026-10-01",
      dueDate: null,
      poNumber: null,
      currency: "USD",
      pageCount: 1,
      confidence: { vendorName: 0.9, invoiceNumber: 0.9, invoiceDate: 0.9, total: 0.2 },
    },
    lines: [],
    subtotal: "0",
    freight: "0",
    surcharges: [],
    tax: "0",
    total: "0",
    confidence: 0.9,
    ...over,
  };
}

const line = (description: string, page: number) => ({
  lineNo: 1,
  vendorSku: null,
  description,
  qty: "1",
  uom: "EA",
  unitPrice: "10.00",
  extPrice: "10.00",
  discount: null,
  page,
});

describe("splitPdf", () => {
  it("leaves a PDF that fits one call whole", async () => {
    expect(await splitPdf(await pdf(3), { pagesPerCall: 3 })).toBeNull();
  });

  it("splits into page ranges of at most the limit, in order", async () => {
    const parts = await splitPdf(await pdf(7), { pagesPerCall: 3 });
    expect(parts?.map((p) => [p.firstPage, p.lastPage])).toEqual([
      [1, 3],
      [4, 6],
      [7, 7],
    ]);
    for (const p of parts ?? []) {
      const back = await PDFDocument.load(p.bytes);
      expect(back.getPageCount()).toBe(p.lastPage - p.firstPage + 1);
    }
  });

  it("halves a part that is too many bytes, down to a page", async () => {
    const parts = await splitPdf(await pdf(4), { pagesPerCall: 4, maxPartBytes: 1 });
    expect(parts?.map((p) => [p.firstPage, p.lastPage])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it("refuses more pages than it reads, and reads none of them", async () => {
    await expect(splitPdf(await pdf(6), { pagesPerCall: 2, maxPages: 5 })).rejects.toBeInstanceOf(
      PdfSplitError,
    );
  });

  it("sends a file pdf-lib can't open whole", async () => {
    expect(await splitPdf(new TextEncoder().encode("%PDF-1.7 not really"))).toBeNull();
  });
});

describe("mergeExtractions", () => {
  it("keeps the first part's header, numbers lines across parts and takes the printed totals", () => {
    const merged = mergeExtractions(
      [
        {
          part: { firstPage: 4, lastPage: 6 },
          value: reading({
            lines: [line("Maple 4/4", 2)],
            subtotal: "30.00",
            total: "32.00",
            tax: "2.00",
            confidence: 0.7,
            header: {
              ...reading().header,
              confidence: { ...reading().header.confidence, total: 0.95 },
            },
          }),
        },
        {
          part: { firstPage: 1, lastPage: 3 },
          value: reading({
            lines: [line("Oak 4/4", 1), line("Ash 4/4", 3)],
            header: { ...reading().header, poNumber: null },
          }),
        },
      ],
      6,
    );
    expect(merged.header.pageCount).toBe(6);
    expect(merged.lines.map((l) => [l.lineNo, l.description, l.page])).toEqual([
      [1, "Oak 4/4", 1],
      [2, "Ash 4/4", 3],
      [3, "Maple 4/4", 5],
    ]);
    expect([merged.subtotal, merged.tax, merged.total]).toEqual(["30.00", "2.00", "32.00"]);
    expect(merged.header.confidence.total).toBe(0.95);
    expect(merged.confidence).toBe(0.7);
  });

  it("believes a page already numbered from the original, and keeps others in the part", () => {
    const merged = mergeExtractions(
      [
        {
          part: { firstPage: 101, lastPage: 150 },
          value: reading({ lines: [line("A", 120), line("B", 999)] }),
        },
      ],
      150,
    );
    expect(merged.lines.map((l) => l.page)).toEqual([120, 150]);
  });
});

describe("reading a long PDF's parts", () => {
  it("tells each part which pages it is", () => {
    expect(partRequest({ firstPage: 101, lastPage: 200 }, 250)).toContain(
      "pages 101 to 200 of a 250-page invoice",
    );
  });

  it("adds the parts' calls up, in decimals", () => {
    const record = (cost: string | null) => ({
      model: "claude-sonnet-5-5",
      ok: true,
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 5,
      },
      costUsd: cost,
      durationMs: 7,
      stopReason: "tool_use",
    });
    const sum = sumRecords([record("0.100001"), record("0.200002"), record(null)]);
    expect(sum.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, cacheReadTokens: 15 });
    expect(sum.costUsd).toBe("0.300003");
    expect(sum.durationMs).toBe(21);
  });
});
