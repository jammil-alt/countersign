// The AP pack's records (Plan entry §1.233): a bill prepared from an invoice's purchase (its lines,
// each coded to an account; its purchase order, matched by core's engine; its flags), the week's
// approve-to-pay list, a person's decisions on it, and goods received. Each function runs inside
// the caller's client transaction (`withTenant`). Deterministic first, model second, human last
// (invariant 7): code codes a line only from the vendor's own history, the engine's hard rules
// veto an order, a model only ever suggests an account, and a person decides each bill.
//
// No payment: a bill ends approved on a week's list. Nothing here pays, schedules a payment or
// writes to a client's tool.

import {
  BILL_TO_PO,
  type Decimal,
  dec,
  type MatchItem,
  matchItems,
  toNumeric,
} from "@countersign/core";
import {
  appUser,
  docExtraction,
  docLine,
  document,
  ledgerAccount,
  liveMatchRules,
  type Tx,
  tenant,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { invoiceKey, latestExtraction } from "@countersign/documents";
import { and, asc, desc, eq, gte, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { latestMatch, liveItem } from "../catalog/store";
import { unitKey } from "../pricing/uom";
import { clientDay } from "../purchasing/requests";
import { purchaseRequest, purchaseRequestLine } from "../schema";
import { type ApConfig, apConfigOf, PAY_DAYS, type PayDay } from "./config";
import { type Order, ordersSince, receivedOf } from "./orders";
import { type ApBillStatus, type ApMatchStatus, apBill, apBillLine, apReceipt } from "./schema";

export class ApError extends Error {
  override name = "ApError";
  constructor(
    readonly code: "not_found" | "invalid" | "status",
    message: string,
  ) {
    super(message);
  }
}

/** An agent's call: one client, one agent version, a live run or a test. */
export interface ApContext {
  tenantId: string;
  agentVersionId: string;
  runId: string | null;
  mode: "live" | "test";
}

/** A person's decision on the card or in the back office. */
export interface PersonContext {
  tenantId: string;
  userId: string;
}

// ── Flags ────────────────────────────────────────────────────────────────────────────────────────

export const AP_FLAG_KINDS = [
  /** The same vendor and invoice number as another bill, or a copy of another document. */
  "duplicate",
  /** The same vendor and amount as another bill a few days apart, numbers differing. */
  "possible_duplicate",
  /** A line's price above its order's by more than the tolerance (same unit only). */
  "price_over_order",
  /** A line's price below its order's by more than the tolerance (a saving; noted). */
  "price_under_order",
  /** A line in another unit than its order line, with no conversion: not compared (invariant 7). */
  "unit_not_compared",
  /** More billed of an order line, across its bills, than was ordered. */
  "qty_over_order",
  /** More billed of an order line, across its bills, than was received. */
  "qty_over_received",
  /** Nobody has marked the order's goods received. */
  "not_received",
  /** The bill's total differs from its order's (freight, tax, part of it). */
  "amount_differs",
  /** No purchase order fits the bill. */
  "no_order",
  /** An order the fuzzy tier thought likely: a person confirms it. */
  "order_to_confirm",
  /** A line with no account yet. */
  "uncoded",
  /** The invoice was read again after the bill was prepared. */
  "read_again",
] as const;
export type ApFlagKind = (typeof AP_FLAG_KINDS)[number];

/**
 * `block`: the bill isn't approved with the rest; a person approves it only with a note.
 * `warn`: shown on the list. `info`: noted.
 */
export type ApFlagSeverity = "block" | "warn" | "info";

export interface ApFlag {
  kind: ApFlagKind;
  severity: ApFlagSeverity;
  /** Plain words for the list. */
  message: string;
  lineNo?: number;
  /** Money at stake (positive: more than ordered), in the bill's currency. */
  impact?: string;
  sources: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** 1 (Monday) to 7 (Sunday). */
function isoWeekday(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Monday of the week `day` is in. */
export function weekOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

/** The next pay day on or after `today`. */
export function nextPayDay(today: string, payDay: PayDay): string {
  const want = PAY_DAYS.indexOf(payDay) + 1;
  return addDays(today, (want - isoWeekday(today) + 7) % 7);
}

const money = (v: Decimal | string) => toNumeric(v);
const usd = (v: string, currency: string) =>
  currency === "USD" ? `$${dec(v).toFixed(2)}` : `${currency} ${dec(v).toFixed(2)}`;

interface Header {
  vendorName?: string | undefined;
  invoiceNumber?: string | undefined;
  invoiceDate?: string | undefined;
  dueDate?: string | null;
  poNumber?: string | null;
}

/** The reading's header, read loosely: a field that isn't a string is none. */
function headerOf(raw: unknown): Header {
  const h = (raw ?? {}) as Record<string, unknown>;
  const s = (k: string) =>
    typeof h[k] === "string" && (h[k] as string).length > 0 ? (h[k] as string) : null;
  const day = (k: string) => {
    const v = s(k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  };
  return {
    vendorName: s("vendorName") ?? undefined,
    invoiceNumber: s("invoiceNumber") ?? undefined,
    invoiceDate: day("invoiceDate") ?? undefined,
    dueDate: day("dueDate"),
    poNumber: s("poNumber"),
  };
}

async function tenantSettings(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId))
    .limit(1);
  return (row?.settings ?? {}) as Record<string, unknown>;
}

export async function apConfig(tx: Tx, tenantId: string): Promise<ApConfig> {
  return apConfigOf(await tenantSettings(tx, tenantId));
}

type BillRow = typeof apBill.$inferSelect;
type LineRow = typeof apBillLine.$inferSelect;

async function billRow(tx: Tx, tenantId: string, id: string): Promise<BillRow> {
  const [row] = await tx
    .select()
    .from(apBill)
    .where(and(eq(apBill.tenantId, tenantId), eq(apBill.id, id)))
    .limit(1);
  if (!row) throw new ApError("not_found", `bill ${id} not found`);
  return row;
}

async function billLines(tx: Tx, tenantId: string, billId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(apBillLine)
    .where(and(eq(apBillLine.tenantId, tenantId), eq(apBillLine.apBillId, billId)))
    .orderBy(asc(apBillLine.lineNo));
}

// ── Preparing a bill ─────────────────────────────────────────────────────────────────────────────

export interface PrepareResult {
  status: "prepared" | "decided" | "not_ready";
  billId: string | null;
  /** Plain words for the run view. */
  summary: string;
  matchStatus: ApMatchStatus | null;
  /** No blocking flag, every line coded, no order left to confirm. */
  ready: boolean;
  uncoded: number;
  flags: number;
  blocking: number;
  sources: string[];
}

/**
 * Prepares the bill behind an invoice: the bill and its lines (once), the order it is against (the
 * matching engine's `bill_to_po`, once), each line's account from the vendor's history, and its
 * flags. Prepared again, it re-codes and re-flags; a decided bill is left as it is.
 */
export async function prepareBill(
  tx: Tx,
  ctx: ApContext,
  input: { documentId: string; today: Date },
): Promise<PrepareResult> {
  const notReady = (summary: string): PrepareResult => ({
    status: "not_ready",
    billId: null,
    summary,
    matchStatus: null,
    ready: false,
    uncoded: 0,
    flags: 0,
    blocking: 0,
    sources: [input.documentId],
  });
  const [doc] = await tx
    .select()
    .from(document)
    .where(and(eq(document.tenantId, ctx.tenantId), eq(document.id, input.documentId)))
    .limit(1);
  if (!doc) throw new ApError("not_found", `document ${input.documentId} not found`);
  if (!doc.transactionId) return notReady("The invoice has no purchase recorded yet.");
  const ex = await latestExtraction(tx, ctx.tenantId, doc.id);
  if (!ex) return notReady("The invoice hasn't been read yet.");
  if (!ex.totalsMatch)
    return notReady("The invoice's totals don't add up; a person checks them first.");
  const [txn] = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.tenantId, ctx.tenantId), eq(transaction.id, doc.transactionId)))
    .limit(1);
  if (!txn) throw new ApError("not_found", `purchase ${doc.transactionId} not found`);
  const header = headerOf(ex.header);

  let [bill] = await tx
    .select()
    .from(apBill)
    .where(and(eq(apBill.tenantId, ctx.tenantId), eq(apBill.transactionId, txn.id)))
    .limit(1);
  if (bill && (bill.status === "approved" || bill.status === "rejected")) {
    return {
      status: "decided",
      billId: bill.id,
      summary: `The bill was already ${bill.status}.`,
      matchStatus: bill.matchStatus,
      ready: false,
      uncoded: 0,
      flags: (bill.flags as unknown[]).length,
      blocking: 0,
      sources: bill.sources,
    };
  }
  if (!bill) {
    [bill] = await tx
      .insert(apBill)
      .values({
        tenantId: ctx.tenantId,
        transactionId: txn.id,
        documentId: doc.id,
        extractionId: ex.id,
        vendorId: txn.vendorId,
        invoiceNumber: header.invoiceNumber ?? null,
        invoiceDate: header.invoiceDate ?? txn.txnDate,
        dueDate: header.dueDate ?? null,
        amount: money(ex.total),
        currency: ex.currency,
        agentVersionId: ctx.agentVersionId,
        runId: ctx.runId,
        sources: [doc.id, ex.id, txn.id],
      })
      .returning();
    if (!bill) throw new Error("no bill after insert");
    await insertLines(tx, ctx.tenantId, bill.id, ex);
  }
  if (bill.matchStatus === "pending") {
    bill = await matchOrder(tx, ctx.tenantId, bill, header, input.today);
  }
  const prepared = await refreshBill(tx, ctx.tenantId, bill.id, {
    agentVersionId: ctx.agentVersionId,
    runId: ctx.runId,
    today: input.today,
  });
  return { ...prepared, status: "prepared" };
}

