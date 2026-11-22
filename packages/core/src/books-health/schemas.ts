// Books health (docs/plan.md §1.216): what a check finds in a client's QuickBooks, as data. A
// finding carries a dollar figure, a count, a few example transactions and the synced records it
// rests on (`sources`, raw record ids: invariant 10). The area and pack that address it are named
// as data, never imported: the platform never imports a pack.

import { z } from "zod";
import { CurrencyCode, DecimalString } from "../money";
import { OwnerArea } from "../owners/areas";

export const BOOKS_CHECK_IDS = [
  "unreconciled_accounts",
  "uncategorized",
  "duplicate_vendors",
  "duplicate_bills",
  "receivables_aging",
  "payables_aging",
  "negative_balances",
  "undeposited_funds",
  "price_drift",
] as const;
export const BooksCheckId = z.enum(BOOKS_CHECK_IDS);
export type BooksCheckId = z.infer<typeof BooksCheckId>;

/** One transaction (or account, or vendor) a finding points at. */
export const BooksExample = z.object({
  /** The QuickBooks entity: Bill, Purchase, Invoice, Payment, Account, Vendor. */
  entity: z.string(),
  /** Its QuickBooks id. */
  externalId: z.string(),
  /** The synced record it was read from. */
  source: z.string(),
  date: z.string().nullable(),
  /** Who or what: the vendor, customer or account. */
  name: z.string().nullable(),
  /** Its reference (a bill or invoice number), when it has one. */
  ref: z.string().nullable(),
  amount: DecimalString,
  /** Why it is here, in words ("Uncategorized Expense", "63 days past due"). */
  note: z.string().nullable(),
});
export type BooksExample = z.infer<typeof BooksExample>;

/** A part of a finding: an account, an aging bucket, a group of vendors. */
export const BooksGroup = z.object({
  label: z.string(),
  amount: DecimalString,
  count: z.number().int().nonnegative(),
  note: z.string().nullable(),
});
export type BooksGroup = z.infer<typeof BooksGroup>;

export const BooksFinding = z.object({
  check: BooksCheckId,
  title: z.string(),
  /** One plain sentence: the result and its number. */
  summary: z.string(),
  amount: DecimalString,
  currency: CurrencyCode,
  count: z.number().int().nonnegative(),
  examples: z.array(BooksExample),
  groups: z.array(BooksGroup),
  /** Raw record ids of every record the finding rests on. */
  sources: z.array(z.string()).min(1),
  /** The business area whose work fixes it, and its pack (null: the area has no pack yet). */
  area: OwnerArea,
  pack: z.string().nullable(),
});
export type BooksFinding = z.infer<typeof BooksFinding>;

export const BooksHealthReport = z.object({
  asOf: z.string(),
  currency: CurrencyCode,
  /** Findings, most dollars first. */
  findings: z.array(BooksFinding),
  /** Checks that ran and found nothing. */
  clean: z.array(BooksCheckId),
  /**
   * The earliest transaction date among the records read: a check sees only what was synced (an
   * initial sync reads 90 days of bills and purchases, a year of invoices and payments).
   */
  since: z.string().nullable(),
  /** How many synced records were read. */
  records: z.number().int().nonnegative(),
});
export type BooksHealthReport = z.infer<typeof BooksHealthReport>;
