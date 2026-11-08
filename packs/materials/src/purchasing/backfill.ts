// Prices from QuickBooks bills (docs/plan.md §1.67, `materials.backfill-from-bills`): the bills the
// QuickBooks sync already stored (a raw record per version, and the transaction mapped from it)
// become catalog matches and price observations, for a range of dates. Deterministic matching
// only (the vendor's alias, then the rules; a new item when the rules say so and every key
// attribute is stated). Lines the rules aren't sure of are counted and listed for review, never
// guessed. Idempotent: one observation per bill line, so a re-run adds nothing twice.
// What it can't use (account lines, lines without a quantity) is in packs/materials/NOTES.md.

import { dec, type QboLine, QboTransactionRaw, qboAmount, toNumeric } from "@countersign/core";
import { type Db, rawRecord, transaction, withTenant } from "@countersign/db";
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, or } from "drizzle-orm";
import { learnAlias } from "../catalog/store";
import { convert } from "../pricing/uom";
import { priceObservation } from "../schema";
import { matchText, type TextCandidate } from "./match-text";
import type { PurchasingContext } from "./requests";

export const BACKFILL_DEFAULT_LIMIT = 200;

export interface BackfillReviewLine {
  transactionId: string;
  rawRecordId: string;
  lineId: string;
  description: string;
  candidates: TextCandidate[];
}

export interface BackfillResult {
  from: string;
  to: string;
  bills: number;
  lines: number;
  itemLines: number;
  /** Expense lines on an account, with no item or quantity: not priced. */
  accountLines: number;
  recorded: number;
  alreadyRecorded: number;
  matched: number;
  newItems: number;
  needsReview: number;
  /** Item lines without a quantity or unit price, or with no conversion rule. */
  skipped: number;
  /** The unsure lines, at most 50, with their candidates. */
  review: BackfillReviewLine[];
  /** Where the next call starts when there are more bills in the range; null when done. */
  next: string | null;
  sources: string[];
}

const REVIEW_LIMIT = 50;

/** `yyyy-mm-dd:<transaction id>`: the last bill read, for the next call. */
function readCursor(after: string | undefined): { date: string; id: string } | null {
  if (!after) return null;
  const i = after.indexOf(":");
  if (i !== 10) return null;
  return { date: after.slice(0, 10), id: after.slice(11) };
}

function itemLine(l: QboLine): {
  description: string;
  qty: string;
  unitPrice: string;
  itemName: string | null;
} | null {
  const d = l.ItemBasedExpenseLineDetail;
  const itemName = d?.ItemRef?.name ?? null;
  const description = (l.Description ?? itemName ?? "").trim();
  if (!description || d?.Qty === undefined || d.UnitPrice === undefined) return null;
  const qty = qboAmount(d.Qty);
  const unitPrice = qboAmount(d.UnitPrice);
  if (!dec(qty).greaterThan(0) || dec(unitPrice).lessThan(0)) return null;
  return { description, qty, unitPrice, itemName };
}

/**
 * Reads the client's QuickBooks bills dated `from`..`to` (at most `limit` a call, oldest first) and
 * records a price for each matched item line. A test run matches and counts but writes nothing.
 */