type ExtractionRow = typeof docExtraction.$inferSelect;

/** The bill's lines: the invoice's lines, then freight, each surcharge and tax (once). */
async function insertLines(tx: Tx, tenantId: string, billId: string, ex: ExtractionRow) {
  const lines = await tx
    .select()
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, ex.id)))
    .orderBy(asc(docLine.lineNo));
  const rows: (typeof apBillLine.$inferInsert)[] = lines.map((l, i) => ({
    tenantId,
    apBillId: billId,
    lineNo: i + 1,
    docLineId: l.id,
    amount: money(l.extPrice),
  }));
  for (const amount of extraAmounts(ex).map((x) => x.amount)) {
    rows.push({ tenantId, apBillId: billId, lineNo: rows.length + 1, docLineId: null, amount });
  }
  if (rows.length > 0) await tx.insert(apBillLine).values(rows);
}

/** Freight, each surcharge and tax, in that order: the bill lines after the invoice's own. */
// DECISION: they are lines to code like any other (freight to its account, tax to its), so the
// lines add up to the bill; their names come from the reading, which never changes (invariant 3).
function extraAmounts(ex: ExtractionRow): { label: string; amount: string }[] {
  const out: { label: string; amount: string }[] = [];
  if (ex.freight && !dec(ex.freight).isZero())
    out.push({ label: "Freight", amount: money(ex.freight) });
  for (const s of ex.surcharges ?? []) {
    if (!dec(s.amount).isZero()) out.push({ label: s.label, amount: money(s.amount) });
  }
  if (ex.tax && !dec(ex.tax).isZero()) out.push({ label: "Tax", amount: money(ex.tax) });
  return out;
}

/** The order a bill is against, by the matching engine (`bill_to_po`); hard rules veto. */
async function matchOrder(
  tx: Tx,
  tenantId: string,
  bill: BillRow,
  header: Header,
  today: Date,
): Promise<BillRow> {
  const since = new Date(today.getTime() - (BILL_TO_PO.windowDays + 30) * DAY);
  const orders = await ordersSince(tx, tenantId, since);
  const [v] = bill.vendorId
    ? await tx
        .select({ name: vendor.name })
        .from(vendor)
        .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, bill.vendorId)))
        .limit(1)
    : [];
  const a: MatchItem = {
    amount: bill.amount,
    date: bill.invoiceDate,
    reference: header.poNumber ?? null,
    counterparty: v?.name ?? header.vendorName ?? null,
    currency: bill.currency,
  };
  // One item per reference an order goes by, so a bill naming any of them finds it.
  const items: { order: Order; item: MatchItem }[] = orders.flatMap((o) =>
    o.references.map((reference) => ({
      order: o,
      item: {
        amount: o.total,
        date: o.date,
        reference,
        counterparty: o.vendorName,
        currency: o.currency,
      },
    })),
  );
  const rules = await liveMatchRules(tx, tenantId, BILL_TO_PO.id);
  const outcome = matchItems(
    [a],
    items.map((x) => x.item),
    BILL_TO_PO,
    { rules },
  );
  const m = outcome.matches.find((x) => x.a.includes(0));
  const picked = m
    ? [...new Set(m.b.map((j) => items[j]?.order).filter((o): o is Order => !!o))]
    : [];
  let status: ApMatchStatus = "none";
  let order: Order | null = null;
  // DECISION: a bill against two or more orders isn't taken (a person matches it); the fuzzy
  // tier's pair is only proposed; the rest is the rule that made it.
  if (m && picked.length === 1) {
    order = picked[0] as Order;
    status = m.tier === "fuzzy" ? "proposed" : m.type === "partial" ? "partial" : "matched";
  }
  const [row] = await tx
    .update(apBill)
    .set({
      matchStatus: status,
      purchaseRequestId: order?.purchaseRequestId ?? null,
      match:
        m && order
          ? {
              config: BILL_TO_PO.id,
              tier: m.tier,
              rule: m.rule,
              score: m.score,
              difference: m.difference,
              reference: items[m.b[0] as number]?.item.reference ?? null,
              quoteRequestId: order.quoteRequestId,
              orderTotal: order.total,
              orderDate: order.date,
            }
          : { config: BILL_TO_PO.id, candidates: orders.length },
      updatedAt: new Date(),
    })
    .where(and(eq(apBill.tenantId, tenantId), eq(apBill.id, bill.id)))
    .returning();
  return row ?? bill;
}

