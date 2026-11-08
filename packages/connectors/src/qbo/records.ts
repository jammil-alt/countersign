// QuickBooks records as the qbo tools return them: plain shapes with decimal strings for money
// (never JS numbers, invariant 6), ids and SyncTokens kept so a write can name the version it read.
// Also the one place a decimal goes back onto the wire as a JSON number.

import {
  DecimalString,
  dec,
  mapQboInvoice,
  mapQboLines,
  QboAttachableRaw,
  QboCustomerRaw,
  QboInvoiceRaw,
  QboItemRaw,
  QboPaymentRaw,
  QboTransactionRaw,
  QboVendorRaw,
  qboAmount,
  qboOptionalAmount,
} from "@countersign/core";
import { z } from "zod";

/** A QBO id: digits. */
export const QboId = z.string().regex(/^\d{1,32}$/, "a QuickBooks id (digits)");
export const SyncToken = z.string().regex(/^\d{1,12}$/, "a QuickBooks SyncToken (digits)");

export const QboTxnEntity = z.enum(["Bill", "Purchase"]);
export type QboTxnEntity = z.infer<typeof QboTxnEntity>;

const Named = z.object({ id: z.string(), name: z.string().nullable() });

export const QboTxnLine = z.object({
  id: z.string().nullable(),
  detailType: z.enum(["account", "item"]),
  description: z.string().nullable(),
  amount: DecimalString,
  account: Named.nullable(),
  item: Named.nullable(),
  qty: DecimalString.nullable(),
  unitPrice: DecimalString.nullable(),
  // P-2: the line's class, its customer (job) and how that customer is billed (docs/plan.md §1.64).
  class: Named.nullable(),
  customer: Named.nullable(),
  billable: z.string().nullable(),
});
export type QboTxnLine = z.infer<typeof QboTxnLine>;

/** The expense lines of a Bill, Purchase or PurchaseOrder, with their class and customer. */
function txnLines(lines: QboTransactionRaw["Line"]): QboTxnLine[] {
  // mapQboLines keeps the two expense detail types, in order; their coding is read beside it.
  const details = (lines ?? []).flatMap((l) =>
    l.DetailType === "AccountBasedExpenseLineDetail"
      ? [l.AccountBasedExpenseLineDetail]
      : l.DetailType === "ItemBasedExpenseLineDetail"
        ? [l.ItemBasedExpenseLineDetail]
        : [],
  );
  const ref = (r: { value: string; name?: string | undefined } | undefined) =>
    r ? { id: r.value, name: r.name ?? null } : null;
  return mapQboLines(lines).map((l, i) => {
    const d = details[i];
    return {
      id: l.externalLineId,
      detailType: l.detailType,
      description: l.description,
      amount: l.amount,
      account: l.accountId ? { id: l.accountId, name: l.accountRef } : null,
      item: l.itemId ? { id: l.itemId, name: l.itemRef } : null,
      qty: l.qty,
      unitPrice: l.unitPrice,
      class: ref(d?.ClassRef),
      customer: ref(d?.CustomerRef),
      billable: d?.BillableStatus ?? null,
    };
  });
}

/** A Bill or Purchase. */
export const QboTxn = z.object({
  entity: QboTxnEntity,
  id: z.string(),
  syncToken: z.string(),
  docNumber: z.string().nullable(),
  txnDate: z.string().nullable(),
  vendor: Named.nullable(),
  total: DecimalString,
  currency: z.string(),
  memo: z.string().nullable(),
  paymentType: z.string().nullable(),
  /** Tax QBO computed on the transaction, when it has any. */
  tax: DecimalString.nullable(),
  lines: z.array(QboTxnLine),
});
export type QboTxn = z.infer<typeof QboTxn>;

