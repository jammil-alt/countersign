// Bills behind invoices (docs/plan.md §1.30, "Bill clerk"): deterministic checks that come before
// any model and any write (invariant 7). `matchBill` finds the one synced bill an invoice belongs
// to; `planBill` says, from the bill as the tool has it now, whether its lines can be itemized from
// the invoice; `billLines` turns a chosen item or account per invoice line into the new lines,
// with every amount, quantity and price taken from the invoice as read, never from a model.

import { type Decimal, dec, type ExtractedHeader, toNumeric } from "@countersign/core";
import { document, rawRecord, type Tx, transaction } from "@countersign/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { LINK_WINDOW_DAYS, latestExtraction, shiftDate, vendorForDocument } from "./link";
import { DocumentError } from "./store";

// ── Matching an invoice to a synced bill ────────────────────────────────────────────────────────

export interface MatchBillInput {
  documentId: string;
  /** The connector whose bills are searched (`qbo`). */
  connector: string;
  /** Days either side of the invoice date. */
  windowDays?: number;
}

export interface MatchedInvoice {
  documentId: string;
  extractionId: string;
  vendorName: string;
  number: string;
  date: string;
  total: string;
  currency: string;
}

export interface MatchedBill {
  transactionId: string;
  /** The bill's own id in the connected tool (QuickBooks' `Id`), for its read and write tools. */
  recordId: string;
  docNumber: string | null;
  txnDate: string | null;
  total: string;
  memo: string | null;
}

export interface MatchBillResult {
  status: "matched" | "none" | "ambiguous";
  /** Plain words: why there is no single bill, or what matched. */
  reason: string;
  invoice: MatchedInvoice;
  bill: MatchedBill | null;
  /** Transaction ids: the bills that fit (ambiguous), or the vendor's bills in the window (none). */
  candidates: string[];
  sources: string[];
}

type TransactionRow = typeof transaction.$inferSelect;

/**
 * What a connector keeps about a record under `ext.<connector>`: its own id, its document number,
 * and whether it was deleted in the tool. The QuickBooks mapper writes all three.
 */
// DECISION: the document number and deletion are read from `ext.<connector>`, where the mapper put
// them; the record id falls back to the raw record's external id, which every connector keeps.
function connectorExt(t: TransactionRow): { id?: string; docNumber?: string; deleted?: boolean } {
  const ext = (t.ext as Record<string, unknown>)[t.connector];
  if (!ext || typeof ext !== "object") return {};
  const e = ext as Record<string, unknown>;
  return {
    ...(typeof e.id === "string" ? { id: e.id } : {}),
    ...(typeof e.docNumber === "string" && e.docNumber.trim() ? { docNumber: e.docNumber } : {}),
    ...(e.deleted === true ? { deleted: true } : {}),
  };
}