/** The order a matched bill is against, as `ordersSince` reads it; null when none. */
async function orderOf(tx: Tx, tenantId: string, bill: BillRow): Promise<Order | null> {
  if (!bill.purchaseRequestId) return null;
  const quoteId = (bill.match as { quoteRequestId?: unknown }).quoteRequestId;
  const orders = await ordersSince(tx, tenantId, new Date(0));
  return (
    orders.find(
      (o) =>
        o.purchaseRequestId === bill.purchaseRequestId &&
        (typeof quoteId !== "string" || o.quoteRequestId === quoteId),
    ) ?? null
  );
}

/**
 * Re-codes, re-links and re-flags a bill that isn't decided: lines to their order's lines, each
 * uncoded line to the vendor's one account, then the flags. Who prepared it last is recorded.
 */
export async function refreshBill(
  tx: Tx,
  tenantId: string,
  billId: string,
  by: { agentVersionId?: string; runId?: string | null; today: Date },
): Promise<Omit<PrepareResult, "status">> {
  const bill = await billRow(tx, tenantId, billId);
  const cfg = await apConfig(tx, tenantId);
  const order = await orderOf(tx, tenantId, bill);
  const lines = await billLines(tx, tenantId, bill.id);
  const docLines = await docLinesOf(tx, tenantId, lines);

  // Each invoice line to its order line: by catalog item, else the one line each side has.
  if (order) {
    for (const l of lines) {
      if (!l.docLineId || l.purchaseRequestLineId) continue;
      const target = await orderLineFor(tx, tenantId, l, order, lines);
      if (!target) continue;
      await tx
        .update(apBillLine)
        .set({ purchaseRequestLineId: target, updatedAt: new Date() })
        .where(and(eq(apBillLine.tenantId, tenantId), eq(apBillLine.id, l.id)));
      l.purchaseRequestLineId = target;
    }
  }

  // Coding: the vendor's one account, when its history has exactly one.
  const uncodedLines = lines.filter((l) => !l.ledgerAccountId);
  if (uncodedLines.length > 0 && bill.vendorId) {
    const accounts = await vendorAccounts(tx, tenantId, bill.vendorId, bill.id, by.today);
    if (accounts.length === 1) {
      const accountId = accounts[0] as string;
      await tx
        .update(apBillLine)
        .set({ ledgerAccountId: accountId, codedBy: "history", updatedAt: new Date() })
        .where(
          and(
            eq(apBillLine.tenantId, tenantId),
            inArray(
              apBillLine.id,
              uncodedLines.map((l) => l.id),
            ),
          ),
        );
      for (const l of uncodedLines) {
        l.ledgerAccountId = accountId;
        l.codedBy = "history";
      }
    }
  }

  const flags = await flagsFor(tx, tenantId, cfg, bill, lines, docLines, order);
  const sources = [
    ...new Set([
      ...bill.sources,
      ...(order ? [order.purchaseRequestId, order.quoteRequestId] : []),
      ...flags.flatMap((f) => f.sources),
    ]),
  ];
  await tx
    .update(apBill)
    .set({
      flags,
      sources,
      ...(by.agentVersionId ? { agentVersionId: by.agentVersionId } : {}),
      ...(by.runId !== undefined && by.agentVersionId ? { runId: by.runId } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(apBill.tenantId, tenantId), eq(apBill.id, bill.id)));
  const uncoded = lines.filter((l) => !l.ledgerAccountId).length;
  const blocking = flags.filter((f) => f.severity === "block").length;
  const ready = isReady(flags, bill.matchStatus);
  return {
    billId: bill.id,
    summary: summaryOf(flags, uncoded, ready),
    matchStatus: bill.matchStatus,
    ready,
    uncoded,
    flags: flags.length,
    blocking,
    sources,
  };
}

function isReady(flags: readonly ApFlag[], matchStatus: ApMatchStatus): boolean {
  return (
    matchStatus !== "proposed" && !flags.some((f) => f.severity === "block" || f.kind === "uncoded")
  );
}

function summaryOf(flags: readonly ApFlag[], uncoded: number, ready: boolean): string {
  if (ready) {
    return flags.length === 0
      ? "Ready to approve, nothing flagged."
      : `Ready to approve, with ${flags.length} ${flags.length === 1 ? "note" : "notes"}.`;
  }
  const block = flags.filter((f) => f.severity === "block").length;
  const parts = [
    ...(block > 0 ? [`${block} ${block === 1 ? "flag" : "flags"} to look at`] : []),
    ...(uncoded > 0 ? [`${uncoded} ${uncoded === 1 ? "line" : "lines"} to code`] : []),
  ];
  return parts.length > 0 ? `Needs you: ${parts.join(", ")}.` : "Needs you: confirm its order.";
}

type DocLineRow = typeof docLine.$inferSelect;

async function docLinesOf(
  tx: Tx,
  tenantId: string,
  lines: readonly LineRow[],
): Promise<Map<string, DocLineRow>> {
  const ids = lines.map((l) => l.docLineId).filter((x): x is string => !!x);
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), inArray(docLine.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function orderLineFor(
  tx: Tx,
  tenantId: string,
  line: LineRow,
  order: Order,
  all: readonly LineRow[],
): Promise<string | null> {
  if (!line.docLineId) return null;
  const m = await latestMatch(tx, tenantId, line.docLineId);
  if (m?.decision === "matched" && m.catalogItemId) {
    const item = await liveItem(tx, tenantId, m.catalogItemId);
    if (item) {
      for (const ol of order.lines) {
        if (!ol.catalogItemId) continue;
        const theirs = await liveItem(tx, tenantId, ol.catalogItemId);
        if (theirs?.id === item.id) return ol.requestLineId;
      }
    }
  }
  const invoiceLines = all.filter((l) => l.docLineId);
  return invoiceLines.length === 1 && order.lines.length === 1
    ? (order.lines[0]?.requestLineId ?? null)
    : null;
}

/**
 * The accounts this vendor's bills were coded to in the last year: this pack's bills (any but
 * rejected), and the client's QuickBooks bills from the vendor (their lines' accounts).
 */
// DECISION: code by history only when it is unanimous (one account); two or more is a choice a
// model may suggest and a person makes. QuickBooks' line names its account by id, or by name in
// older syncs; either finds the client's live account.
export async function vendorAccounts(
  tx: Tx,
  tenantId: string,
  vendorId: string,
  exceptBillId: string,
  today: Date,
): Promise<string[]> {
  const since = new Date(today.getTime() - 365 * DAY);
  const ours = await tx
    .selectDistinct({ id: apBillLine.ledgerAccountId })
    .from(apBillLine)
    .innerJoin(
      apBill,
      and(eq(apBill.id, apBillLine.apBillId), eq(apBill.tenantId, apBillLine.tenantId)),
    )
    .where(
      and(
        eq(apBillLine.tenantId, tenantId),
        eq(apBill.vendorId, vendorId),
        ne(apBill.id, exceptBillId),
        ne(apBill.status, "rejected"),
        isNotNull(apBillLine.ledgerAccountId),
        gte(apBill.createdAt, since),
      ),
    );
  const refs = await tx
    .selectDistinct({ ref: transactionLine.accountRef })
    .from(transactionLine)
    .innerJoin(
      transaction,
      and(
        eq(transaction.id, transactionLine.transactionId),
        eq(transaction.tenantId, transactionLine.tenantId),
      ),
    )
    .where(
      and(
        eq(transactionLine.tenantId, tenantId),
        eq(transaction.vendorId, vendorId),
        eq(transaction.kind, "bill"),
        eq(transaction.connector, "qbo"),
        isNotNull(transactionLine.accountRef),
        gte(transaction.txnDate, since.toISOString().slice(0, 10)),
      ),
    );
  const names = refs.map((r) => r.ref).filter((x): x is string => !!x);
  const theirs =
    names.length === 0
      ? []
      : await tx
          .select({ id: ledgerAccount.id })
          .from(ledgerAccount)
          .where(
            and(
              eq(ledgerAccount.tenantId, tenantId),
              eq(ledgerAccount.active, true),
              or(
                inArray(ledgerAccount.externalId, names),
                inArray(ledgerAccount.fullName, names),
                inArray(ledgerAccount.name, names),
              ),
            ),
          );
  return [
    ...new Set([
      ...ours.map((r) => r.id).filter((x): x is string => !!x),
      ...theirs.map((r) => r.id),
    ]),
  ];
}

// ── Flags ────────────────────────────────────────────────────────────────────────────────────────

async function flagsFor(
  tx: Tx,
  tenantId: string,
  cfg: ApConfig,
  bill: BillRow,
  lines: readonly LineRow[],
  docLines: ReadonlyMap<string, DocLineRow>,
  order: Order | null,
): Promise<ApFlag[]> {
  const flags: ApFlag[] = [];
  flags.push(...(await duplicateFlags(tx, tenantId, cfg, bill)));

  // The order.
  if (bill.matchStatus === "none") {
    flags.push({
      kind: "no_order",
      severity: cfg.requirePo ? "block" : "warn",
      message: "No purchase order fits this bill.",
      sources: [bill.id],
    });
  }
  if (bill.matchStatus === "proposed" && order) {
    flags.push({
      kind: "order_to_confirm",
      severity: "warn",
      message: `It looks like order ${order.references[0] ?? ""}; confirm it or say it isn't.`,
      sources: [order.purchaseRequestId],
    });
  }
  if (order && bill.matchStatus !== "proposed") {
    const diff = dec(bill.amount).minus(order.total);
    if (diff.abs().gt(dec(BILL_TO_PO.tolerance))) {
      flags.push({
        kind: "amount_differs",
        severity: "info",
        message: `The bill is ${usd(bill.amount, bill.currency)}; the order was ${usd(order.total, order.currency)}.`,
        impact: money(diff),
        sources: [order.purchaseRequestId],
      });
    }
    flags.push(...(await lineFlags(tx, tenantId, cfg, bill, lines, docLines, order)));
  }

  const uncoded = lines.filter((l) => !l.ledgerAccountId);
  if (uncoded.length > 0) {
    flags.push({
      kind: "uncoded",
      severity: "warn",
      message: `${uncoded.length} of ${lines.length} lines have no account yet.`,
      sources: [bill.id],
    });
  }
  if (bill.documentId && bill.extractionId) {
    const latest = await latestExtraction(tx, tenantId, bill.documentId);
    if (latest && latest.id !== bill.extractionId) {
      flags.push({
        kind: "read_again",
        severity: "block",
        message:
          "The invoice was read again after this bill was prepared; check it against the new reading.",
        sources: [latest.id],
      });
    }
  }
  return flags;
}

async function duplicateFlags(
  tx: Tx,
  tenantId: string,
  cfg: ApConfig,
  bill: BillRow,
): Promise<ApFlag[]> {
  const flags: ApFlag[] = [];
  if (bill.documentId) {
    const [doc] = await tx
      .select({ meta: document.meta })
      .from(document)
      .where(and(eq(document.tenantId, tenantId), eq(document.id, bill.documentId)))
      .limit(1);
    const dup = (doc?.meta as { duplicateOf?: { documentId?: unknown } } | undefined)?.duplicateOf;
    if (typeof dup?.documentId === "string") {
      flags.push({
        kind: "duplicate",
        severity: "block",
        message: "This invoice is a copy of one that came in before.",
        sources: [dup.documentId],
      });
    }
  }
  if (!bill.vendorId) return flags;
  const others = await tx
    .select()
    .from(apBill)
    .where(
      and(
        eq(apBill.tenantId, tenantId),
        eq(apBill.vendorId, bill.vendorId),
        ne(apBill.id, bill.id),
        ne(apBill.status, "rejected"),
      ),
    );
  const key = invoiceKey(bill.invoiceNumber);
  for (const o of others) {
    if (key && invoiceKey(o.invoiceNumber) === key) {
      flags.push({
        kind: "duplicate",
        severity: "block",
        message: `The same vendor and invoice number as another bill (${o.status}).`,
        sources: [o.id, ...(o.documentId ? [o.documentId] : [])],
      });
    } else if (
      dec(o.amount).eq(bill.amount) &&
      o.currency === bill.currency &&
      bill.invoiceDate &&
      o.invoiceDate &&
      Math.abs(Date.parse(o.invoiceDate) - Date.parse(bill.invoiceDate)) / DAY <=
        cfg.duplicateWindowDays
    ) {
      flags.push({
        kind: "possible_duplicate",
        severity: "warn",
        message: `Another bill from this vendor for ${usd(bill.amount, bill.currency)} on ${o.invoiceDate}, numbered differently.`,
        sources: [o.id, ...(o.documentId ? [o.documentId] : [])],
      });
    }
  }
  // A bill for this invoice already in QuickBooks (another purchase than this one).
  if (key) {
    const synced = await tx
      .select({ id: transaction.id, ext: transaction.ext })
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, tenantId),
          eq(transaction.vendorId, bill.vendorId),
          eq(transaction.kind, "bill"),
          eq(transaction.connector, "qbo"),
          ne(transaction.id, bill.transactionId),
        ),
      );
    for (const s of synced) {
      const doc = (s.ext as { qbo?: { docNumber?: unknown } } | null)?.qbo?.docNumber;
      if (typeof doc === "string" && invoiceKey(doc) === key) {
        flags.push({
          kind: "duplicate",
          severity: "block",
          message: "The accounting system already has a bill from this vendor with this invoice number.",
          sources: [s.id],
        });
      }
    }
  }
  return flags;
}

