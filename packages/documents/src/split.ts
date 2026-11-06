// v0.14 W4-B: PDFs over the model's page limit (docs/plan.md §1.6 "Long PDFs"). A PDF with more
// pages than one model call reads is split into page ranges, each read by its own call, and the
// answers merged into one extraction. Only the extraction path uses this: the original is stored
// once, as before, and nothing here writes. pdf-lib (pure JavaScript, already pinned for the Weekly
// Table's PDF in apps/api) does the splitting, on Workers and in Node.

import type { InvoiceExtraction } from "@countersign/core";
import { PDFDocument } from "pdf-lib";

/**
 * Pages one call reads. The API takes up to 600 pages in a request on 1M-context models and 100
 * on 200k ones, but a page costs input tokens as text and as an image, so 100 also keeps a part
 * well inside any context window.
 */
// DECISION: 100 pages a call, whatever the model, so a step's model override can't make a part too
// long for it.
export const PDF_PAGES_PER_CALL = 100;

/** The most pages read from one PDF (five calls). Longer files are refused, never read in part. */
export const PDF_MAX_PAGES = 500;

/**
 * The most bytes one part may be: the API's request limit is 32 MB and base64 adds a third, with
 * room left for the request around it.
 */
export const PDF_MAX_PART_BYTES = 22 * 1024 * 1024;

/** The most bytes split at all (the store's own limit; checked again so a caller can't pass more). */
export const PDF_MAX_SPLIT_BYTES = 32 * 1024 * 1024;

export interface PdfPart {
  /** 1-based, inclusive: the pages of the original this part holds. */
  firstPage: number;
  lastPage: number;
  bytes: Uint8Array;
}

export class PdfSplitError extends Error {
  override name = "PdfSplitError";
  constructor(
    readonly code: "too_many_pages" | "too_large",
    message: string,
  ) {
    super(message);
  }
}

export interface SplitOptions {
  pagesPerCall?: number;
  maxPages?: number;
  maxPartBytes?: number;
}

/** Loads a PDF for splitting; null when pdf-lib can't read it (encrypted, damaged). */
async function load(bytes: Uint8Array): Promise<PDFDocument | null> {
  if (bytes.length > PDF_MAX_SPLIT_BYTES) {
    throw new PdfSplitError("too_large", "the file is over 32 MB");
  }
  try {
    // No metadata update: the parts carry the original's pages only, nothing of ours.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    doc.getPageCount(); // a file without a readable page tree throws here, not later
    return doc;
  } catch {
    return null;
  }
}

async function part(src: PDFDocument, first: number, last: number): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const indices = Array.from({ length: last - first + 1 }, (_, i) => first - 1 + i);
  for (const page of await out.copyPages(src, indices)) out.addPage(page);
  return out.save({ useObjectStreams: true });
}

/**
 * The parts a PDF is read in: null when it fits one call, in pages and bytes (or can't be read by pdf-lib: it then
 * goes to the model whole, as before). Throws when it has more pages than `maxPages`.
 */
// DECISION: a PDF pdf-lib can't open (encrypted or damaged) is sent whole, as every PDF was before
// W4-B; the model reads it or the extraction fails as it would have. A part over the byte limit is
// halved until it fits, down to one page; a single page over it is sent as is (the call fails).
export async function splitPdf(
  bytes: Uint8Array,
  options: SplitOptions = {},
): Promise<PdfPart[] | null> {
  const perCall = Math.max(1, options.pagesPerCall ?? PDF_PAGES_PER_CALL);
  const maxPages = options.maxPages ?? PDF_MAX_PAGES;
  const maxBytes = options.maxPartBytes ?? PDF_MAX_PART_BYTES;
  const src = await load(bytes);
  if (!src) return null;
  const pages = src.getPageCount();
  if (pages > maxPages) {
    throw new PdfSplitError(
      "too_many_pages",
      `the PDF has ${pages} pages; we read at most ${maxPages}`,
    );
  }
  if (pages <= perCall && bytes.length <= maxBytes) return null;
  const parts: PdfPart[] = [];
  // Ranges still to cut, first page first; at most maxPages ranges ever exist (one page each).
  const todo: [number, number][] = [];
  for (let first = 1; first <= pages; first += perCall) {
    todo.push([first, Math.min(pages, first + perCall - 1)]);
  }
  while (todo.length > 0) {
    const range = todo.shift() as [number, number];
    const [first, last] = range;
    const out = await part(src, first, last);
    if (out.length > maxBytes && last > first) {
      const mid = first + Math.floor((last - first) / 2);
      todo.unshift([first, mid], [mid + 1, last]);
      continue;
    }
    parts.push({ firstPage: first, lastPage: last, bytes: out });
  }
  return parts;
}

