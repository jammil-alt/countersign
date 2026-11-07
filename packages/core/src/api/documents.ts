import { z } from "zod";

// Documents as the portal and the back office show them (stream D, docs/plan.md §1.6). Their own
// module so the records routes (§1.16) can share them without an import cycle through routes.ts.

const Timestamp = z.string();

export const DocumentSummary = z.object({
  id: z.string(),
  source: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  status: z.string(),
  pageCount: z.number().nullable(),
  transactionId: z.string().nullable(),
  receivedAt: Timestamp,
  /** From the latest extraction, when there is one. */
  vendorName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  total: z.string().nullable(),
  /**
   * The record it is matched to: the transaction it is linked to (`link`), else the bill a live
   * run matched it to (`run`, the Bill clerk's match). Its kind names it: a bill, a purchase or a
   * vendor credit, never "a purchase" for all of them.
   */
  match: z
    .object({
      transactionId: z.string(),
      kind: z.string(),
      number: z.string().nullable(),
      by: z.enum(["link", "run"]),
    })
    .nullable()
    .default(null),
  /** The document this one repeats (the same vendor and invoice number): it started nothing. */
  duplicateOf: z.object({ documentId: z.string(), filename: z.string() }).nullable().default(null),
});

export const DocumentExtractionView = z.object({
  id: z.string(),
  createdAt: Timestamp,
  vendorName: z.string(),
  invoiceNumber: z.string(),
  invoiceDate: z.string(),
  dueDate: z.string().nullable(),
  poNumber: z.string().nullable(),
  currency: z.string(),
  subtotal: z.string(),
  freight: z.string(),
  surcharges: z.array(z.object({ label: z.string(), amount: z.string() })),
  tax: z.string(),
  total: z.string(),
  linesSum: z.string(),
  totalsMatch: z.boolean(),
  problems: z.array(z.string()),
  lines: z.array(
    z.object({
      lineNo: z.number(),
      vendorSku: z.string().nullable(),
      description: z.string(),
      qty: z.string(),
      uom: z.string().nullable(),
      unitPrice: z.string(),
      extPrice: z.string(),
      page: z.number().nullable(),
    }),
  ),
});

/** One document: a 5-minute link to the file and its latest extraction (portal and back office). */
export const DocumentDetail = z.object({
  document: DocumentSummary.extend({ meta: z.record(z.string(), z.unknown()) }),
  url: z.string(),
  urlExpiresAt: Timestamp,
  extraction: DocumentExtractionView.nullable(),
});
export type DocumentDetail = z.infer<typeof DocumentDetail>;