async function lineFlags(
  tx: Tx,
  tenantId: string,
  cfg: ApConfig,
  bill: BillRow,
  lines: readonly LineRow[],
  docLines: ReadonlyMap<string, DocLineRow>,
  order: Order,
): Promise<ApFlag[]> {
  const flags: ApFlag[] = [];
  const received = await receivedOf(tx, tenantId, order.purchaseRequestId);
  if (!received.any) {
    flags.push({
      kind: "not_received",
      severity: cfg.requireReceipt ? "block" : "warn",
      message: "Nobody has marked this order's goods received.",
      sources: [order.purchaseRequestId],
    });
  }
  const tolerance = dec(String(cfg.priceTolerancePct)).div(100);
  for (const l of lines) {
    const dl = l.docLineId ? docLines.get(l.docLineId) : undefined;
    const ol = order.lines.find((x) => x.requestLineId === l.purchaseRequestLineId);
    if (!dl || !ol) continue;
    const src = [dl.id, ol.requestLineId];
    const billUnit = unitKey(dl.uomRaw);
    const orderUnit = unitKey(ol.unit);
    // Invariant 7: never compare across units without a conversion rule. A line and its order
    // line in different units (both stated) aren't compared; one unstated reads as the other's.
    const sameUnit = billUnit === null || orderUnit === null || billUnit === orderUnit;
    if (!sameUnit) {
      flags.push({
        kind: "unit_not_compared",
        severity: "info",
        lineNo: l.lineNo,
        message: `Line ${l.lineNo} is billed per ${dl.uomRaw} and was ordered per ${ol.unit}; its price and quantity weren't compared.`,
        sources: src,
      });
      continue;
    }
    const billed = dec(dl.unitPrice);
    const ordered = dec(ol.unitPrice);
    if (!ordered.isZero()) {
      const change = billed.minus(ordered).div(ordered);
      if (change.gt(tolerance) && billed.minus(ordered).times(dl.qty).abs().gte("0.01")) {
        flags.push({
          kind: "price_over_order",
          severity: "block",
          lineNo: l.lineNo,
          message: `Line ${l.lineNo} is billed at ${usd(billed.toString(), bill.currency)}; the order says ${usd(ol.unitPrice, bill.currency)} (${change.times(100).toFixed(1)}% more).`,
          impact: money(billed.minus(ordered).times(dl.qty)),
          sources: src,
        });
      } else if (change.lt(tolerance.neg()) && ordered.minus(billed).times(dl.qty).gte("0.01")) {
        flags.push({
          kind: "price_under_order",
          severity: "info",
          lineNo: l.lineNo,
          message: `Line ${l.lineNo} is billed below its order: ${usd(billed.toString(), bill.currency)} against ${usd(ol.unitPrice, bill.currency)}.`,
          impact: money(billed.minus(ordered).times(dl.qty)),
          sources: src,
        });
      }
    }
    // Quantity: what every bill (but rejected ones) billed of this order line.
    const [sum] = await tx
      .select({ qty: sql<string>`coalesce(sum(${docLine.qty}), 0)::text` })
      .from(apBillLine)
      .innerJoin(
        apBill,
        and(eq(apBill.id, apBillLine.apBillId), eq(apBill.tenantId, apBillLine.tenantId)),
      )
      .innerJoin(
        docLine,
        and(eq(docLine.id, apBillLine.docLineId), eq(docLine.tenantId, apBillLine.tenantId)),
      )
      .where(
        and(
          eq(apBillLine.tenantId, tenantId),
          eq(apBillLine.purchaseRequestLineId, ol.requestLineId),
          ne(apBill.status, "rejected"),
        ),
      );
    const billedQty = dec(sum?.qty ?? "0");
    if (billedQty.gt(ol.qty)) {
      flags.push({
        kind: "qty_over_order",
        severity: "block",
        lineNo: l.lineNo,
        message: `${billedQty.toString()} of line ${l.lineNo} billed so far; ${dec(ol.qty).toString()} were ordered.`,
        impact: money(billedQty.minus(ol.qty).times(dl.unitPrice)),
        sources: src,
      });
    } else if (received.any && !received.whole) {
      const got = dec(received.byLine.get(ol.requestLineId) ?? "0");
      if (billedQty.gt(got)) {
        flags.push({
          kind: "qty_over_received",
          severity: "block",
          lineNo: l.lineNo,
          message: `${billedQty.toString()} of line ${l.lineNo} billed so far; ${got.toString()} received.`,
          impact: money(billedQty.minus(got).times(dl.unitPrice)),
          sources: [...src, ...received.ids],
        });
      }
    }
  }
  return flags;
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

export interface BillLineView {
  id: string;
  lineNo: number;
  /** As the invoice printed it: data, never instructions (invariant 9). */
  description: string;
  qty: string | null;
  unit: string | null;
  unitPrice: string | null;
  amount: string;
  account: { id: string; name: string; number: string | null } | null;
  codedBy: "history" | "person" | null;
  proposal: { account: { id: string; name: string }; reason: string | null } | null;
  orderLineId: string | null;
}

export interface BillView {
  id: string;
  status: ApBillStatus;
  vendorId: string | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  amount: string;
  currency: string;
  documentId: string | null;
  filename: string | null;
  matchStatus: ApMatchStatus;
  order: { id: string; reference: string | null; total: string | null; date: string | null } | null;
  flags: ApFlag[];
  ready: boolean;
  payWeek: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  lines: BillLineView[];
  sources: string[];
}

export async function billView(tx: Tx, tenantId: string, billId: string): Promise<BillView> {
  const bill = await billRow(tx, tenantId, billId);
  const lines = await billLines(tx, tenantId, bill.id);
  const docLines = await docLinesOf(tx, tenantId, lines);
  const accountIds = [
    ...new Set(
      lines
        .flatMap((l) => [l.ledgerAccountId, l.proposedLedgerAccountId])
        .filter((x): x is string => !!x),
    ),
  ];
  const accounts =
    accountIds.length === 0
      ? []
      : await tx
          .select({
            id: ledgerAccount.id,
            name: ledgerAccount.fullName,
            number: ledgerAccount.number,
          })
          .from(ledgerAccount)
          .where(and(eq(ledgerAccount.tenantId, tenantId), inArray(ledgerAccount.id, accountIds)));
  const account = (id: string | null) => {
    const a = id ? accounts.find((x) => x.id === id) : undefined;
    return a ? { id: a.id, name: a.name, number: a.number } : null;
  };
  const [ex] = bill.extractionId
    ? await tx
        .select()
        .from(docExtraction)
        .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.id, bill.extractionId)))
        .limit(1)
    : [];
  const extras = ex ? extraAmounts(ex) : [];
  const invoiceLines = lines.filter((l) => l.docLineId).length;
  const [v] = bill.vendorId
    ? await tx
        .select({ name: vendor.name })
        .from(vendor)
        .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, bill.vendorId)))
        .limit(1)
    : [];
  const [doc] = bill.documentId
    ? await tx
        .select({ filename: document.filename })
        .from(document)
        .where(and(eq(document.tenantId, tenantId), eq(document.id, bill.documentId)))
        .limit(1)
    : [];
  const [decider] = bill.decidedBy
    ? await tx
        .select({ name: appUser.name })
        .from(appUser)
        .where(eq(appUser.id, bill.decidedBy))
        .limit(1)
    : [];
  const match = bill.match as { reference?: unknown; orderTotal?: unknown; orderDate?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const flags = bill.flags as ApFlag[];
  return {
    id: bill.id,
    status: bill.status,
    vendorId: bill.vendorId,
    vendorName: v?.name ?? null,
    invoiceNumber: bill.invoiceNumber,
    invoiceDate: bill.invoiceDate,
    dueDate: bill.dueDate,
    amount: bill.amount,
    currency: bill.currency,
    documentId: bill.documentId,
    filename: doc?.filename ?? null,
    matchStatus: bill.matchStatus,
    order: bill.purchaseRequestId
      ? {
          id: bill.purchaseRequestId,
          reference: str(match.reference),
          total: str(match.orderTotal),
          date: str(match.orderDate),
        }
      : null,
    flags,
    ready: isReady(flags, bill.matchStatus),
    payWeek: bill.payWeek,
    decidedBy: decider?.name ?? null,
    decidedAt: bill.decidedAt?.toISOString() ?? null,
    decisionNote: bill.decisionNote,
    lines: lines.map((l) => {
      const dl = l.docLineId ? docLines.get(l.docLineId) : undefined;
      const proposed = account(l.proposedLedgerAccountId);
      return {
        id: l.id,
        lineNo: l.lineNo,
        description:
          dl?.rawDescription ?? extras[l.lineNo - invoiceLines - 1]?.label ?? `Line ${l.lineNo}`,
        qty: dl?.qty ?? null,
        unit: dl?.uomRaw ?? null,
        unitPrice: dl?.unitPrice ?? null,
        amount: l.amount,
        account: account(l.ledgerAccountId),
        codedBy: l.codedBy,
        proposal: proposed
          ? { account: { id: proposed.id, name: proposed.name }, reason: l.proposalReason }
          : null,
        orderLineId: l.purchaseRequestLineId,
      };
    }),
    sources: bill.sources,
  };
}

