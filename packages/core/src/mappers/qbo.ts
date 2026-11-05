// QuickBooks Online raw records → shared records (ARCHITECTURE §5.2, §6.2). The qbo connector stores
// each entity as it came (`raw_record(connector='qbo')`); these mappers turn Purchase, Bill and
// VendorCredit payloads into transactions with their lines, and Vendor payloads into vendors.
// Money stays decimal: QBO sends amounts as JSON numbers, which are read as their shortest decimal
// text and never computed on as floats (invariant 6).

import { z } from "zod";
import { CurrencyCode, dec, toNumeric } from "../money";
import { MapperError, type TransactionInput, type TransactionLineInput } from "./upload";

export const QBO_CONNECTOR_ID = "qbo";

/** Entities that become transactions. */
export const QBO_TRANSACTION_ENTITIES = ["Purchase", "Bill", "VendorCredit"] as const;
export type QboTransactionEntity = (typeof QBO_TRANSACTION_ENTITIES)[number];

/** Everything sync brings in (ARCHITECTURE §6.2), in the order an initial sync reads them. */
// DECISION: vendors and items first (so transactions find their vendor), attachments last (so the
// transactions they hang on already exist when their files are linked).
export const QBO_SYNCED_ENTITIES = [
  "Vendor",
  "Item",
  "Purchase",
  "Bill",
  "VendorCredit",
  "Attachable",
] as const;
export type QboEntity = (typeof QBO_SYNCED_ENTITIES)[number];

export function isQboTransactionEntity(v: string): v is QboTransactionEntity {
  return (QBO_TRANSACTION_ENTITIES as readonly string[]).includes(v);
}

/**
 * A QBO amount (a JSON number, or a numeric string) → a `numeric(14,4)` string.
 */
// DECISION: QBO's JSON carries amounts as numbers. `JSON.parse` gives the closest double, and
// `Number#toString` gives back the shortest decimal that names that double, which for any amount
// QBO stores (at most 2 places for money, a few more for unit prices and quantities) is exactly
// what QBO sent. The decimal is taken from that text; no arithmetic ever happens on the float.
export function qboAmount(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MapperError(`not an amount: ${String(value)}`);
    return toNumeric(dec(String(value)));
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return toNumeric(dec(value.trim()));
  }
  throw new MapperError(`not an amount: ${JSON.stringify(value)}`);
}

/** Like qboAmount, but null for an absent value. */
export function qboOptionalAmount(value: unknown): string | null {
  return value === undefined || value === null ? null : qboAmount(value);
}

const Ref = z.looseObject({
  value: z.union([z.string(), z.number()]).transform(String),
  name: z.string().optional(),
  type: z.string().optional(),
});
export type QboRef = z.infer<typeof Ref>;

const Num = z.union([z.number(), z.string()]);

const AccountDetail = z.looseObject({
  AccountRef: Ref.optional(),
  CustomerRef: Ref.optional(),
  ClassRef: Ref.optional(),
  BillableStatus: z.string().optional(),
  TaxCodeRef: Ref.optional(),
});
const ItemDetail = z.looseObject({
  ItemRef: Ref.optional(),
  UnitPrice: Num.optional(),
  Qty: Num.optional(),
  CustomerRef: Ref.optional(),
  ClassRef: Ref.optional(),
  BillableStatus: z.string().optional(),
  TaxCodeRef: Ref.optional(),
});

export const QboLine = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String).optional(),
  LineNum: Num.optional(),
  Description: z.string().optional(),
  Amount: Num.optional(),
  DetailType: z.string(),
  AccountBasedExpenseLineDetail: AccountDetail.optional(),
  ItemBasedExpenseLineDetail: ItemDetail.optional(),
});
export type QboLine = z.infer<typeof QboLine>;

const MetaData = z.looseObject({
  CreateTime: z.string().optional(),
  LastUpdatedTime: z.string().optional(),
});

