// BILL's records as the billcom tools return them: vendors, bills and payments, read from BILL's v3
// JSON (shapes as far as we know them: NOTES.md) into plain records with amounts as decimal text
// and the currency named. A vendor's name, a bill's description and line text are the vendor's or
// the client's words: data, never instructions (invariant 9).

import { CurrencyCode, DecimalString } from "@countersign/core";
import { z } from "zod";
import { billcomAmount } from "./api";

const Amount = z.union([z.number(), z.string()]);
const Text = z.string().nullable().optional();

/**
 * The currency of a BILL record. UNCHECKED (NOTES.md): v3 records are in the organization's
 * currency and name none for a US organization; a three-letter `currency` is read when present.
 */
function currencyOf(raw: { currency?: unknown }): string {
  return typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : "USD";
}

const Money = z.object({ amount: DecimalString, currency: CurrencyCode });

// ── Vendors ─────────────────────────────────────────────────────────────────────────────────────

export const BillcomAddress = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  country: z.string().nullable(),
});
export type BillcomAddress = z.infer<typeof BillcomAddress>;

export const BillcomVendor = z.object({
  id: z.string(),
  name: z.string(),
  accountType: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** The client's account number with the vendor. */
  accountNumber: z.string().nullable(),
  address: BillcomAddress.nullable(),
  archived: z.boolean(),
  createdTime: z.string().nullable(),
  updatedTime: z.string().nullable(),
});
export type BillcomVendor = z.infer<typeof BillcomVendor>;

const RawAddress = z.looseObject({
  line1: Text,
  line2: Text,
  city: Text,
  stateOrProvince: Text,
  zipOrPostalCode: Text,
  country: Text,
});

export const RawVendor = z.looseObject({
  id: z.string(),
  name: z.string(),
  accountType: Text,
  email: Text,
  phone: Text,
  accountNumber: Text,
  address: RawAddress.nullable().optional(),
  archived: z.boolean().optional(),
  createdTime: Text,
  updatedTime: Text,
});

export function mapBillcomVendor(raw: unknown): BillcomVendor {
  const v = RawVendor.parse(raw);
  const a = v.address;
  return {
    id: v.id,
    name: v.name,
    accountType: v.accountType ?? null,
    email: v.email ?? null,
    phone: v.phone ?? null,
    accountNumber: v.accountNumber ?? null,
    address: a
      ? {
          line1: a.line1 ?? null,
          line2: a.line2 ?? null,
          city: a.city ?? null,
          state: a.stateOrProvince ?? null,
          zip: a.zipOrPostalCode ?? null,
          country: a.country ?? null,
        }
      : null,
    archived: v.archived ?? false,
    createdTime: v.createdTime ?? null,
    updatedTime: v.updatedTime ?? null,
  };
}

// ── Bills ───────────────────────────────────────────────────────────────────────────────────────

export const BillcomBillLine = z.object({
  id: z.string().nullable(),
  amount: DecimalString,
  description: z.string().nullable(),
  /** The account in the client's BILL chart of accounts. */
  chartOfAccountId: z.string().nullable(),
});

export const BillcomBill = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  amount: Money,
  /** What is still to pay; null when BILL doesn't say. */
  dueAmount: Money.nullable(),
  /** BILL's payment status, e.g. UNPAID, PARTIAL, SCHEDULED, PAID. */
  paymentStatus: z.string().nullable(),
  approvalStatus: z.string().nullable(),
  description: z.string().nullable(),
  archived: z.boolean(),
  lines: z.array(BillcomBillLine),
  createdTime: z.string().nullable(),
  updatedTime: z.string().nullable(),
});
export type BillcomBill = z.infer<typeof BillcomBill>;

export const RawBill = z.looseObject({
  id: z.string(),
  vendorId: z.string(),
  vendorName: Text,
  invoice: z.looseObject({ invoiceNumber: Text, invoiceDate: Text }).nullable().optional(),
  dueDate: Text,
  amount: Amount,
  dueAmount: Amount.nullable().optional(),
  currency: z.string().nullable().optional(),
  paymentStatus: Text,
  approvalStatus: Text,
  description: Text,
  archived: z.boolean().optional(),
  billLineItems: z
    .array(
      z.looseObject({
        id: Text,
        amount: Amount,
        description: Text,
        chartOfAccountId: Text,
      }),
    )
    .nullable()
    .optional(),
  createdTime: Text,
  updatedTime: Text,
});