export function toTxn(entity: QboTxnEntity, raw: unknown): QboTxn {
  const t = QboTransactionRaw.parse(raw);
  const payee =
    entity === "Purchase"
      ? t.EntityRef && (t.EntityRef.type === undefined || t.EntityRef.type === "Vendor")
        ? t.EntityRef
        : undefined
      : t.VendorRef;
  return {
    entity,
    id: t.Id,
    syncToken: t.SyncToken ?? "0",
    docNumber: t.DocNumber ?? null,
    txnDate: t.TxnDate ?? null,
    vendor: payee ? { id: payee.value, name: payee.name ?? null } : null,
    total: qboAmount(t.TotalAmt),
    currency: (t.CurrencyRef?.value ?? "USD").toUpperCase(),
    memo: t.PrivateNote ?? null,
    paymentType: entity === "Purchase" ? (t.PaymentType ?? null) : null,
    tax: qboOptionalAmount(t.TxnTaxDetail?.TotalTax),
    lines: txnLines(t.Line),
  };
}

export const QboVendor = z.object({
  id: z.string(),
  syncToken: z.string(),
  name: z.string(),
  companyName: z.string().nullable(),
  active: z.boolean(),
  email: z.string().nullable(),
});
export type QboVendor = z.infer<typeof QboVendor>;

export function toVendor(raw: unknown): QboVendor {
  const v = QboVendorRaw.parse(raw);
  return {
    id: v.Id,
    syncToken: v.SyncToken ?? "0",
    name: v.DisplayName,
    companyName: v.CompanyName ?? null,
    active: v.Active !== false,
    email: v.PrimaryEmailAddr?.Address ?? null,
  };
}

export const QboItem = z.object({
  id: z.string(),
  syncToken: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
  purchaseDescription: z.string().nullable(),
  purchaseCost: DecimalString.nullable(),
  expenseAccount: Named.nullable(),
  active: z.boolean(),
});
export type QboItem = z.infer<typeof QboItem>;

export function toItem(raw: unknown): QboItem {
  const i = QboItemRaw.parse(raw);
  return {
    id: i.Id,
    syncToken: i.SyncToken ?? "0",
    name: i.Name,
    sku: i.Sku ?? null,
    type: i.Type ?? null,
    description: i.Description ?? null,
    purchaseDescription: i.PurchaseDesc ?? null,
    purchaseCost: qboOptionalAmount(i.PurchaseCost),
    expenseAccount: i.ExpenseAccountRef
      ? { id: i.ExpenseAccountRef.value, name: i.ExpenseAccountRef.name ?? null }
      : null,
    active: i.Active !== false,
  };
}

export const QboAttachment = z.object({
  id: z.string(),
  syncToken: z.string(),
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().int().nullable(),
  note: z.string().nullable(),
});
export type QboAttachment = z.infer<typeof QboAttachment>;

export function toAttachment(raw: unknown): QboAttachment {
  const a = QboAttachableRaw.parse(raw);
  const size = a.Size === undefined ? null : Number(a.Size);
  return {
    id: a.Id,
    syncToken: a.SyncToken ?? "0",
    fileName: a.FileName ?? null,
    contentType: a.ContentType ?? null,
    size: size !== null && Number.isInteger(size) ? size : null,
    note: a.Note ?? null,
  };
}

// ── Accounts receivable (v0.12, docs/plan.md §1.41) ─────────────────────────────────────────────

export const QboInvoiceLine = z.object({
  id: z.string().nullable(),
  description: z.string().nullable(),
  amount: DecimalString,
  item: Named.nullable(),
  qty: DecimalString.nullable(),
  unitPrice: DecimalString.nullable(),
});

/** An Invoice: what the customer owes, and what is still open. */
export const QboInvoice = z.object({
  id: z.string(),
  syncToken: z.string(),
  docNumber: z.string().nullable(),
  txnDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  customer: Named,
  total: DecimalString,
  balance: DecimalString,
  currency: z.string(),
  status: z.enum(["open", "paid", "void"]),
  /** The invoice's private note: client text, data only (invariant 9). */
  privateNote: z.string().nullable(),
  emailStatus: z.string().nullable(),
  lines: z.array(QboInvoiceLine),
});
export type QboInvoice = z.infer<typeof QboInvoice>;