/** Purchase, Bill and VendorCredit as far as the mappers read them; everything else is kept. */
export const QboTransactionRaw = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  MetaData: MetaData.optional(),
  DocNumber: z.string().optional(),
  TxnDate: z.string().optional(),
  DueDate: z.string().optional(),
  CurrencyRef: Ref.optional(),
  PrivateNote: z.string().optional(),
  VendorRef: Ref.optional(),
  EntityRef: Ref.optional(),
  AccountRef: Ref.optional(),
  PaymentType: z.string().optional(),
  Credit: z.boolean().optional(),
  Line: z.array(QboLine).optional(),
  TotalAmt: Num,
  TxnTaxDetail: z.looseObject({ TotalTax: Num.optional() }).optional(),
});
export type QboTransactionRaw = z.infer<typeof QboTransactionRaw>;

export const QboVendorRaw = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  DisplayName: z.string().min(1),
  CompanyName: z.string().optional(),
  PrintOnCheckName: z.string().optional(),
  Active: z.boolean().optional(),
  PrimaryEmailAddr: z.looseObject({ Address: z.string().optional() }).optional(),
});
export type QboVendorRaw = z.infer<typeof QboVendorRaw>;

export const QboItemRaw = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  Name: z.string(),
  Sku: z.string().optional(),
  Description: z.string().optional(),
  PurchaseDesc: z.string().optional(),
  Type: z.string().optional(),
  Active: z.boolean().optional(),
  PurchaseCost: Num.optional(),
  UnitPrice: Num.optional(),
  ExpenseAccountRef: Ref.optional(),
});
export type QboItemRaw = z.infer<typeof QboItemRaw>;

