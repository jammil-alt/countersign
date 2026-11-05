// QuickBooks records as the qbo tools return them: plain shapes with decimal strings for money
// (never JS numbers, invariant 6), ids and SyncTokens kept so a write can name the version it read.
// Also the one place a decimal goes back onto the wire as a JSON number.

import {
  DecimalString,
  dec,
  mapQboLines,
  QboAttachableRaw,
  QboItemRaw,
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
});
export type QboTxnLine = z.infer<typeof QboTxnLine>;

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
    lines: mapQboLines(t.Line).map((l) => ({
      id: l.externalLineId,
      detailType: l.detailType,
      description: l.description,
      amount: l.amount,
      account: l.accountId ? { id: l.accountId, name: l.accountRef } : null,
      item: l.itemId ? { id: l.itemId, name: l.itemRef } : null,
      qty: l.qty,
      unitPrice: l.unitPrice,
    })),
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