const docKey = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Whether an invoice number and a bill's document number can be the same document. */
// DECISION: document numbers are compared on letters and digits only, and one may carry a prefix
// the other doesn't ("INV-20418" and "20418"); a bill with no number is not ruled out by it.
export function docNumbersAgree(invoiceNumber: string, billNumber: string | null): boolean {
  if (billNumber === null) return true;
  const a = docKey(invoiceNumber);
  const b = docKey(billNumber);
  if (!a || !b) return true;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

async function recordIdOf(tx: Tx, tenantId: string, t: TransactionRow): Promise<string> {
  const own = connectorExt(t).id;
  if (own) return own;
  if (t.sourceRawRecordId) {
    const [raw] = await tx
      .select({ externalId: rawRecord.externalId })
      .from(rawRecord)
      .where(and(eq(rawRecord.id, t.sourceRawRecordId), eq(rawRecord.tenantId, tenantId)));
    if (raw) return raw.externalId;
  }
  return t.externalId;
}

/**
 * The one bill of the connector an invoice belongs to: the invoice's vendor (by normalized name,
 * an alias, or the forwarding sender's domain), the same currency and total to the cent, a date
 * within the window, and a document number that agrees when both have one. Bills deleted in the
 * tool are left out. Reads only; a document not read yet is an error.
 */
// DECISION: the match runs over the bills synced from the tool (QuickBooks: CDC every 15 minutes
// and on its webhook), not over live queries: the vendor link (aliases, forwarding domains) and our
// transaction ids, cited as sources, live here, and one query covers every vendor name. The bill
// is then read live (`qbo.bill.query`) and `planBill` checks that copy again before any proposal.
// The window is linking's ± 7 days unless the step says otherwise.
export async function matchBill(
  tx: Tx,
  tenantId: string,
  input: MatchBillInput,
): Promise<MatchBillResult> {
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.id, input.documentId), eq(document.tenantId, tenantId)));
  if (!doc) throw new DocumentError("not_found", `document ${input.documentId} not found`);
  const x = await latestExtraction(tx, tenantId, doc.id);
  if (!x) throw new DocumentError("not_found", "the document has not been read yet");
  const header = x.header as unknown as ExtractedHeader;
  const invoice: MatchedInvoice = {
    documentId: doc.id,
    extractionId: x.id,
    vendorName: header.vendorName,
    number: header.invoiceNumber,
    date: header.invoiceDate,
    total: x.total,
    currency: x.currency,
  };
  const base = [doc.id, x.id];
  const days = input.windowDays ?? LINK_WINDOW_DAYS;
  const from = shiftDate(header.invoiceDate, -days);
  const to = shiftDate(header.invoiceDate, days);
  const v = await vendorForDocument(tx, tenantId, doc, header);
  if (!v) {
    return {
      status: "none",
      reason: `No vendor in your records is named ${header.vendorName}.`,
      invoice,
      bill: null,
      candidates: [],
      sources: base,
    };
  }
  const near = (
    await tx
      .select()
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          eq(transaction.connector, input.connector),
          eq(transaction.kind, "bill"),
          eq(transaction.vendorId, v.id),
          gte(transaction.txnDate, from),
          lte(transaction.txnDate, to),
        ),
      )
      .orderBy(transaction.txnDate, transaction.id)
      .limit(50)
  ).filter((t) => !connectorExt(t).deleted);
  let fits = near.filter(
    (t) =>
      t.currency === x.currency &&
      dec(t.total).equals(dec(x.total)) &&
      docNumbersAgree(header.invoiceNumber, connectorExt(t).docNumber ?? null),
  );
  // Several fit: the one this document is already linked to, else those with the same number.
  if (fits.length > 1) {
    const linked = fits.filter((t) => t.id === doc.transactionId);
    const sameNumber = fits.filter(
      (t) => docKey(connectorExt(t).docNumber ?? "") === docKey(header.invoiceNumber),
    );
    if (linked.length === 1) fits = linked;
    else if (sameNumber.length === 1) fits = sameNumber;
  }
  const total = toNumeric(dec(x.total));
  const window = `between ${from} and ${to}`;
  if (fits.length === 0) {
    const candidates = near.map((t) => t.id);
    return {
      status: "none",
      reason: `No bill from ${v.name} for ${x.currency} ${dec(total).toFixed(2)} dated ${window}${near.length ? `; ${near.length} other bill${near.length === 1 ? "" : "s"} from them in that time` : ""}.`,
      invoice,
      bill: null,
      candidates,
      sources: [...base, ...candidates],
    };
  }
  if (fits.length > 1) {
    const candidates = fits.map((t) => t.id);
    return {
      status: "ambiguous",
      reason: `${fits.length} bills from ${v.name} for ${x.currency} ${dec(total).toFixed(2)} are dated ${window}.`,
      invoice,
      bill: null,
      candidates,
      sources: [...base, ...candidates],
    };
  }
  const t = fits[0] as TransactionRow;
  const docNumber = connectorExt(t).docNumber ?? null;
  return {
    status: "matched",
    reason: `Bill ${docNumber ?? t.externalId} from ${v.name} for ${x.currency} ${dec(total).toFixed(2)}.`,
    invoice,
    bill: {
      transactionId: t.id,
      recordId: await recordIdOf(tx, tenantId, t),
      docNumber,
      txnDate: t.txnDate,
      total: t.total,
      memo: t.memo,
    },
    candidates: [t.id],
    sources: [...base, t.id],
  };
}

// ── The bill as its tool has it now ─────────────────────────────────────────────────────────────

/** One line of a bill as a connector's read tool returns it (`qbo.bill.query`). */
export interface ToolBillLine {
  id: string | null;
  amount: string;
  account: { id: string; name: string | null } | null;
  item: { id: string; name: string | null } | null;
}