export const QboAttachableRaw = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  FileName: z.string().optional(),
  ContentType: z.string().optional(),
  Size: Num.optional(),
  Note: z.string().optional(),
  TempDownloadUri: z.string().optional(),
  AttachableRef: z
    .array(
      z.looseObject({
        EntityRef: Ref.optional(),
        IncludeOnSend: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type QboAttachableRaw = z.infer<typeof QboAttachableRaw>;

function parse<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.output<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new MapperError(`not a QuickBooks ${what}: ${r.error.issues[0]?.message}`);
  return r.data;
}

function qty(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return qboAmount(value);
}

/** The expense lines of a Bill, Purchase or VendorCredit (both detail types; others are skipped). */
export function mapQboLines(lines: readonly QboLine[] | undefined): TransactionLineInput[] {
  const out: TransactionLineInput[] = [];
  for (const l of lines ?? []) {
    if (l.DetailType === "AccountBasedExpenseLineDetail") {
      const d = l.AccountBasedExpenseLineDetail;
      out.push({
        lineNo: out.length + 1,
        detailType: "account",
        externalLineId: l.Id ?? null,
        accountRef: d?.AccountRef ? (d.AccountRef.name ?? d.AccountRef.value) : null,
        accountId: d?.AccountRef?.value ?? null,
        itemRef: null,
        itemId: null,
        description: l.Description ?? null,
        qty: null,
        unitPrice: null,
        amount: qboAmount(l.Amount ?? 0),
      });
    } else if (l.DetailType === "ItemBasedExpenseLineDetail") {
      const d = l.ItemBasedExpenseLineDetail;
      out.push({
        lineNo: out.length + 1,
        detailType: "item",
        externalLineId: l.Id ?? null,
        accountRef: null,
        accountId: null,
        itemRef: d?.ItemRef ? (d.ItemRef.name ?? d.ItemRef.value) : null,
        itemId: d?.ItemRef?.value ?? null,
        description: l.Description ?? null,
        qty: qty(d?.Qty),
        unitPrice: qty(d?.UnitPrice),
        amount: qboAmount(l.Amount ?? 0),
      });
    }
    // DECISION: other line kinds (DescriptionOnly, GroupLine, tax lines) carry no expense; they stay
    // in raw_record and are not transaction lines.
  }
  return out;
}

const KIND: Record<QboTransactionEntity, TransactionInput["kind"]> = {
  Purchase: "purchase",
  Bill: "bill",
  VendorCredit: "vendor_credit",
};

/**
 * A Purchase, Bill or VendorCredit → a transaction with its lines. The external id is QBO's
 * `<entity>:<Id>` (ids are unique per entity type, not across them).
 */
// DECISION: a Purchase with `Credit: true` (a card refund) is a `vendor_credit`, as a negative row
// in an uploaded CSV is. A purchase's payee is its vendor only when the payee is a Vendor; its
// purchaser is the paying account (the card), since QBO has no cardholder field.
export function mapQboTransaction(entityType: string, raw: unknown): TransactionInput {
  if (!isQboTransactionEntity(entityType)) {
    throw new MapperError(`not a QuickBooks transaction type: ${entityType}`);
  }
  const t = parse(QboTransactionRaw, raw, entityType);
  const vendorRef =
    entityType === "Purchase"
      ? t.EntityRef && (t.EntityRef.type === undefined || t.EntityRef.type === "Vendor")
        ? t.EntityRef
        : undefined
      : t.VendorRef;
  const currency = (t.CurrencyRef?.value ?? "USD").toUpperCase();
  if (!CurrencyCode.safeParse(currency).success) {
    throw new MapperError(`not a currency: ${JSON.stringify(currency)}`);
  }
  const total = dec(qboAmount(t.TotalAmt)).abs();
  const kind = entityType === "Purchase" && t.Credit === true ? "vendor_credit" : KIND[entityType];
  const txnDate = t.TxnDate && /^\d{4}-\d{2}-\d{2}$/.test(t.TxnDate) ? t.TxnDate : null;
  return {
    kind,
    connector: QBO_CONNECTOR_ID,
    externalId: qboTransactionExternalId(entityType, t.Id),
    vendorName: vendorRef?.name ?? null,
    vendorExternalId: vendorRef?.value ?? null,
    txnDate,
    total: toNumeric(total),
    currency,
    memo: t.PrivateNote ?? null,
    purchaserRef: entityType === "Purchase" ? (t.AccountRef?.name ?? null) : null,
    paymentType: entityType === "Purchase" ? (t.PaymentType ?? null) : null,
    lines: mapQboLines(t.Line),
    ext: {
      qbo: {
        entity: entityType,
        id: t.Id,
        syncToken: t.SyncToken ?? null,
        docNumber: t.DocNumber ?? null,
        dueDate: t.DueDate ?? null,
        tax: t.TxnTaxDetail?.TotalTax === undefined ? null : qboAmount(t.TxnTaxDetail.TotalTax),
      },
    },
  };
}

export function qboTransactionExternalId(entityType: string, id: string): string {
  return `${entityType}:${id}`;
}

export interface VendorInput {
  externalId: string;
  name: string;
  /** Other names the same vendor goes by (company name, name on checks). */
  aliases: string[];
  active: boolean;
  email: string | null;
}

/** A Vendor → a vendor: its display name, with the company and check names as aliases. */
export function mapQboVendor(raw: unknown): VendorInput {
  const v = parse(QboVendorRaw, raw, "Vendor");
  const name = v.DisplayName.trim();
  const aliases = [v.CompanyName, v.PrintOnCheckName]
    .map((a) => a?.trim())
    .filter((a): a is string => Boolean(a) && a !== name);
  return {
    externalId: v.Id,
    name,
    aliases: [...new Set(aliases)],
    active: v.Active !== false,
    email: v.PrimaryEmailAddr?.Address ?? null,
  };
}

export interface AttachableInput {
  externalId: string;
  /** Null for a note with no file. */
  fileName: string | null;
  contentType: string | null;
  size: number | null;
  note: string | null;
  /** What it is attached to, e.g. `[{ entity: "Bill", id: "146" }]`. */
  refs: { entity: string; id: string }[];
}

export function mapQboAttachable(raw: unknown): AttachableInput {
  const a = parse(QboAttachableRaw, raw, "Attachable");
  const size = a.Size === undefined ? null : Number(a.Size);
  return {
    externalId: a.Id,
    fileName: a.FileName ?? null,
    contentType: a.ContentType ?? null,
    size: size !== null && Number.isFinite(size) ? size : null,
    note: a.Note ?? null,
    refs: (a.AttachableRef ?? [])
      .map((r) => r.EntityRef)
      .filter((r): r is QboRef => Boolean(r?.type))
      .map((r) => ({ entity: r.type as string, id: r.value })),
  };
}
