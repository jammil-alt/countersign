// Books health (docs/plan.md §1.216): a fixed set of checks over the QuickBooks records we sync,
// as a library. Pure: it reads a snapshot (each record's latest synced version, with the raw record
// it came from) and answers findings; the caller loads the snapshot and says what it knows that
// QuickBooks' API doesn't (which accounts were reconciled, and through when). Built for the books
// health report and kept a library for the Close pack to reuse (`checkBooks`, `BOOKS_CHECKS`).
//
// Deterministic only: no model reads the books here (invariant 7). Money is decimal (invariant 6):
// QuickBooks' JSON numbers are read through `qboAmount`, never added as floats.

import { z } from "zod";
import { qboAmount } from "../mappers/qbo";
import { type Decimal, dec, toNumeric } from "../money";
import type { OwnerArea } from "../owners/areas";
import {
  BOOKS_CHECK_IDS,
  type BooksCheckId,
  type BooksExample,
  type BooksFinding,
  type BooksGroup,
  type BooksHealthReport,
} from "./schemas";

/** One synced QuickBooks record: its latest version that isn't deleted. */
export interface BooksRecord {
  /** QuickBooks' entity name: Account, Vendor, Customer, Bill, Purchase, Invoice, Payment, … */
  entity: string;
  /** QuickBooks' id. */
  externalId: string;
  /** The raw record it was read from (a finding's evidence). */
  source: string;
  payload: unknown;
}

export interface BooksSnapshot {
  /** The company's home currency. */
  currency: string;
  records: readonly BooksRecord[];
  /**
   * The last day each account (QuickBooks account id) was reconciled through, where we know it.
   * QuickBooks' API doesn't say; the caller fills it (today: reconciliations signed off in Mezonas).
   */
  reconciledThrough?: Readonly<Record<string, string>>;
}

export interface BooksHealthOptions {
  /** The day the report is as of (yyyy-mm-dd). */
  asOf: string;
  /** Run only these checks (all of them when absent). */
  checks?: readonly BooksCheckId[];
}

export interface BooksCheck {
  id: BooksCheckId;
  title: string;
  area: OwnerArea;
  pack: string | null;
  run(books: Books, asOf: string): Omit<BooksFinding, "check" | "title" | "area" | "pack"> | null;
}

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────

// DECISION: an account is stale when it was last reconciled more than 45 days before the report
// (a month's statement plus two weeks to close it), or never.
export const RECONCILE_STALE_DAYS = 45;
// DECISION: an invoice or bill counts when it is more than 30 days past its due date (its date when
// it has none); the groups are the usual buckets, 31–60, 61–90 and over 90.
export const AGING_PAST_DAYS = 30;
// DECISION: two bills are the same bill when they share the vendor and the total and either the
// same bill number, or neither has one and they are dated within 3 days of each other.
export const DUPLICATE_BILL_DAYS = 3;
// DECISION: money in Undeposited Funds is a finding once a payment that makes up its balance has
// waited more than 7 days.
export const UNDEPOSITED_DAYS = 7;
// DECISION: a vendor's price for an item has drifted when a later line is at least 10% over the
// median of the earlier half of its lines, over the last 365 days.
export const PRICE_DRIFT_PERCENT = "10";
export const PRICE_DRIFT_DAYS = 365;
/** Examples per finding. */
export const BOOKS_EXAMPLES = 5;

// ── Reading QuickBooks' records ─────────────────────────────────────────────────────────────────