/** A bill as a connector's read tool returns it, read just before planning. */
export interface ToolBill {
  id: string;
  syncToken: string;
  docNumber: string | null;
  vendor: { id: string; name: string | null } | null;
  total: string;
  currency: string;
  memo: string | null;
  tax: string | null;
  lines: ToolBillLine[];
}

/** An invoice line as read (the latest extraction). */
export interface InvoiceLine {
  lineNo: number;
  description: string;
  qty: string;
  unitPrice: string;
  extPrice: string;
}

export interface InvoiceForBill {
  documentId: string;
  extractionId: string;
  /** The document's source, and the transaction it is linked to. */
  source: string;
  transactionId: string | null;
  header: { vendorName: string; invoiceNumber: string; poNumber: string | null };
  total: string;
  lines: InvoiceLine[];
}

export interface BillPlan {
  decision: "itemize" | "nothing_to_do" | "needs_person";
  reason: string;
  vendorName: string;
  invoiceNumber: string;
  billNumber: string;
  invoiceLineCount: number;
  billLineCount: number;
  lineTotal: string;
  billTotal: string;
  currency: string;
  /** The invoice is not already the bill's own attachment (synced from the tool). */
  attach: boolean;
  /** The bill has no memo: it gets `memo`. */
  setMemo: boolean;
  memo: string;
}

const MEMO_MAX = 4000;
const money = (v: string | Decimal) => dec(v).toFixed(2);

/** At most two decimals and not negative: a line the tool can take as it is. */
function plainAmount(v: string): boolean {
  const d = dec(v);
  return !d.isNegative() && d.equals(d.toDecimalPlaces(2));
}

function sum(values: string[]): Decimal {
  return values.reduce((s, v) => s.plus(dec(v)), dec("0"));
}

/**
 * Whether a bill, as its tool has it now, can take the invoice's lines: itemize only when the
 * bill has fewer lines than the invoice, no tax, the same total as the invoice, and the invoice's
 * lines add up to that total exactly. A bill that already has as many lines is left alone. The
 * memo is the invoice number and the vendor's reference, only for a bill without one.
 */
// DECISION: the memo reads "<vendor> invoice <number>", plus "PO <po>" when the invoice prints one;
// the vendor is QuickBooks' own name for it (what people there read), else the invoice's.
export function planBill(invoice: InvoiceForBill, bill: ToolBill | null): BillPlan {
  const lineTotal = sum(invoice.lines.map((l) => l.extPrice));
  const vendorName = bill?.vendor?.name ?? invoice.header.vendorName;
  const memo = [
    `${vendorName} invoice ${invoice.header.invoiceNumber}`,
    ...(invoice.header.poNumber ? [`PO ${invoice.header.poNumber}`] : []),
  ]
    .join(", ")
    .slice(0, MEMO_MAX);
  const base = {
    vendorName,
    invoiceNumber: invoice.header.invoiceNumber,
    billNumber: bill ? (bill.docNumber ?? bill.id) : "",
    invoiceLineCount: invoice.lines.length,
    billLineCount: bill?.lines.length ?? 0,
    lineTotal: money(lineTotal),
    billTotal: bill ? money(bill.total) : "0.00",
    currency: bill?.currency ?? "USD",
    // The bill's own attachment (synced from the tool and linked to it) is already there.
    attach: !(invoice.source === "connector" && invoice.transactionId !== null),
    setMemo: bill !== null && (bill.memo ?? "").trim() === "",
    memo,
  };
  const person = (reason: string): BillPlan => ({ ...base, decision: "needs_person", reason });
  if (!bill) return person("The bill is no longer in QuickBooks.");
  if (!dec(bill.total).equals(dec(invoice.total))) {
    return person(
      `The bill's total is ${money(bill.total)} now, not the invoice's ${money(invoice.total)}.`,
    );
  }
  if (bill.lines.length >= invoice.lines.length) {
    return {
      ...base,
      decision: "nothing_to_do",
      reason: `The bill already has ${bill.lines.length} line${bill.lines.length === 1 ? "" : "s"}; the invoice has ${invoice.lines.length}.`,
    };
  }
  if (bill.tax !== null && !dec(bill.tax).isZero()) {
    return person(`The bill has tax (${money(bill.tax)}); itemizing could change it.`);
  }
  if (bill.lines.some((l) => l.id === null)) {
    return person("A line on the bill has no id, so it can't be replaced.");
  }
  if (!lineTotal.equals(dec(bill.total))) {
    return person(
      `The invoice's lines add up to ${money(lineTotal)} and the bill to ${money(bill.total)}: freight, surcharges or tax are not on the lines.`,
    );
  }
  const odd = invoice.lines.filter((l) => !plainAmount(l.extPrice));
  if (odd.length > 0) {
    return person(
      `Line ${odd.map((l) => l.lineNo).join(", ")} of the invoice is a credit or has more than two decimals.`,
    );
  }
  return {
    ...base,
    decision: "itemize",
    reason: `${invoice.lines.length} invoice lines for the bill's ${bill.lines.length}, total unchanged at ${money(bill.total)}.`,
  };
}