/** The bill an invoice became, when it has one. */
export async function billForDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: apBill.id })
    .from(apBill)
    .where(and(eq(apBill.tenantId, tenantId), eq(apBill.documentId, documentId)))
    .orderBy(desc(apBill.createdAt))
    .limit(1);
  return row?.id ?? null;
}

// ── Accounts and a model's suggestions ──────────────────────────────────────────────────────────

/** Kinds of account a bill's line may be coded to. */
// DECISION: what a purchase can be: costs, expenses, assets (equipment, prepaid) and the other
// liabilities (sales tax payable). Not the bank, card, receivable, payable, income or equity.
export const CODABLE_KINDS = [
  "cost_of_goods",
  "expense",
  "other_expense",
  "other_current_asset",
  "fixed_asset",
  "other_asset",
  "other_current_liability",
  "other",
] as const;

export async function codableAccounts(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: ledgerAccount.id,
      name: ledgerAccount.fullName,
      number: ledgerAccount.number,
      kind: ledgerAccount.kind,
      description: ledgerAccount.description,
    })
    .from(ledgerAccount)
    .where(
      and(
        eq(ledgerAccount.tenantId, tenantId),
        eq(ledgerAccount.active, true),
        inArray(ledgerAccount.kind, [...CODABLE_KINDS]),
      ),
    )
    .orderBy(asc(ledgerAccount.fullName));
}

