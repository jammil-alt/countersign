// Raw records → shared records (ARCHITECTURE §6.1: normalization lives in core, per connector).
// The upload connector stores each row of a purchases CSV as `raw_record(connector='upload',
// entity_type='Purchase')`; `mapUploadPurchase` turns its payload into a TransactionInput.

import { z } from "zod";
import { CurrencyCode, dec, toNumeric } from "../money";

/** One expense line of a transaction (QBO's account and item lines). */
export interface TransactionLineInput {
  lineNo: number;
  detailType: "account" | "item";
  /** The line's id in the connected tool. */
  externalLineId: string | null;
  /** The account's or item's name, as people read it; the ids beside them. */
  accountRef: string | null;
  accountId: string | null;
  itemRef: string | null;
  itemId: string | null;
  description: string | null;
  /** numeric(14,4) strings. */
  qty: string | null;
  unitPrice: string | null;
  amount: string;
}

/** What any connector's mapper produces for a transaction (upload, QBO). */
export interface TransactionInput {
  kind: "purchase" | "bill" | "vendor_credit";
  connector: string;
  externalId: string;
  vendorName: string | null;
  /** yyyy-mm-dd */
  txnDate: string | null;
  /** numeric(14,4) string. */
  total: string;
  currency: string;
  memo: string | null;
  purchaserRef: string | null;
  paymentType: string | null;
  /** The vendor's id in the connected tool, when it has one. */
  vendorExternalId?: string | null;
  /** Expense lines, where the tool has them (QBO); absent for a CSV row. */
  lines?: TransactionLineInput[];
  /** Kept on `transaction.ext` (e.g. `{ qbo: { docNumber, syncToken } }`). */
  ext?: Record<string, unknown>;
}

/** One CSV row as stored: the cells by normalized header, plus where it came from. */
export const UploadPurchaseRaw = z.object({
  /** Header (lowercased, trimmed) → cell. */
  cells: z.record(z.string(), z.string()),
  file: z.object({ sha256: z.string(), filename: z.string(), row: z.number().int().positive() }),
});
export type UploadPurchaseRaw = z.infer<typeof UploadPurchaseRaw>;

// DECISION: the CSV's columns are found by common header names (date, vendor, amount, memo, plus
// optional purchaser, payment and currency); anything else in the row is kept in raw_record only.
const COLUMNS = {
  date: ["date", "txn date", "transaction date", "purchase date", "posted date"],
  vendor: ["vendor", "payee", "merchant", "supplier", "description"],
  amount: ["amount", "total", "debit", "charge"],
  memo: ["memo", "notes", "note", "job", "reference"],
  purchaser: ["purchaser", "cardholder", "employee", "card member"],
  payment: ["payment", "payment type", "card", "account"],
  currency: ["currency"],
} as const;

export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function pick(cells: Record<string, string>, names: readonly string[]): string | null {
  for (const n of names) {
    const v = cells[n]?.trim();
    if (v) return v;
  }
  return null;
}

/** Which required columns a header row lacks (date, vendor, amount). */
export function missingPurchaseColumns(headers: readonly string[]): string[] {
  const have = new Set(headers.map(normalizeHeader));
  return (["date", "vendor", "amount"] as const).filter(
    (k) => !COLUMNS[k].some((n) => have.has(n)),
  );
}

export class MapperError extends Error {
  override name = "MapperError";
}

/** `2026-11-02`, `11/02/2026`, `11/2/26`, `2026/11/02` → `2026-11-02`. */
export function parseCsvDate(value: string): string {
  const v = value.trim();
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(v);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else {
    // DECISION: slashed dates are US order (month/day), as the shop's card exports are.
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(v);
    if (!match) throw new MapperError(`not a date: ${JSON.stringify(value)}`);
    m = Number(match[1]);
    d = Number(match[2]);
    y = Number(match[3]);
    if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new MapperError(`not a date: ${JSON.stringify(value)}`);
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `$1,250.00`, `(12.50)`, `-12.50`, `1250` → a numeric(14,4) string. Never a JS float. */
export function parseCsvAmount(value: string): string {
  let v = value.trim().replace(/[$,\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  if (v.startsWith("-")) {
    negative = !negative;
    v = v.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(v)) throw new MapperError(`not an amount: ${JSON.stringify(value)}`);
  const n = dec(v);
  return toNumeric(negative ? n.negated() : n);
}

/**
 * A purchases CSV row → a transaction. A negative amount is a refund, kept as a `vendor_credit`
 * with a positive total. The external id is the raw record's (file sha256 + row), so importing
 * the same file twice makes no second transaction.
 */
export function mapUploadPurchase(raw: unknown, externalId: string): TransactionInput {
  const { cells } = UploadPurchaseRaw.parse(raw);
  const dateCell = pick(cells, COLUMNS.date);
  const vendorCell = pick(cells, COLUMNS.vendor);
  const amountCell = pick(cells, COLUMNS.amount);
  if (!dateCell) throw new MapperError("the row has no date");
  if (!amountCell) throw new MapperError("the row has no amount");
  const amount = parseCsvAmount(amountCell);
  const negative = dec(amount).isNegative();
  const currency = (pick(cells, COLUMNS.currency) ?? "USD").toUpperCase();
  if (!CurrencyCode.safeParse(currency).success) {
    throw new MapperError(`not a currency: ${JSON.stringify(currency)}`);
  }
  return {
    kind: negative ? "vendor_credit" : "purchase",
    connector: "upload",
    externalId,
    vendorName: vendorCell,
    txnDate: parseCsvDate(dateCell),
    total: toNumeric(dec(amount).abs()),
    currency,
    memo: pick(cells, COLUMNS.memo),
    purchaserRef: pick(cells, COLUMNS.purchaser),
    paymentType: pick(cells, COLUMNS.payment),
  };
}

const SUFFIXES =
  /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|lp|llp|plc)\b\.?/g;

/**
 * The key a vendor is found by: lowercase, `&` as "and", punctuation and company suffixes gone.
 * "Acme Lumber Co., Inc." and "ACME LUMBER" are the same vendor.
 */
export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,'’"()]/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