export async function backfillFromBills(
  db: Db,
  ctx: PurchasingContext,
  input: { from: string; to: string; limit?: number | undefined; after?: string | undefined },
): Promise<BackfillResult> {
  const limit = Math.min(Math.max(input.limit ?? BACKFILL_DEFAULT_LIMIT, 1), 500);
  const cursor = readCursor(input.after);
  const out: BackfillResult = {
    from: input.from,
    to: input.to,
    bills: 0,
    lines: 0,
    itemLines: 0,
    accountLines: 0,
    recorded: 0,
    alreadyRecorded: 0,
    matched: 0,
    newItems: 0,
    needsReview: 0,
    skipped: 0,
    review: [],
    next: null,
    sources: [],
  };
  // DECISION: one transaction a call, so a failure leaves nothing half-recorded; a call reads at
  // most 500 bills, and `next` continues the range.
  return withTenant(db, ctx.tenantId, async (tx) => {
    const filters = [
      eq(transaction.tenantId, ctx.tenantId),
      eq(transaction.connector, "qbo"),
      eq(transaction.kind, "bill"),
      isNotNull(transaction.vendorId),
      isNotNull(transaction.sourceRawRecordId),
      gte(transaction.txnDate, input.from),
      lte(transaction.txnDate, input.to),
    ];
    if (cursor) {
      filters.push(
        or(
          gt(transaction.txnDate, cursor.date),
          and(eq(transaction.txnDate, cursor.date), gt(transaction.id, cursor.id)),
        ) as NonNullable<ReturnType<typeof or>>,
      );
    }
    const bills = await tx
      .select({ t: transaction, raw: rawRecord })
      .from(transaction)
      .innerJoin(
        rawRecord,
        and(
          eq(rawRecord.id, transaction.sourceRawRecordId),
          eq(rawRecord.tenantId, transaction.tenantId),
        ),
      )
      .where(and(...filters))
      .orderBy(asc(transaction.txnDate), asc(transaction.id))
      .limit(limit + 1);
    const page = bills.slice(0, limit);
    const last = page.at(-1);
    if (bills.length > limit && last) out.next = `${last.t.txnDate}:${last.t.id}`;
    const recorded = new Set(
      page.length === 0
        ? []
        : (
            await tx
              .select({
                transactionId: priceObservation.transactionId,
                line: priceObservation.rawLineId,
              })
              .from(priceObservation)
              .where(
                and(
                  eq(priceObservation.tenantId, ctx.tenantId),
                  isNotNull(priceObservation.rawLineId),
                  inArray(
                    priceObservation.transactionId,
                    page.map((b) => b.t.id),
                  ),
                ),
              )
          ).map((r) => `${r.transactionId}:${r.line}`),
    );
    for (const { t, raw } of page) {
      if (raw.isDeleted || raw.entityType !== "Bill") continue;
      const parsed = QboTransactionRaw.safeParse(raw.payload);
      if (!parsed.success) continue;
      out.bills++;
      const bill = parsed.data;
      const currency = (bill.CurrencyRef?.value ?? "USD").toUpperCase();
      for (const [i, l] of (bill.Line ?? []).entries()) {
        if (l.DetailType === "AccountBasedExpenseLineDetail") {
          out.lines++;
          out.accountLines++;
          continue;
        }
        if (l.DetailType !== "ItemBasedExpenseLineDetail") continue;
        out.lines++;
        out.itemLines++;
        // DECISION: a line is known by QuickBooks' line id within the bill (its position when it
        // has none), across the bill's versions: a bill edited after its prices were recorded
        // keeps the first price.
        const lineId = l.Id ?? `#${i + 1}`;
        if (recorded.has(`${t.id}:${lineId}`)) {
          out.alreadyRecorded++;
          continue;
        }
        const line = itemLine(l);
        if (!line) {
          out.skipped++;
          continue;
        }
        const vendorId = t.vendorId as string;
        const m = await matchText(tx, ctx.tenantId, {
          description: line.description,
          vendorId,
          // P-9: a person's import (the back office's action) makes items as that person.
          create: ctx.testRun
            ? null
            : ctx.userId
              ? { userId: ctx.userId }
              : { agentVersionId: ctx.agentVersionId },
        });
        if (m.decision === "unsure" || !m.item) {
          out.needsReview++;
          if (out.review.length < REVIEW_LIMIT) {
            out.review.push({
              transactionId: t.id,
              rawRecordId: raw.id,
              lineId,
              description: line.description,
              candidates: m.candidates,
            });
          }
          continue;
        }
        if (m.decision === "new_item") out.newItems++;
        else out.matched++;
        // DECISION: QuickBooks bill lines carry no unit, so the price is taken to be per the
        // item's standard unit (as a document line without a unit is), and marked `uomAssumed`.
        const conv = convert(null, m.item.standardUom, m.item.attributes as Record<string, string>);
        if (!conv.ok) {
          out.skipped++;
          continue;
        }
        if (ctx.testRun) continue;
        if (m.method === "rules") {
          await learnAlias(tx, ctx.tenantId, {
            vendorId,
            vendorSku: null,
            descriptionHash: m.hash,
            normalizedDescription: m.normalized,
            catalogItemId: m.item.id,
            source: "auto",
          });
        }
        const [row] = await tx
          .insert(priceObservation)
          .values({
            tenantId: ctx.tenantId,
            catalogItemId: m.item.id,
            vendorId,
            observedOn: bill.TxnDate ?? (t.txnDate as string),
            unitPriceStd: toNumeric(dec(line.unitPrice).dividedBy(conv.factor)),
            qtyStd: toNumeric(dec(line.qty).times(conv.factor)),
            standardUom: m.item.standardUom,
            currency,
            transactionId: t.id,
            rawRecordId: raw.id,
            rawLineId: lineId,
            agentVersionId: ctx.userId ? null : ctx.agentVersionId,
            ext: {
              source: "qbo_bill",
              qboBillId: bill.Id,
              item: line.itemName,
              matchMethod: m.method,
              uomAssumed: true,
              conversion: conv.rule,
            },
          })
          .onConflictDoNothing()
          .returning({ id: priceObservation.id });
        if (row) {
          out.recorded++;
          recorded.add(`${t.id}:${lineId}`);
          out.sources.push(row.id);
        } else {
          out.alreadyRecorded++;
        }
      }
      out.sources.push(raw.id);
    }
    return out;
  });
}