const Ref = z.looseObject({
  value: z.union([z.string(), z.number()]).transform(String),
  name: z.string().optional(),
});
const Amount = z.union([z.number(), z.string()]);
const Line = z.looseObject({
  Amount: Amount.optional(),
  DetailType: z.string().optional(),
  AccountBasedExpenseLineDetail: z.looseObject({ AccountRef: Ref.optional() }).optional(),
  ItemBasedExpenseLineDetail: z
    .looseObject({
      ItemRef: Ref.optional(),
      UnitPrice: Amount.optional(),
      Qty: Amount.optional(),
    })
    .optional(),
});
const Txn = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  TxnDate: z.string().optional(),
  DueDate: z.string().optional(),
  DocNumber: z.string().optional(),
  TotalAmt: Amount.optional(),
  Balance: Amount.optional(),
  PrivateNote: z.string().optional(),
  VendorRef: Ref.optional(),
  CustomerRef: Ref.optional(),
  EntityRef: Ref.optional(),
  AccountRef: Ref.optional(),
  DepositToAccountRef: Ref.optional(),
  Line: z.array(z.unknown()).optional(),
});
type Txn = z.infer<typeof Txn>;
const Account = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  Name: z.string().optional(),
  FullyQualifiedName: z.string().optional(),
  AccountType: z.string().optional(),
  AccountSubType: z.string().optional(),
  Active: z.boolean().optional(),
  CurrentBalance: Amount.optional(),
});
type Account = z.infer<typeof Account>;
const Vendor = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  DisplayName: z.string().optional(),
  CompanyName: z.string().optional(),
  Active: z.boolean().optional(),
});
type Vendor = z.infer<typeof Vendor>;

interface Row<T> {
  r: BooksRecord;
  v: T;
}

/** The snapshot read once: records by entity, parsed; a record that doesn't parse is left out. */
export interface Books {
  currency: string;
  accounts: Row<Account>[];
  vendors: Row<Vendor>[];
  bills: Row<Txn>[];
  purchases: Row<Txn>[];
  invoices: Row<Txn>[];
  payments: Row<Txn>[];
  accountById: Map<string, Account>;
  reconciledThrough: Readonly<Record<string, string>>;
}

function rows<T>(records: readonly BooksRecord[], entity: string, schema: z.ZodType<T>): Row<T>[] {
  const out: Row<T>[] = [];
  for (const r of records) {
    if (r.entity !== entity) continue;
    const p = schema.safeParse(r.payload);
    if (p.success) out.push({ r, v: p.data });
  }
  return out;
}

export function readBooks(s: BooksSnapshot): Books {
  const accounts = rows(s.records, "Account", Account);
  return {
    currency: s.currency,
    accounts,
    vendors: rows(s.records, "Vendor", Vendor),
    bills: rows(s.records, "Bill", Txn),
    purchases: rows(s.records, "Purchase", Txn),
    invoices: rows(s.records, "Invoice", Txn),
    payments: rows(s.records, "Payment", Txn),
    accountById: new Map(accounts.map(({ v }) => [v.Id, v])),
    reconciledThrough: s.reconciledThrough ?? {},
  };
}