async function codableAccount(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx
    .select({ id: ledgerAccount.id, kind: ledgerAccount.kind, active: ledgerAccount.active })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.tenantId, tenantId), eq(ledgerAccount.id, id)))
    .limit(1);
  if (!row?.active || !(CODABLE_KINDS as readonly string[]).includes(row.kind)) {
    throw new ApError(
      "invalid",
      `account ${id} isn't one of the client's accounts a bill is coded to`,
    );
  }
  return row;
}

/**
 * A model's suggestions for uncoded lines: kept beside the line for a person to take, never the
 * line's account (invariant 7). A line already coded is left alone.
 */
export async function proposeCoding(
  tx: Tx,
  ctx: ApContext,
  input: {
    billId: string;
    proposals: { lineNo: number; ledgerAccountId: string; reason: string }[];
  },
): Promise<{ proposed: number; skipped: number; sources: string[] }> {
  const bill = await billRow(tx, ctx.tenantId, input.billId);
  if (bill.status === "approved" || bill.status === "rejected") {
    throw new ApError("status", `the bill is ${bill.status}`);
  }
  const lines = await billLines(tx, ctx.tenantId, bill.id);
  let proposed = 0;
  let skipped = 0;
  for (const p of input.proposals) {
    const line = lines.find((l) => l.lineNo === p.lineNo);
    if (!line || line.ledgerAccountId) {
      skipped++;
      continue;
    }
    await codableAccount(tx, ctx.tenantId, p.ledgerAccountId);
    await tx
      .update(apBillLine)
      .set({
        proposedLedgerAccountId: p.ledgerAccountId,
        proposalReason: p.reason.slice(0, 500),
        proposalAgentVersionId: ctx.agentVersionId,
        updatedAt: new Date(),
      })
      .where(and(eq(apBillLine.tenantId, ctx.tenantId), eq(apBillLine.id, line.id)));
    proposed++;
  }
  return {
    proposed,
    skipped,
    sources: [bill.id, ...input.proposals.map((p) => p.ledgerAccountId)],
  };
}

// ── Receipts ─────────────────────────────────────────────────────────────────────────────────────

export interface ReceiptInput {
  purchaseRequestId: string;
  /** Lines received, each with how many; none: the whole order arrived as ordered. */
  lines?: { purchaseRequestLineId: string; qty: string }[] | undefined;
  receivedOn: string;
  documentId?: string | null | undefined;
  note?: string | null | undefined;
  sources?: string[] | undefined;
}