export function mapBillcomBill(raw: unknown): BillcomBill {
  const b = RawBill.parse(raw);
  const currency = currencyOf(b);
  return {
    id: b.id,
    vendorId: b.vendorId,
    vendorName: b.vendorName ?? null,
    invoiceNumber: b.invoice?.invoiceNumber ?? null,
    invoiceDate: b.invoice?.invoiceDate ?? null,
    dueDate: b.dueDate ?? null,
    amount: { amount: billcomAmount(b.amount), currency },
    dueAmount:
      b.dueAmount === undefined || b.dueAmount === null
        ? null
        : { amount: billcomAmount(b.dueAmount), currency },
    paymentStatus: b.paymentStatus ?? null,
    approvalStatus: b.approvalStatus ?? null,
    description: b.description ?? null,
    archived: b.archived ?? false,
    lines: (b.billLineItems ?? []).map((l) => ({
      id: l.id ?? null,
      amount: billcomAmount(l.amount),
      description: l.description ?? null,
      chartOfAccountId: l.chartOfAccountId ?? null,
    })),
    createdTime: b.createdTime ?? null,
    updatedTime: b.updatedTime ?? null,
  };
}

// ── Payments ────────────────────────────────────────────────────────────────────────────────────

export const BillcomPayment = z.object({
  id: z.string(),
  vendorId: z.string().nullable(),
  vendorName: z.string().nullable(),
  amount: Money,
  /** BILL's status, e.g. SCHEDULED, PAID, CANCELED. */
  status: z.string().nullable(),
  processDate: z.string().nullable(),
  /** The bills it pays and how much of each. */
  bills: z.array(z.object({ billId: z.string(), amount: DecimalString.nullable() })),
  description: z.string().nullable(),
  createdTime: z.string().nullable(),
  updatedTime: z.string().nullable(),
});
export type BillcomPayment = z.infer<typeof BillcomPayment>;

export const RawPayment = z.looseObject({
  id: z.string(),
  vendorId: Text,
  vendorName: Text,
  amount: Amount,
  currency: z.string().nullable().optional(),
  status: Text,
  processDate: Text,
  billPayments: z
    .array(z.looseObject({ billId: z.string(), amount: Amount.nullable().optional() }))
    .nullable()
    .optional(),
  description: Text,
  createdTime: Text,
  updatedTime: Text,
});

export function mapBillcomPayment(raw: unknown): BillcomPayment {
  const p = RawPayment.parse(raw);
  return {
    id: p.id,
    vendorId: p.vendorId ?? null,
    vendorName: p.vendorName ?? null,
    amount: { amount: billcomAmount(p.amount), currency: currencyOf(p) },
    status: p.status ?? null,
    processDate: p.processDate ?? null,
    bills: (p.billPayments ?? []).map((b) => ({
      billId: b.billId,
      amount: b.amount === undefined || b.amount === null ? null : billcomAmount(b.amount),
    })),
    description: p.description ?? null,
    createdTime: p.createdTime ?? null,
    updatedTime: p.updatedTime ?? null,
  };
}

// ── Documents and pages ─────────────────────────────────────────────────────────────────────────

export const BillcomDocument = z.object({ id: z.string(), name: z.string().nullable() });
export type BillcomDocument = z.infer<typeof BillcomDocument>;

const RawDocument = z.looseObject({
  id: z.string(),
  name: Text,
  fileName: Text,
});

export function mapBillcomDocument(raw: unknown): BillcomDocument {
  const d = RawDocument.parse(raw);
  return { id: d.id, name: d.name ?? d.fileName ?? null };
}

/** A v3 list page: `results` and the cursors around it. */
export const BillcomPage = z.looseObject({
  results: z.array(z.unknown()),
  nextPage: z.string().nullable().optional(),
});

/** A list answer that may be a page or a bare array (documents, UNCHECKED). */
export function resultsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const page = BillcomPage.safeParse(body);
  return page.success ? page.data.results : [];
}