function amt(v: unknown): Decimal {
  if (v === undefined || v === null) return dec("0");
  try {
    return dec(qboAmount(v));
  } catch {
    return dec("0");
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function day(v: string | undefined | null): string | null {
  return v && ISO.test(v) ? v : null;
}
/** Whole days from `a` to `b` (both yyyy-mm-dd). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}
function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function accountName(a: Account | undefined, fallback?: string): string {
  return a?.FullyQualifiedName ?? a?.Name ?? fallback ?? "";
}

function example(
  entity: string,
  row: Row<Txn>,
  amount: Decimal,
  name: string | null,
  note: string | null,
): BooksExample & { sort: Decimal } {
  return {
    entity,
    externalId: row.v.Id,
    source: row.r.source,
    date: day(row.v.TxnDate),
    name,
    ref: row.v.DocNumber?.trim() || null,
    amount: toNumeric(amount),
    note,
    sort: amount.abs(),
  };
}

function top(examples: (BooksExample & { sort: Decimal })[]): BooksExample[] {
  return [...examples]
    .sort((a, b) => b.sort.comparedTo(a.sort) || (a.date ?? "").localeCompare(b.date ?? ""))
    .slice(0, BOOKS_EXAMPLES)
    .map(({ sort: _s, ...e }) => e);
}

function sum(values: Iterable<Decimal>): Decimal {
  let t = dec("0");
  for (const v of values) t = t.plus(v);
  return t;
}

const uniq = (ids: Iterable<string>) => [...new Set(ids)];

function dollars(d: Decimal): string {
  const [whole = "0", cents = "00"] = d.abs().toDecimalPlaces(2).toFixed(2).split(".");
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${cents === "00" ? "" : `.${cents}`}`;
}
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function finding(
  amount: Decimal,
  count: number,
  summary: string,
  examples: BooksExample[],
  groups: BooksGroup[],
  sources: string[],
  currency: string,
) {
  return {
    summary,
    amount: toNumeric(amount),
    currency,
    count,
    examples,
    groups,
    sources: uniq(sources),
  };
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────

const RECONCILED_TYPES = new Set(["Bank", "Credit Card"]);

/** Bank and card accounts not reconciled for more than 45 days, and what has moved through them since. */
const unreconciled: BooksCheck = {
  id: "unreconciled_accounts",
  title: "Accounts not reconciled",
  area: "bookkeeping",
  pack: "bookkeeping",
  run(b, asOf) {
    const groups: BooksGroup[] = [];
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const sources: string[] = [];
    let total = dec("0");
    let count = 0;
    for (const { r, v: a } of b.accounts) {
      if (!RECONCILED_TYPES.has(a.AccountType ?? "") || a.Active === false) continue;
      const through = day(b.reconciledThrough[a.Id]);
      const moved = [
        ...b.purchases
          .filter(({ v }) => v.AccountRef?.value === a.Id)
          .map((row) => ({ row, entity: "Purchase", name: row.v.EntityRef?.name ?? null })),
        ...b.payments
          .filter(({ v }) => v.DepositToAccountRef?.value === a.Id)
          .map((row) => ({ row, entity: "Payment", name: row.v.CustomerRef?.name ?? null })),
      ].filter(({ row }) => {
        const d = day(row.v.TxnDate);
        return d !== null && d <= asOf && (through === null || d > through);
      });
      if (moved.length === 0) continue;
      const oldest = moved.map(({ row }) => row.v.TxnDate as string).sort()[0] as string;
      const age = daysBetween(through ?? oldest, asOf);
      if (through !== null && age <= RECONCILE_STALE_DAYS) continue;
      const amount = sum(moved.map(({ row }) => amt(row.v.TotalAmt).abs()));
      total = total.plus(amount);
      count += moved.length;
      sources.push(r.source, ...moved.map(({ row }) => row.r.source));
      for (const m of moved) {
        examples.push(
          example(
            m.entity,
            m.row,
            amt(m.row.v.TotalAmt),
            m.name,
            `Not reconciled: ${accountName(a)}`,
          ),
        );
      }
      groups.push({
        label: accountName(a),
        amount: toNumeric(amount),
        count: moved.length,
        note:
          through === null
            ? `Never reconciled with us; activity from ${oldest}`
            : `Last reconciled through ${through}, ${age} days ago`,
      });
    }
    if (groups.length === 0) return null;
    return finding(
      total,
      count,
      `${plural(groups.length, "account")} not reconciled, with ${dollars(total)} in ${plural(count, "transaction")} since.`,
      top(examples),
      groups,
      sources,
      b.currency,
    );
  },
};

const UNCATEGORIZED = /\buncategori[sz]ed\b|\bask my accountant\b/i;

/** Expense lines booked to Uncategorized (or Ask My Accountant). */
const uncategorized: BooksCheck = {
  id: "uncategorized",
  title: "Uncategorized transactions",
  area: "bookkeeping",
  pack: "bookkeeping",
  run(b) {
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const sources: string[] = [];
    const byAccount = new Map<string, { amount: Decimal; count: number }>();
    let total = dec("0");
    for (const [entity, list] of [
      ["Purchase", b.purchases],
      ["Bill", b.bills],
    ] as const) {
      for (const row of list) {
        let amount = dec("0");
        const hit = new Set<string>();
        for (const raw of row.v.Line ?? []) {
          const line = Line.safeParse(raw);
          if (!line.success) continue;
          const ref = line.data.AccountBasedExpenseLineDetail?.AccountRef;
          if (!ref) continue;
          const name = accountName(b.accountById.get(ref.value), ref.name);
          if (!UNCATEGORIZED.test(name)) continue;
          amount = amount.plus(amt(line.data.Amount));
          hit.add(name);
        }
        if (hit.size === 0) continue;
        total = total.plus(amount);
        sources.push(row.r.source);
        const label = [...hit].join(", ");
        const g = byAccount.get(label) ?? { amount: dec("0"), count: 0 };
        byAccount.set(label, { amount: g.amount.plus(amount), count: g.count + 1 });
        const who = row.v.VendorRef?.name ?? row.v.EntityRef?.name ?? null;
        examples.push(example(entity, row, amount, who, label));
      }
    }
    if (sources.length === 0) return null;
    const count = sources.length;
    return finding(
      total,
      count,
      `${plural(count, "transaction")} worth ${dollars(total)} ${count === 1 ? "has" : "have"} no category.`,
      top(examples),
      [...byAccount].map(([label, g]) => ({
        label,
        amount: toNumeric(g.amount),
        count: g.count,
        note: null,
      })),
      sources,
      b.currency,
    );
  },
};

const NAME_SUFFIX = new Set(["inc", "llc", "ltd", "co", "corp", "corporation", "company", "lp"]);
/** A vendor's name for comparing: case, punctuation, "&", a leading "the" and a company suffix aside. */
export function vendorKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words[0] === "the") words.shift();
  while (words.length > 1 && NAME_SUFFIX.has(words[words.length - 1] as string)) words.pop();
  return words.join(" ");
}