/** Records goods received against an order: by an agent (its version) or a person. */
export async function recordReceipt(
  tx: Tx,
  by: { tenantId: string; userId?: string; agentVersionId?: string; runId?: string | null },
  input: ReceiptInput,
): Promise<{ receiptIds: string[]; sources: string[] }> {
  const [r] = await tx
    .select({ id: purchaseRequest.id, status: purchaseRequest.status })
    .from(purchaseRequest)
    .where(
      and(
        eq(purchaseRequest.tenantId, by.tenantId),
        eq(purchaseRequest.id, input.purchaseRequestId),
      ),
    )
    .limit(1);
  if (!r) throw new ApError("not_found", `purchase request ${input.purchaseRequestId} not found`);
  if (r.status !== "ordered" && r.status !== "closed") {
    throw new ApError("status", `the request is ${r.status}, not ordered`);
  }
  const who = by.userId
    ? { recordedByUserId: by.userId }
    : { agentVersionId: by.agentVersionId ?? null, runId: by.runId ?? null };
  const base = {
    tenantId: by.tenantId,
    purchaseRequestId: r.id,
    receivedOn: input.receivedOn,
    documentId: input.documentId ?? null,
    note: input.note ?? null,
    sources: input.sources ?? [],
    ...who,
  };
  const lines = input.lines ?? [];
  if (lines.length > 0) {
    const known = await tx
      .select({ id: purchaseRequestLine.id })
      .from(purchaseRequestLine)
      .where(
        and(
          eq(purchaseRequestLine.tenantId, by.tenantId),
          eq(purchaseRequestLine.purchaseRequestId, r.id),
        ),
      );
    for (const l of lines) {
      if (!known.some((k) => k.id === l.purchaseRequestLineId)) {
        throw new ApError("invalid", `line ${l.purchaseRequestLineId} isn't this order's`);
      }
      if (dec(l.qty).isZero()) throw new ApError("invalid", "a received quantity isn't zero");
    }
  }
  const rows = await tx
    .insert(apReceipt)
    .values(
      lines.length > 0
        ? lines.map((l) => ({
            ...base,
            purchaseRequestLineId: l.purchaseRequestLineId,
            qty: money(l.qty),
          }))
        : [{ ...base, purchaseRequestLineId: null, qty: null }],
    )
    .returning({ id: apReceipt.id });
  // The bills against the order are flagged again.
  const bills = await tx
    .select({ id: apBill.id })
    .from(apBill)
    .where(
      and(
        eq(apBill.tenantId, by.tenantId),
        eq(apBill.purchaseRequestId, r.id),
        inArray(apBill.status, ["open", "held"]),
      ),
    );
  for (const b of bills) await refreshBill(tx, by.tenantId, b.id, { today: new Date() });
  const ids = rows.map((x) => x.id);
  return { receiptIds: ids, sources: [r.id, ...ids, ...(input.sources ?? [])] };
}

// ── The week's approve-to-pay list ──────────────────────────────────────────────────────────────

export interface PayListView {
  week: string;
  payDay: string;
  currency: string | null;
  bills: BillView[];
  count: number;
  /** Per currency: everything on the list, what is approved, what is ready. */
  totals: { currency: string; listed: string; approved: string; ready: string }[];
  ready: number;
  needsYou: number;
  approved: number;
  held: number;
  rejected: number;
  open: number;
}

export interface BuildResult {
  week: string;
  payDay: string;
  count: number;
  added: number;
  ready: number;
  needsYou: number;
  billIds: string[];
  summary: string;
  sources: string[];
}

/**
 * Puts the week's bills on its list: every open or held bill due by the pay day plus the
 * configuration's days (or with no due date), not already on a later list. Prepares nothing and
 * pays nothing.
 */
export async function buildPayList(
  tx: Tx,
  ctx: { tenantId: string },
  input: { today: Date },
): Promise<BuildResult> {
  const cfg = await apConfig(tx, ctx.tenantId);
  const today = await clientDay(tx, ctx.tenantId, input.today);
  const payDay = nextPayDay(today, cfg.payDay);
  const week = weekOf(payDay);
  const until = addDays(payDay, cfg.dueWithinDays);
  const due = await tx
    .select({ id: apBill.id, payWeek: apBill.payWeek })
    .from(apBill)
    .where(
      and(
        eq(apBill.tenantId, ctx.tenantId),
        inArray(apBill.status, ["open", "held"]),
        or(sql`${apBill.dueDate} is null`, sql`${apBill.dueDate} <= ${until}`),
        or(sql`${apBill.payWeek} is null`, sql`${apBill.payWeek} <= ${week}`),
      ),
    );
  const moving = due.filter((b) => b.payWeek !== week).map((b) => b.id);
  if (moving.length > 0) {
    await tx
      .update(apBill)
      .set({ payWeek: week, updatedAt: new Date() })
      .where(and(eq(apBill.tenantId, ctx.tenantId), inArray(apBill.id, moving)));
  }
  const view = await payListView(tx, ctx.tenantId, week);
  const total = view.totals.map((t) => usd(t.listed, t.currency)).join(" and ");
  return {
    week,
    payDay,
    count: view.count,
    added: moving.length,
    ready: view.ready,
    needsYou: view.needsYou,
    billIds: view.bills.map((b) => b.id),
    summary:
      view.count === 0
        ? `Nothing to pay on ${payDay}.`
        : `${view.count} ${view.count === 1 ? "bill" : "bills"} to approve for ${payDay}, ${total}: ${view.ready} ready, ${view.needsYou} ${view.needsYou === 1 ? "needs" : "need"} you.`,
    sources: view.bills.map((b) => b.id),
  };
}

export async function payListView(tx: Tx, tenantId: string, week: string): Promise<PayListView> {
  const cfg = await apConfig(tx, tenantId);
  const rows = await tx
    .select({ id: apBill.id })
    .from(apBill)
    .where(and(eq(apBill.tenantId, tenantId), eq(apBill.payWeek, week)))
    .orderBy(asc(apBill.dueDate), asc(apBill.createdAt));
  const bills: BillView[] = [];
  for (const r of rows) bills.push(await billView(tx, tenantId, r.id));
  const byCurrency = new Map<string, { listed: Decimal; approved: Decimal; ready: Decimal }>();
  for (const b of bills) {
    const t = byCurrency.get(b.currency) ?? {
      listed: dec("0"),
      approved: dec("0"),
      ready: dec("0"),
    };
    if (b.status !== "rejected") t.listed = t.listed.plus(b.amount);
    if (b.status === "approved") t.approved = t.approved.plus(b.amount);
    if (b.status !== "approved" && b.status !== "rejected" && b.ready)
      t.ready = t.ready.plus(b.amount);
    byCurrency.set(b.currency, t);
  }
  const undecided = bills.filter((b) => b.status === "open" || b.status === "held");
  const payDay = addDays(week, PAY_DAYS.indexOf(cfg.payDay));
  return {
    week,
    payDay,
    currency: byCurrency.size === 1 ? ([...byCurrency.keys()][0] ?? null) : null,
    bills,
    count: bills.length,
    totals: [...byCurrency.entries()].map(([currency, t]) => ({
      currency,
      listed: money(t.listed),
      approved: money(t.approved),
      ready: money(t.ready),
    })),
    ready: undecided.filter((b) => b.ready).length,
    needsYou: undecided.filter((b) => !b.ready).length,
    approved: bills.filter((b) => b.status === "approved").length,
    held: bills.filter((b) => b.status === "held").length,
    rejected: bills.filter((b) => b.status === "rejected").length,
    open: bills.filter((b) => b.status === "open").length,
  };
}