/** The request text for one part: which pages it is, and where the header and totals are. */
export function partRequest(p: Pick<PdfPart, "firstPage" | "lastPage">, pages: number): string {
  return [
    `This file is pages ${p.firstPage} to ${p.lastPage} of a ${pages}-page invoice, sent in parts.`,
    "Record what is printed on these pages. Number pages from 1 at this file's first page.",
    "Copy the header if it is printed here. Give the subtotal, freight, surcharges, tax and total only if they are printed on these pages; otherwise give 0 and no surcharges.",
  ].join(" ");
}

/**
 * One extraction from the parts' answers, in page order: the header from the first part (with the
 * whole file's page count), every line with its page moved to the original's numbering, the totals
 * from the last part that prints a total, and the lowest confidence of any part.
 */
// DECISION: invoice totals are printed once, at the end; the last part with a non-zero total (else
// the last part) gives subtotal, freight, surcharges, tax and total. A header field a later part
// prints and the first doesn't (a due date, a PO) fills in. Lines keep printed order across parts.
export function mergeExtractions(
  answers: readonly { part: Pick<PdfPart, "firstPage" | "lastPage">; value: InvoiceExtraction }[],
  pages: number,
): InvoiceExtraction {
  const sorted = [...answers].sort((a, b) => a.part.firstPage - b.part.firstPage);
  const first = sorted[0];
  if (!first) throw new Error("no parts to merge");
  const totals =
    [...sorted].reverse().find((a) => !isZero(a.value.total)) ?? sorted[sorted.length - 1] ?? first;
  const header = { ...first.value.header, pageCount: pages };
  for (const a of sorted.slice(1)) {
    header.dueDate ??= a.value.header.dueDate;
    header.poNumber ??= a.value.header.poNumber;
    header.vendorAddress ??= a.value.header.vendorAddress;
  }
  header.confidence = {
    ...header.confidence,
    total: totals.value.header.confidence.total,
  };
  const lines = sorted.flatMap((a) =>
    a.value.lines.map((l) => ({ ...l, page: originalPage(l.page, a.part) })),
  );
  return {
    header,
    lines: lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
    subtotal: totals.value.subtotal,
    freight: totals.value.freight,
    surcharges: totals.value.surcharges,
    tax: totals.value.tax,
    total: totals.value.total,
    confidence: Math.min(...sorted.map((a) => a.value.confidence)),
  };
}

function isZero(amount: string): boolean {
  // Decimal strings only (the schema's pattern): zero when every digit is 0.
  for (const ch of amount) if (ch >= "1" && ch <= "9") return false;
  return true;
}

/** A part's page number in the original: counted from the part's first page, kept in its range. */
function originalPage(page: number, p: Pick<PdfPart, "firstPage" | "lastPage">): number {
  const size = p.lastPage - p.firstPage + 1;
  // A model that numbered from the original (a page already in the part's range) is believed.
  if (page > size && page >= p.firstPage && page <= p.lastPage) return page;
  return p.firstPage + Math.min(Math.max(page, 1), size) - 1;
}