// ── New lines from the chosen items and accounts ────────────────────────────────────────────────

export interface LineChoice {
  lineNo: number;
  itemId?: string | undefined;
  accountId?: string | undefined;
}

export interface NewBillLine {
  itemId?: string;
  accountId?: string;
  description: string;
  qty?: string;
  unitPrice?: string;
  amount: string;
}

export interface BillLinesChange {
  id: string;
  syncToken: string;
  expectedTotal: string;
  currency: string;
  replaceLineIds: string[];
  lines: NewBillLine[];
}

export class BillLinesError extends Error {
  override name = "BillLinesError";
}

const DESCRIPTION_MAX = 4000;

/**
 * The change that itemizes the bill: all its lines replaced by the invoice's, in the invoice's
 * order, each on the item or account chosen for it. Only the choice comes from the caller (the
 * model); the description, quantity, unit price and amount are the invoice's. Refused unless the
 * plan says itemize, every invoice line is chosen exactly once, an account is one already on the
 * bill, and an item line's amount is its quantity times its unit price.
 */
// DECISION: the model may only put a line on an account already on the bill (no tool lists the
// chart of accounts, so it could not know another) or on an item it found; an item line must be
// qty × unit price rounded half up to cents, as the write tool requires, else it goes on an account.
export function billLines(
  invoice: InvoiceForBill,
  bill: ToolBill,
  choices: readonly LineChoice[],
): BillLinesChange {
  const plan = planBill(invoice, bill);
  if (plan.decision !== "itemize") throw new BillLinesError(plan.reason);
  const byLine = new Map<number, LineChoice>();
  for (const c of choices) {
    if (byLine.has(c.lineNo)) throw new BillLinesError(`line ${c.lineNo} is chosen twice`);
    if (!invoice.lines.some((l) => l.lineNo === c.lineNo)) {
      throw new BillLinesError(`the invoice has no line ${c.lineNo}`);
    }
    byLine.set(c.lineNo, c);
  }
  const accounts = new Set(
    bill.lines.map((l) => l.account?.id).filter((id): id is string => typeof id === "string"),
  );
  const lines = invoice.lines.map((l): NewBillLine => {
    const c = byLine.get(l.lineNo);
    if (!c) throw new BillLinesError(`line ${l.lineNo} has no item or account`);
    if ((c.itemId === undefined) === (c.accountId === undefined)) {
      throw new BillLinesError(`line ${l.lineNo} needs exactly one of an item and an account`);
    }
    const description = l.description.slice(0, DESCRIPTION_MAX);
    const amount = money(l.extPrice);
    if (c.accountId !== undefined) {
      if (!accounts.has(c.accountId)) {
        throw new BillLinesError(
          `line ${l.lineNo}: account ${c.accountId} is not on the bill (it has ${[...accounts].join(", ") || "none"})`,
        );
      }
      return { accountId: c.accountId, description, amount };
    }
    const product = dec(l.qty).times(dec(l.unitPrice)).toDecimalPlaces(2);
    if (dec(l.qty).lte(0) || !product.equals(dec(l.extPrice))) {
      throw new BillLinesError(
        `line ${l.lineNo}: its amount ${amount} is not its quantity times its unit price, so it goes on an account`,
      );
    }
    return {
      itemId: c.itemId as string,
      description,
      qty: dec(l.qty).toString(),
      unitPrice: dec(l.unitPrice).toString(),
      amount,
    };
  });
  return {
    id: bill.id,
    syncToken: bill.syncToken,
    expectedTotal: money(bill.total),
    currency: bill.currency,
    replaceLineIds: bill.lines.map((l) => l.id as string),
    lines,
  };
}