/** The weeks that have a list, newest first (at most 26). */
export async function payWeeks(tx: Tx, tenantId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ week: apBill.payWeek })
    .from(apBill)
    .where(and(eq(apBill.tenantId, tenantId), isNotNull(apBill.payWeek)))
    .orderBy(desc(apBill.payWeek))
    .limit(26);
  return rows.map((r) => r.week).filter((w): w is string => !!w);
}

// ── A person's decisions on the list ────────────────────────────────────────────────────────────

export type PayListDecision =
  | { action: "approve"; input: { billId: string; note?: string | null | undefined } }
  | { action: "hold"; input: { billId: string; note: string } }
  | { action: "reject"; input: { billId: string; note: string } }
  | { action: "approve_ready"; input: Record<string, never> }
  | { action: "code_line"; input: { billLineId: string; ledgerAccountId: string } }
  | { action: "take_proposal"; input: { billLineId: string } }
  | { action: "confirm_order"; input: { billId: string } }
  | { action: "not_this_order"; input: { billId: string } }
  | { action: "received"; input: { billId: string } };

async function listedBill(tx: Tx, tenantId: string, week: string, billId: string) {
  const bill = await billRow(tx, tenantId, billId);
  if (bill.payWeek !== week) throw new ApError("invalid", "that bill isn't on this week's list");
  return bill;
}

async function decideBill(
  tx: Tx,
  person: PersonContext,
  bill: BillRow,
  status: Exclude<ApBillStatus, "open">,
  note: string | null,
) {
  if (bill.status === "approved" || bill.status === "rejected") {
    throw new ApError("status", `the bill is already ${bill.status}`);
  }
  await tx
    .update(apBill)
    .set({
      status,
      decidedBy: person.userId,
      decidedAt: new Date(),
      decisionNote: note,
      updatedAt: new Date(),
    })
    .where(and(eq(apBill.tenantId, person.tenantId), eq(apBill.id, bill.id)));
}

/** One decision on a week's list, by the person on the card. Nothing is paid. */
export async function decidePayList(
  tx: Tx,
  person: PersonContext,
  week: string,
  d: PayListDecision,
): Promise<void> {
  const note = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t.slice(0, 1000) : null;
  };
  switch (d.action) {
    case "approve": {
      const bill = await listedBill(tx, person.tenantId, week, d.input.billId);
      // Human last: a person may approve a flagged bill, saying why.
      if (!isReady(bill.flags as ApFlag[], bill.matchStatus) && !note(d.input.note)) {
        throw new ApError(
          "invalid",
          "this bill has flags or lines without an account; say why it is approved anyway",
        );
      }
      await decideBill(tx, person, bill, "approved", note(d.input.note));
      return;
    }
    case "hold":
    case "reject": {
      const bill = await listedBill(tx, person.tenantId, week, d.input.billId);
      const n = note(d.input.note);
      if (!n)
        throw new ApError(
          "invalid",
          `say why the bill is ${d.action === "hold" ? "held" : "rejected"}`,
        );
      await decideBill(tx, person, bill, d.action === "hold" ? "held" : "rejected", n);
      return;
    }
    case "approve_ready": {
      const rows = await tx
        .select()
        .from(apBill)
        .where(
          and(
            eq(apBill.tenantId, person.tenantId),
            eq(apBill.payWeek, week),
            inArray(apBill.status, ["open", "held"]),
          ),
        );
      for (const b of rows) {
        if (isReady(b.flags as ApFlag[], b.matchStatus)) {
          await decideBill(tx, person, b, "approved", null);
        }
      }
      return;
    }
    case "code_line":
    case "take_proposal": {
      const [line] = await tx
        .select()
        .from(apBillLine)
        .where(and(eq(apBillLine.tenantId, person.tenantId), eq(apBillLine.id, d.input.billLineId)))
        .limit(1);
      if (!line) throw new ApError("not_found", "that line isn't one of this client's bills");
      const bill = await listedBill(tx, person.tenantId, week, line.apBillId);
      if (bill.status === "approved" || bill.status === "rejected") {
        throw new ApError("status", `the bill is ${bill.status}`);
      }
      const accountId =
        d.action === "code_line" ? d.input.ledgerAccountId : line.proposedLedgerAccountId;
      if (!accountId) throw new ApError("invalid", "that line has no suggestion to take");
      await codableAccount(tx, person.tenantId, accountId);
      await tx
        .update(apBillLine)
        .set({
          ledgerAccountId: accountId,
          codedBy: "person",
          codedByUserId: person.userId,
          updatedAt: new Date(),
        })
        .where(and(eq(apBillLine.tenantId, person.tenantId), eq(apBillLine.id, line.id)));
      await refreshBill(tx, person.tenantId, bill.id, { today: new Date() });
      return;
    }
    case "confirm_order":
    case "not_this_order": {
      const bill = await listedBill(tx, person.tenantId, week, d.input.billId);
      if (bill.matchStatus !== "proposed")
        throw new ApError("invalid", "there is no order to confirm");
      await tx
        .update(apBill)
        .set(
          d.action === "confirm_order"
            ? {
                matchStatus: "matched",
                match: { ...(bill.match as object), confirmedBy: person.userId },
                updatedAt: new Date(),
              }
            : {
                matchStatus: "none",
                purchaseRequestId: null,
                match: { ...(bill.match as object), refusedBy: person.userId },
                updatedAt: new Date(),
              },
        )
        .where(and(eq(apBill.tenantId, person.tenantId), eq(apBill.id, bill.id)));
      await refreshBill(tx, person.tenantId, bill.id, { today: new Date() });
      return;
    }
    case "received": {
      const bill = await listedBill(tx, person.tenantId, week, d.input.billId);
      if (!bill.purchaseRequestId) throw new ApError("invalid", "the bill has no order");
      const day = await clientDay(tx, person.tenantId, new Date());
      await recordReceipt(
        tx,
        { tenantId: person.tenantId, userId: person.userId },
        { purchaseRequestId: bill.purchaseRequestId, receivedOn: day, sources: [bill.id] },
      );
      return;
    }
  }
}