export function toInvoice(raw: unknown): QboInvoice {
  const t = QboInvoiceRaw.parse(raw);
  const r = mapQboInvoice(raw);
  return {
    id: t.Id,
    syncToken: t.SyncToken ?? "0",
    docNumber: r.docNumber,
    txnDate: r.txnDate,
    dueDate: r.dueDate,
    customer: { id: r.customerExternalId, name: r.customerName },
    total: r.total,
    balance: r.balance,
    currency: r.currency,
    status: r.status === "deleted" ? "void" : r.status,
    privateNote: r.privateNote,
    emailStatus: t.EmailStatus ?? null,
    lines: (t.Line ?? [])
      .filter((l) => l.DetailType === "SalesItemLineDetail")
      .map((l) => ({
        id: l.Id ?? null,
        description: l.Description ?? null,
        amount: qboAmount(l.Amount ?? 0),
        item: l.SalesItemLineDetail?.ItemRef
          ? {
              id: l.SalesItemLineDetail.ItemRef.value,
              name: l.SalesItemLineDetail.ItemRef.name ?? null,
            }
          : null,
        qty: qboOptionalAmount(l.SalesItemLineDetail?.Qty),
        unitPrice: qboOptionalAmount(l.SalesItemLineDetail?.UnitPrice),
      })),
  };
}

export const QboCustomer = z.object({
  id: z.string(),
  syncToken: z.string(),
  name: z.string(),
  companyName: z.string().nullable(),
  givenName: z.string().nullable(),
  familyName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  /** What the customer owes across its open invoices. */
  balance: DecimalString.nullable(),
  currency: z.string().nullable(),
  active: z.boolean(),
});
export type QboCustomer = z.infer<typeof QboCustomer>;

export function toCustomer(raw: unknown): QboCustomer {
  const c = QboCustomerRaw.parse(raw);
  return {
    id: c.Id,
    syncToken: c.SyncToken ?? "0",
    name: c.DisplayName,
    companyName: c.CompanyName ?? null,
    givenName: c.GivenName ?? null,
    familyName: c.FamilyName ?? null,
    email: c.PrimaryEmailAddr?.Address ?? null,
    phone: c.PrimaryPhone?.FreeFormNumber ?? null,
    balance: qboOptionalAmount(c.Balance),
    currency: c.CurrencyRef?.value?.toUpperCase() ?? null,
    active: c.Active !== false,
  };
}

/** A Payment: money received, and the invoices it went to. */
export const QboPayment = z.object({
  id: z.string(),
  syncToken: z.string(),
  txnDate: z.string().nullable(),
  customer: Named.nullable(),
  total: DecimalString,
  unapplied: DecimalString.nullable(),
  currency: z.string(),
  reference: z.string().nullable(),
  /** The invoices it paid, by QuickBooks id, with the amount applied to each. */
  applied: z.array(z.object({ invoiceId: z.string(), amount: DecimalString })),
});
export type QboPayment = z.infer<typeof QboPayment>;

export function toPayment(raw: unknown): QboPayment {
  const p = QboPaymentRaw.parse(raw);
  const applied: QboPayment["applied"] = [];
  for (const line of p.Line ?? []) {
    for (const linked of line.LinkedTxn ?? []) {
      if (linked.TxnType !== "Invoice") continue;
      applied.push({ invoiceId: linked.TxnId, amount: qboAmount(line.Amount ?? 0) });
    }
  }
  return {
    id: p.Id,
    syncToken: p.SyncToken ?? "0",
    txnDate: p.TxnDate ?? null,
    customer: p.CustomerRef ? { id: p.CustomerRef.value, name: p.CustomerRef.name ?? null } : null,
    total: qboAmount(p.TotalAmt),
    unapplied: qboOptionalAmount(p.UnappliedAmt),
    currency: (p.CurrencyRef?.value ?? "USD").toUpperCase(),
    reference: p.PaymentRefNum ?? null,
    applied,
  };
}

/** A decimal that goes onto the wire as a JSON number, written from its text. */
export class WireDecimal {
  constructor(readonly text: string) {}
}

/** A money or quantity string → its wire form (trailing zeros dropped: `831.2500` → `831.25`). */
export function wire(value: string): WireDecimal {
  return new WireDecimal(dec(value).toString());
}

const MARK = "\u0000qbodec:";

/**
 * JSON for QBO with WireDecimal values written as numbers straight from their decimal text, so an
 * amount never passes through a JS float on its way out.
 */