/** Active vendors that are the same business under two or more names. */
const duplicateVendors: BooksCheck = {
  id: "duplicate_vendors",
  title: "Duplicate vendors",
  area: "purchasing",
  pack: "materials",
  run(b) {
    const byKey = new Map<string, Row<Vendor>[]>();
    for (const row of b.vendors) {
      if (row.v.Active === false) continue;
      const key = vendorKey(row.v.DisplayName ?? row.v.CompanyName ?? "");
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const billed = new Map<string, Decimal>();
    for (const { v } of b.bills) {
      const id = v.VendorRef?.value;
      if (id) billed.set(id, (billed.get(id) ?? dec("0")).plus(amt(v.TotalAmt)));
    }
    const groups: BooksGroup[] = [];
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const sources: string[] = [];
    let total = dec("0");
    let count = 0;
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      // DECISION: the vendor billed the most is the one to keep; the dollars are what was billed
      // under the other names.
      const ranked = [...list].sort(
        (x, y) =>
          (billed.get(y.v.Id) ?? dec("0")).comparedTo(billed.get(x.v.Id) ?? dec("0")) ||
          x.v.Id.localeCompare(y.v.Id),
      );
      const extras = ranked.slice(1);
      const amount = sum(extras.map((x) => billed.get(x.v.Id) ?? dec("0")));
      total = total.plus(amount);
      count += extras.length;
      sources.push(...list.map((x) => x.r.source));
      groups.push({
        label: ranked.map((x) => x.v.DisplayName ?? x.v.Id).join(" / "),
        amount: toNumeric(amount),
        count: list.length,
        note: `Keep ${ranked[0]?.v.DisplayName ?? ""}`,
      });
      for (const x of extras) {
        const a = billed.get(x.v.Id) ?? dec("0");
        examples.push({
          entity: "Vendor",
          externalId: x.v.Id,
          source: x.r.source,
          date: null,
          name: x.v.DisplayName ?? null,
          ref: null,
          amount: toNumeric(a),
          note: `Same as ${ranked[0]?.v.DisplayName ?? ""}`,
          sort: a,
        });
      }
    }
    if (groups.length === 0) return null;
    return finding(
      total,
      count,
      `${plural(groups.length, "vendor")} entered more than once, with ${dollars(total)} billed under the extra names.`,
      top(examples),
      groups,
      sources,
      b.currency,
    );
  },
};

