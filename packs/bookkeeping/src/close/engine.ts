// The Close pack's pure parts (docs/plan.md §1.232): the books as of a period's end, the accruals a
// vendor's billing pattern calls for, and an entry's balance. Code, never the model (invariant 7);
// amounts in decimal.js (invariant 6). Database work is in ./store.ts.

import { type BooksSnapshot, dec, qboAmount, readBooks } from "@countersign/core";
import { z } from "zod";

type Decimal = ReturnType<typeof dec>;

/** The transaction entities a period's end cuts off (accounts and vendors are kept whole). */
const DATED = new Set(["Bill", "Purchase", "Invoice", "Payment"]);

/**
 * The books as they stood at the period's end: every account and vendor, and only the
 * transactions dated on or before it. The checks library then reads the period's books.
 */
// DECISION: a transaction without a date is kept (QuickBooks always dates them; a record that
// doesn't is one the checks leave out anyway).
export function booksAsOf(snapshot: BooksSnapshot, periodEnd: string): BooksSnapshot {
  return {
    ...snapshot,
    records: snapshot.records.filter((r) => {
      if (!DATED.has(r.entity)) return true;
      const d = (r.payload as { TxnDate?: unknown } | null)?.TxnDate;
      return typeof d !== "string" || d <= periodEnd;
    }),
  };
}

/** `yyyy-mm` of a day. */
const monthOf = (day: string) => day.slice(0, 7);

/** The month `n` months before `yyyy-mm` (n may be 0). */
export function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

/** The first and last day of `yyyy-mm`. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

/** The day after `day`. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const BillLine = z.looseObject({
  Amount: z.union([z.number(), z.string()]).optional(),
  AccountBasedExpenseLineDetail: z
    .looseObject({
      AccountRef: z
        .looseObject({ value: z.union([z.string(), z.number()]).transform(String) })
        .optional(),
    })
    .optional(),
});

function amount(v: unknown): Decimal {
  if (v === undefined || v === null) return dec("0");
  try {
    return dec(qboAmount(v as number | string));
  } catch {
    return dec("0");
  }
}

/** An accrual a vendor's bills call for: billed every one of the months before, not yet in this one. */
export interface AccrualPattern {
  /** `accrual:<vendor id>:<account id>` (QuickBooks ids), stable from month to month. */
  key: string;
  vendorId: string;
  vendorName: string;
  /** The expense account the bills were booked to (QuickBooks id). */
  accountId: string;
  /** The middle month's amount (the lower middle for an even count), decimal string, 4 places. */
  amount: string;
  /** Each month's total, oldest first: what the amount rests on. */
  months: { month: string; amount: string }[];
  /** The bills' raw records (evidence, invariant 10). */
  sources: string[];
}

/**
 * Vendors billed to the same expense account in each of the `months` months before the period,
 * and not at all yet in the period: the period's likely bill, to accrue.
 */
// DECISION: a pattern is a vendor and an account billed in every one of the months before (3 by
// default, the pack's `accrual_months`), with nothing for them dated in the period itself. The
// amount is the middle month's (median, the lower of the two middle for an even count), so one odd
// month doesn't move it, and it never needs a division. Item lines aren't read (no account on them).
export function accrualPatterns(
  snapshot: BooksSnapshot,
  period: { start: string; end: string },
  months: number,
): AccrualPattern[] {
  const books = readBooks(snapshot);
  const vendorNames = new Map(
    books.vendors.map(({ v }) => [v.Id, v.DisplayName ?? v.CompanyName ?? v.Id]),
  );
  const periodMonth = monthOf(period.start);
  const wanted = Array.from({ length: months }, (_, i) => monthsBefore(periodMonth, months - i));
  // vendor|account → month → total, and the bills' sources.
  const totals = new Map<string, Map<string, Decimal>>();
  const sources = new Map<string, Set<string>>();
  const inPeriod = new Set<string>();
  for (const { r, v } of books.bills) {
    const vendor = v.VendorRef?.value;
    const day = v.TxnDate;
    if (!vendor || !day) continue;
    const month = monthOf(day);
    for (const raw of v.Line ?? []) {
      const line = BillLine.safeParse(raw);
      const account = line.success
        ? line.data.AccountBasedExpenseLineDetail?.AccountRef?.value
        : null;
      if (!line.success || !account) continue;
      const key = `${vendor}|${account}`;
      if (month === periodMonth) {
        inPeriod.add(key);
        continue;
      }
      if (!wanted.includes(month)) continue;
      const byMonth = totals.get(key) ?? new Map<string, Decimal>();
      byMonth.set(month, (byMonth.get(month) ?? dec("0")).plus(amount(line.data.Amount)));
      totals.set(key, byMonth);
      const s = sources.get(key) ?? new Set<string>();
      s.add(r.source);
      sources.set(key, s);
    }
  }
  const out: AccrualPattern[] = [];
  for (const [key, byMonth] of totals) {
    if (inPeriod.has(key)) continue;
    if (!wanted.every((m) => (byMonth.get(m) ?? dec("0")).greaterThan(0))) continue;
    const [vendorId, accountId] = key.split("|") as [string, string];
    const series = wanted.map((m) => ({ month: m, amount: byMonth.get(m) ?? dec("0") }));
    const sorted = [...series].sort((a, b) => a.amount.comparedTo(b.amount));
    const middle = sorted[Math.floor((sorted.length - 1) / 2)]?.amount ?? dec("0");
    out.push({
      key: `accrual:${vendorId}:${accountId}`,
      vendorId,
      vendorName: vendorNames.get(vendorId) ?? vendorId,
      accountId,
      amount: middle.toFixed(4),
      months: series.map((s) => ({ month: s.month, amount: s.amount.toFixed(4) })),
      sources: [...(sources.get(key) ?? [])].sort(),
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** One line of a proposed entry. */
export interface EntryLine {
  ledgerAccountId: string;
  posting: "debit" | "credit";
  amount: string;
  description?: string | null | undefined;
}

/** The entry's total when its debits equal its credits and every line is more than zero; else why not. */
export function entryTotal(lines: readonly EntryLine[]): { total: string } | { problem: string } {
  if (lines.length < 2) return { problem: "an entry has at least two lines" };
  let debits = dec("0");
  let credits = dec("0");
  for (const l of lines) {
    const a = dec(l.amount);
    if (!a.greaterThan(0)) return { problem: "every line's amount is more than zero" };
    if (a.decimalPlaces() > 2) return { problem: "amounts are in cents" };
    if (l.posting === "debit") debits = debits.plus(a);
    else credits = credits.plus(a);
  }
  if (!debits.equals(credits)) {
    return {
      problem: `the debits (${debits.toFixed(2)}) and credits (${credits.toFixed(2)}) don't balance`,
    };
  }
  return { total: debits.toFixed(4) };
}

/** A month in words for a memo ("October 2026"). */
export function monthWords(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
