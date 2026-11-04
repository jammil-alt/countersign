// What the model returns when it reads an invoice (ARCHITECTURE §7): the input schema of the forced
// `record_invoice` tool, and the shape `doc_extraction` + `doc_line` rows are written from.
// Amounts are decimal strings (invariant 6); confidences are plain numbers in 0..1.

import { z } from "zod";
import { CurrencyCode, DECIMAL_RE } from "../money";

const Amount = z
  .string()
  .regex(DECIMAL_RE, 'a decimal string with at most 4 places, e.g. "1250.00"')
  .describe('A decimal string, e.g. "1250.00". Negative for credits and discounts.');
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "yyyy-mm-dd")
  .describe("ISO date, yyyy-mm-dd");
const Confidence = z.number().min(0).max(1);

export const ExtractedLine = z.object({
  /** 1-based, in the order the lines appear across pages. */
  lineNo: z.number().int().positive(),
  vendorSku: z.string().nullable().describe("The vendor's item or SKU code, if printed"),
  description: z.string().min(1).describe("The line's description, exactly as printed"),
  qty: Amount,
  uom: z.string().nullable().describe('Unit of measure as printed, e.g. "EA", "SHT", "BF", "LF"'),
  unitPrice: Amount,
  extPrice: Amount.describe("The line's extended amount as printed"),
  discount: Amount.nullable().describe("A discount printed on this line, if any"),
  page: z.number().int().positive().describe("The page the line is printed on"),
});
export type ExtractedLine = z.infer<typeof ExtractedLine>;

export const ExtractedHeader = z.object({
  vendorName: z.string().min(1),
  vendorAddress: z.string().nullable(),
  invoiceNumber: z.string().min(1),
  invoiceDate: IsoDate,
  dueDate: IsoDate.nullable(),
  poNumber: z.string().nullable().describe("The customer's PO or job number, if printed"),
  currency: CurrencyCode,
  pageCount: z.number().int().positive(),
  /** Per-field confidence for the fields linking relies on. */
  confidence: z.object({
    vendorName: Confidence,
    invoiceNumber: Confidence,
    invoiceDate: Confidence,
    total: Confidence,
  }),
});
export type ExtractedHeader = z.infer<typeof ExtractedHeader>;

export const ExtractedSurcharge = z.object({
  label: z.string().min(1).describe('As printed, e.g. "Fuel surcharge"'),
  amount: Amount,
});

export const InvoiceExtraction = z.object({
  header: ExtractedHeader,
  lines: z.array(ExtractedLine),
  subtotal: Amount.describe(
    "The printed subtotal of the lines, before freight, surcharges and tax",
  ),
  freight: Amount.describe('Freight or delivery charged; "0" when none'),
  surcharges: z.array(ExtractedSurcharge).describe("Fuel and other surcharges, not freight or tax"),
  tax: Amount.describe('Sales tax; "0" when none'),
  total: Amount.describe("The invoice total due, as printed"),
  confidence: Confidence.describe("Overall confidence in this reading"),
});
// No `.meta({ id })`: a named schema exports as a $ref, and a tool's input schema must be an object.
export type InvoiceExtraction = z.infer<typeof InvoiceExtraction>;

/** The forced tool the extraction call offers the model. */
export const RECORD_INVOICE_TOOL = "record_invoice";

/** Mime types extraction reads: PDFs as `document` blocks, images as `image` blocks. */
export const EXTRACTABLE_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type ExtractableMimeType = (typeof EXTRACTABLE_MIME_TYPES)[number];

export function isExtractable(mime: string): mime is ExtractableMimeType {
  return (EXTRACTABLE_MIME_TYPES as readonly string[]).includes(mime);
}