/** Bills entered twice: same vendor and total, and the same number or nearly the same day. */
const duplicateBills: BooksCheck = {
  id: "duplicate_bills",
  title: "Duplicate bills",
  area: "purchasing",
  pack: "materials",
  run(b) {
    const byKey = new Map<string, Row<Txn>[]>();
    for (const row of b.bills) {
      const vendor = row.v.VendorRef?.value;
      const total = amt(row.v.TotalAmt);
      if (!vendor || total.isZero()) continue;
      const key = `${vendor}|${toNumeric(total)}`;
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const sources: string[] = [];
    let total = dec("0");
    let count = 0;
    for (const list of byKey.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort(
        (x, y) =>
          (x.v.TxnDate ?? "").localeCompare(y.v.TxnDate ?? "") || x.v.Id.localeCompare(y.v.Id),
      );
      const kept: Row<Txn>[] = [];
      for (const row of sorted) {
        const doc = row.v.DocNumber?.trim().toLowerCase() ?? "";
        const first = kept.find((k) => {
          const kd = k.v.DocNumber?.trim().toLowerCase() ?? "";
          if (doc || kd) return doc === kd;
          const a = day(k.v.TxnDate);
          const c = day(row.v.TxnDate);
          return a !== null && c !== null && Math.abs(daysBetween(a, c)) <= DUPLICATE_BILL_DAYS;
        });
        if (!first) {
          kept.push(row);
          continue;
        }
        const a = amt(row.v.TotalAmt);
        total = total.plus(a);
        count += 1;
        sources.push(first.r.source, row.r.source);
        examples.push(
          example(
            "Bill",
            row,
            a,
            row.v.VendorRef?.name ?? null,
            `Same as bill ${first.v.DocNumber?.trim() || first.v.Id} of ${first.v.TxnDate ?? "?"}`,
          ),
        );
      }
    }
    if (count === 0) return null;
    return finding(
      total,
      count,
      `${plural(count, "bill")} worth ${dollars(total)} look entered twice.`,
      top(examples),
      [],
      sources,
      b.currency,
    );
  },
};

const BUCKETS = [
  { label: "31–60 days past due", from: 31, to: 60 },
  { label: "61–90 days past due", from: 61, to: 90 },
  { label: "Over 90 days past due", from: 91, to: Number.POSITIVE_INFINITY },
] as const;

function aging(
  list: Row<Txn>[],
  entity: "Invoice" | "Bill",
  who: (t: Txn) => string | null,
  asOf: string,
  currency: string,
  words: { one: string; many: string; verb: string },
) {
  const groups = BUCKETS.map((bucket) => ({ ...bucket, amount: dec("0"), count: 0 }));
  const examples: (BooksExample & { sort: Decimal })[] = [];
  const sources: string[] = [];
  let total = dec("0");
  for (const row of list) {
    const open = amt(row.v.Balance);
    if (open.lte(0)) continue;
    const due = day(row.v.DueDate) ?? day(row.v.TxnDate);
    if (!due) continue;
    const late = daysBetween(due, asOf);
    if (late <= AGING_PAST_DAYS) continue;
    const g = groups.find((x) => late >= x.from && late <= x.to);
    if (g) {
      g.amount = g.amount.plus(open);
      g.count += 1;
    }
    total = total.plus(open);
    sources.push(row.r.source);
    examples.push(example(entity, row, open, who(row.v), `${late} days past due`));
  }
  if (sources.length === 0) return null;
  const n = sources.length;
  return finding(
    total,
    n,
    `${dollars(total)} on ${n} ${n === 1 ? words.one : words.many} ${words.verb} more than ${AGING_PAST_DAYS} days past due.`,
    top(examples),
    groups
      .filter((g) => g.count > 0)
      .map((g) => ({ label: g.label, amount: toNumeric(g.amount), count: g.count, note: null })),
    sources,
    currency,
  );
}

/** Open invoices more than 30 days past due, in buckets. */
const receivablesAging: BooksCheck = {
  id: "receivables_aging",
  title: "Overdue invoices",
  area: "receivables",
  // DECISION: Receivables has no pack yet (core owners/areas.ts), so the finding names the area only.
  pack: null,
  run: (b, asOf) =>
    aging(b.invoices, "Invoice", (t) => t.CustomerRef?.name ?? null, asOf, b.currency, {
      one: "invoice",
      many: "invoices",
      verb: "is",
    }),
};

/** Open bills more than 30 days past due, in buckets. */
const payablesAging: BooksCheck = {
  id: "payables_aging",
  title: "Overdue bills",
  area: "purchasing",
  pack: "materials",
  run: (b, asOf) =>
    aging(b.bills, "Bill", (t) => t.VendorRef?.name ?? null, asOf, b.currency, {
      one: "bill",
      many: "bills",
      verb: "is",
    }),
};

// DECISION (UNCHECKED, qbo/NOTES.md): QuickBooks keeps an asset's balance positive when the company
// has it and a liability's positive when the company owes it, so below zero is wrong for both: an
// overdrawn bank, a credit on a card, more paid to vendors than billed.
const NEVER_NEGATIVE = new Set([
  "Bank",
  "Accounts Receivable",
  "Other Current Asset",
  "Fixed Asset",
  "Other Asset",
  "Accounts Payable",
  "Credit Card",
  "Other Current Liability",
  "Long Term Liability",
]);

/** Asset and liability accounts below zero. */
const negativeBalances: BooksCheck = {
  id: "negative_balances",
  title: "Balances below zero",
  area: "bookkeeping",
  pack: "bookkeeping",
  run(b) {
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const groups: BooksGroup[] = [];
    const sources: string[] = [];
    let total = dec("0");
    for (const { r, v: a } of b.accounts) {
      if (a.Active === false || !NEVER_NEGATIVE.has(a.AccountType ?? "")) continue;
      const balance = amt(a.CurrentBalance);
      if (balance.gte(0)) continue;
      total = total.plus(balance.abs());
      sources.push(r.source);
      groups.push({
        label: accountName(a),
        amount: toNumeric(balance),
        count: 1,
        note: a.AccountType ?? null,
      });
      examples.push({
        entity: "Account",
        externalId: a.Id,
        source: r.source,
        date: null,
        name: accountName(a),
        ref: null,
        amount: toNumeric(balance),
        note: `${a.AccountType} account below zero`,
        sort: balance.abs(),
      });
    }
    if (groups.length === 0) return null;
    return finding(
      total,
      groups.length,
      `${plural(groups.length, "account")} below zero, by ${dollars(total)} in all.`,
      top(examples),
      groups,
      sources,
      b.currency,
    );
  },
};

function isUndepositedFunds(a: Account): boolean {
  return a.AccountSubType === "UndepositedFunds" || /^undeposited funds$/i.test(a.Name ?? "");
}

/** Customer payments waiting in Undeposited Funds. */
const undepositedFunds: BooksCheck = {
  id: "undeposited_funds",
  title: "Undeposited funds",
  area: "bookkeeping",
  pack: "bookkeeping",
  run(b, asOf) {
    const uf = b.accounts.find(({ v }) => v.Active !== false && isUndepositedFunds(v));
    if (!uf) return null;
    const balance = amt(uf.v.CurrentBalance);
    if (balance.lte(0)) return null;
    // DECISION: deposits aren't synced, so which payments are still waiting can't be read; the
    // newest payments into Undeposited Funds (a payment with no deposit account goes there) that
    // make up its balance are taken as the ones waiting, since a deposit takes the older ones first.
    const into = b.payments
      .filter(({ v }) => {
        const d = day(v.TxnDate);
        const to = v.DepositToAccountRef?.value;
        return d !== null && d <= asOf && (to === undefined || to === uf.v.Id);
      })
      .sort(
        (x, y) =>
          (y.v.TxnDate ?? "").localeCompare(x.v.TxnDate ?? "") || y.v.Id.localeCompare(x.v.Id),
      );
    const waiting: Row<Txn>[] = [];
    let covered = dec("0");
    for (const row of into) {
      if (covered.gte(balance)) break;
      waiting.push(row);
      covered = covered.plus(amt(row.v.TotalAmt));
    }
    const oldest = waiting[waiting.length - 1]?.v.TxnDate;
    const waited = oldest ? daysBetween(oldest, asOf) : null;
    if (waited !== null && waited <= UNDEPOSITED_DAYS) return null;
    const count = Math.max(1, waiting.length);
    return finding(
      balance,
      count,
      `${dollars(balance)} in customer payments ${waited === null ? "is" : `has waited up to ${waited} days`} in Undeposited Funds.`,
      top(
        waiting.map((row) =>
          example(
            "Payment",
            row,
            amt(row.v.TotalAmt),
            row.v.CustomerRef?.name ?? null,
            `Received ${row.v.TxnDate}, not deposited`,
          ),
        ),
      ),
      [
        {
          label: accountName(uf.v),
          amount: toNumeric(balance),
          count: waiting.length,
          note: null,
        },
      ],
      [uf.r.source, ...waiting.map((row) => row.r.source)],
      b.currency,
    );
  },
};

function median(values: Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2
    ? (s[mid] as Decimal)
    : (s[mid - 1] as Decimal).plus(s[mid] as Decimal).div(2);
}

/** An item's price from one vendor rising 10% or more over the year. */
const priceDrift: BooksCheck = {
  id: "price_drift",
  title: "Vendor prices rising",
  area: "purchasing",
  pack: "materials",
  run(b, asOf) {
    const since = addDays(asOf, -PRICE_DRIFT_DAYS);
    const byKey = new Map<
      string,
      {
        row: Row<Txn>;
        entity: string;
        vendor: string;
        item: string;
        price: Decimal;
        qty: Decimal;
      }[]
    >();
    for (const [entity, list] of [
      ["Bill", b.bills],
      ["Purchase", b.purchases],
    ] as const) {
      for (const row of list) {
        const d = day(row.v.TxnDate);
        const vendor = entity === "Bill" ? row.v.VendorRef : row.v.EntityRef;
        if (!d || d < since || d > asOf || !vendor) continue;
        for (const raw of row.v.Line ?? []) {
          const line = Line.safeParse(raw);
          const detail = line.success ? line.data.ItemBasedExpenseLineDetail : undefined;
          if (!detail?.ItemRef || detail.UnitPrice === undefined) continue;
          const price = amt(detail.UnitPrice);
          if (price.lte(0)) continue;
          const key = `${vendor.value}|${detail.ItemRef.value}`;
          byKey.set(key, [
            ...(byKey.get(key) ?? []),
            {
              row,
              entity,
              vendor: vendor.name ?? vendor.value,
              item: detail.ItemRef.name ?? detail.ItemRef.value,
              price,
              qty: detail.Qty === undefined ? dec("1") : amt(detail.Qty),
            },
          ]);
        }
      }
    }
    const factor = dec("1").plus(dec(PRICE_DRIFT_PERCENT).div(100));
    const groups: BooksGroup[] = [];
    const examples: (BooksExample & { sort: Decimal })[] = [];
    const sources: string[] = [];
    let total = dec("0");
    let count = 0;
    for (const lines of byKey.values()) {
      if (lines.length < 2) continue;
      const sorted = [...lines].sort(
        (x, y) =>
          (x.row.v.TxnDate ?? "").localeCompare(y.row.v.TxnDate ?? "") ||
          x.row.v.Id.localeCompare(y.row.v.Id),
      );
      const early = sorted.slice(0, Math.ceil(sorted.length / 2));
      const baseline = median(early.map((l) => l.price));
      const drifted = sorted.slice(early.length).filter((l) => l.price.gte(baseline.times(factor)));
      if (drifted.length === 0) continue;
      const extra = sum(drifted.map((l) => l.price.minus(baseline).times(l.qty)));
      const latest = drifted[drifted.length - 1] as (typeof drifted)[number];
      const pct = latest.price.minus(baseline).div(baseline).times(100).toDecimalPlaces(0);
      total = total.plus(extra);
      count += drifted.length;
      sources.push(...sorted.map((l) => l.row.r.source));
      groups.push({
        label: `${latest.item} from ${latest.vendor}`,
        amount: toNumeric(extra),
        count: drifted.length,
        note: `Was ${dollars(baseline)}, now ${dollars(latest.price)} (+${pct.toFixed(0)}%)`,
      });
      for (const l of drifted) {
        examples.push(
          example(
            l.entity,
            l.row,
            l.price.minus(baseline).times(l.qty),
            l.vendor,
            `${l.item} at ${dollars(l.price)}, was ${dollars(baseline)}`,
          ),
        );
      }
    }
    if (groups.length === 0) return null;
    return finding(
      total,
      count,
      `${plural(groups.length, "item")} cost at least ${PRICE_DRIFT_PERCENT}% more than earlier in the year: ${dollars(total)} more paid on ${plural(count, "line")}.`,
      top(examples),
      groups,
      sources,
      b.currency,
    );
  },
};

/** The fixed set, in the order they are described. */
export const BOOKS_CHECKS: readonly BooksCheck[] = [
  unreconciled,
  uncategorized,
  duplicateVendors,
  duplicateBills,
  receivablesAging,
  payablesAging,
  negativeBalances,
  undepositedFunds,
  priceDrift,
];

/** Runs the checks over a snapshot: the findings, most dollars first, and the checks that were clean. */
export function checkBooks(snapshot: BooksSnapshot, opts: BooksHealthOptions): BooksHealthReport {
  if (!ISO.test(opts.asOf)) throw new RangeError(`asOf is not a day: ${opts.asOf}`);
  const books = readBooks(snapshot);
  const want = new Set(opts.checks ?? BOOKS_CHECK_IDS);
  const findings: BooksFinding[] = [];
  const clean: BooksCheckId[] = [];
  for (const c of BOOKS_CHECKS) {
    if (!want.has(c.id)) continue;
    const f = c.run(books, opts.asOf);
    if (f) findings.push({ check: c.id, title: c.title, area: c.area, pack: c.pack, ...f });
    else clean.push(c.id);
  }
  // DECISION: ranked by dollars, then by count, then in the set's order; a finding's dollars are
  // its own, so two findings may count the same money (an uncategorized bill that is also overdue).
  findings.sort(
    (x, y) =>
      dec(y.amount).comparedTo(dec(x.amount)) ||
      y.count - x.count ||
      BOOKS_CHECK_IDS.indexOf(x.check) - BOOKS_CHECK_IDS.indexOf(y.check),
  );
  const dates = [books.bills, books.purchases, books.invoices, books.payments]
    .flat()
    .map(({ v }) => day(v.TxnDate))
    .filter((x): x is string => x !== null)
    .sort();
  return {
    asOf: opts.asOf,
    currency: snapshot.currency,
    findings,
    clean,
    since: dates[0] ?? null,
    records: snapshot.records.length,
  };
}