// DECISION: QBO takes amounts as JSON numbers. Converting a decimal string to a number and back is
// exact for any 2-place amount, but invariant 6 says no floats: the number is written as text.
export function qboJson(body: unknown): string {
  const text = JSON.stringify(body, (_key, value) =>
    value instanceof WireDecimal ? `${MARK}${value.text}` : value,
  );
  return text.replace(/"\\u0000qbodec:(-?\d+(?:\.\d+)?)"/g, "$1");
}

// ── P-2: QuickBooks ingredients (docs/plan.md §1.64) ────────────────────────────────────────────

const RawId = z.union([z.string(), z.number()]).transform(String);
const RawRef = z.looseObject({ value: RawId, name: z.string().optional() });

const QboAccountRaw = z.looseObject({
  Id: RawId,
  SyncToken: RawId.optional(),
  Name: z.string(),
  FullyQualifiedName: z.string().optional(),
  AccountType: z.string().optional(),
  AccountSubType: z.string().optional(),
  Active: z.boolean().optional(),
  CurrencyRef: RawRef.optional(),
});

/** An account from the chart of accounts: where a line's cost is booked. */
export const QboAccount = z.object({
  id: z.string(),
  name: z.string(),
  /** With its parents: "Job Materials:Freight In". */
  fullyQualifiedName: z.string(),
  accountType: z.string().nullable(),
  accountSubType: z.string().nullable(),
  active: z.boolean(),
  currency: z.string().nullable(),
});
export type QboAccount = z.infer<typeof QboAccount>;

export function toAccount(raw: unknown): QboAccount {
  const a = QboAccountRaw.parse(raw);
  return {
    id: a.Id,
    name: a.Name,
    fullyQualifiedName: a.FullyQualifiedName ?? a.Name,
    accountType: a.AccountType ?? null,
    accountSubType: a.AccountSubType ?? null,
    active: a.Active !== false,
    currency: a.CurrencyRef?.value.toUpperCase() ?? null,
  };
}

const QboClassRaw = z.looseObject({
  Id: RawId,
  Name: z.string(),
  FullyQualifiedName: z.string().optional(),
  Active: z.boolean().optional(),
});

/** A class: how a company tracks costs by job, location or department, when it uses classes. */
export const QboClass = z.object({
  id: z.string(),
  name: z.string(),
  fullyQualifiedName: z.string(),
  active: z.boolean(),
});
export type QboClass = z.infer<typeof QboClass>;

export function toClass(raw: unknown): QboClass {
  const c = QboClassRaw.parse(raw);
  return {
    id: c.Id,
    name: c.Name,
    fullyQualifiedName: c.FullyQualifiedName ?? c.Name,
    active: c.Active !== false,
  };
}

export const QboPoStatus = z.enum(["Open", "Closed"]);

const QboPurchaseOrderRaw = QboTransactionRaw.extend({
  POStatus: z.string().optional(),
  Memo: z.string().optional(),
});

/** A PurchaseOrder: what the company ordered from a vendor, open until it is received or closed. */
export const QboPurchaseOrder = z.object({
  id: z.string(),
  syncToken: z.string(),
  docNumber: z.string().nullable(),
  txnDate: z.string().nullable(),
  /** The date the order is expected (QuickBooks' `DueDate`). */
  dueDate: z.string().nullable(),
  vendor: Named.nullable(),
  status: z.string().nullable(),
  total: DecimalString,
  currency: z.string(),
  /** The order's private memo: client text, data only (invariant 9). */
  memo: z.string().nullable(),
  lines: z.array(QboTxnLine),
});
export type QboPurchaseOrder = z.infer<typeof QboPurchaseOrder>;

export function toPurchaseOrder(raw: unknown): QboPurchaseOrder {
  const p = QboPurchaseOrderRaw.parse(raw);
  return {
    id: p.Id,
    syncToken: p.SyncToken ?? "0",
    docNumber: p.DocNumber ?? null,
    txnDate: p.TxnDate ?? null,
    dueDate: p.DueDate ?? null,
    vendor: p.VendorRef ? { id: p.VendorRef.value, name: p.VendorRef.name ?? null } : null,
    status: p.POStatus ?? null,
    total: qboAmount(p.TotalAmt),
    currency: (p.CurrencyRef?.value ?? "USD").toUpperCase(),
    memo: p.PrivateNote ?? null,
    lines: txnLines(p.Line),
  };
}
