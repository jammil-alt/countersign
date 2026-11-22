// A fake QuickBooks company with known problems for books health (docs/plan.md §1.216), re-exported
// by @countersign/connectors/testing; never imported by the Worker. One of each problem the checks
// look for, dated back from the report's day so a sync's 90-day window holds them, with what the
// report must find in `expected`. Ids are in the 9000s so they never meet `fakeQbo`'s own fixtures.

import type { BooksCheckId } from "@countersign/core";

type Row = Record<string, unknown>;

export interface BooksCompanyExpected {
  check: BooksCheckId;
  amount: string;
  count: number;
  /** QuickBooks ids the finding must point at (among its examples). */
  examples: string[];
}

export interface BooksCompany {
  /** Rows by QuickBooks entity, as QuickBooks answers them. */
  rows: Record<"Account" | "Vendor" | "Bill" | "Purchase" | "Invoice" | "Payment", Row[]>;
  /** What a reconciliation tells us that QuickBooks' API doesn't: account id → reconciled through. */
  reconciledThrough: Record<string, string>;
  /** Every finding, most dollars first. */
  expected: BooksCompanyExpected[];
}

const ref = (value: string, name: string) => ({ value, name });

/** The company as of `asOf` (yyyy-mm-dd). */
export function fakeBooksCompany(asOf: string): BooksCompany {
  const d = (back: number) =>
    new Date(Date.parse(`${asOf}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  const CHECKING = ref("9035", "Checking");
  const CARD = ref("9041", "Business Card");
  const UF = ref("9004", "Undeposited Funds");
  const UNCAT = ref("9090", "Uncategorized Expense");
  const MATERIALS = ref("9060", "Materials");
  const OAK = ref("9301", "Oak 4/4");
  const REDWOOD = ref("9056", "Redwood Mill");
  const REDWOOD_INC = ref("9057", "Redwood Mill, Inc.");
  const FASTENERS = ref("9058", "Pacific Fasteners");
  const BAY = ref("9059", "Bay Lumber Co");
  const MARIN = ref("9601", "Marin Builders");
  const SAUSALITO = ref("9602", "Sausalito Homes");

  const account = (
    a: { value: string; name: string },
    AccountType: string,
    CurrentBalance: number,
    AccountSubType?: string,
  ) => ({
    Id: a.value,
    SyncToken: "0",
    Name: a.name,
    FullyQualifiedName: a.name,
    AccountType,
    ...(AccountSubType ? { AccountSubType } : {}),
    Active: true,
    CurrentBalance,
  });
  const vendor = (v: { value: string; name: string }) => ({
    Id: v.value,
    SyncToken: "0",
    DisplayName: v.name,
    Active: true,
  });
  const accountLine = (Amount: number, a: { value: string; name: string }) => ({
    Amount,
    DetailType: "AccountBasedExpenseLineDetail",
    AccountBasedExpenseLineDetail: { AccountRef: a },
  });
  const itemLine = (Qty: number, UnitPrice: number) => ({
    Amount: Number((Qty * UnitPrice).toFixed(2)),
    DetailType: "ItemBasedExpenseLineDetail",
    ItemBasedExpenseLineDetail: { ItemRef: OAK, Qty, UnitPrice },
  });
  const bill = (
    Id: string,
    v: { value: string; name: string },
    DocNumber: string,
    back: number,
    dueBack: number,
    TotalAmt: number,
    Balance: number,
    Line: Row[],
  ) => ({
    Id,
    SyncToken: "0",
    VendorRef: v,
    DocNumber,
    TxnDate: d(back),
    DueDate: d(dueBack),
    TotalAmt,
    Balance,
    CurrencyRef: { value: "USD" },
    Line,
  });
  const purchase = (
    Id: string,
    from: { value: string; name: string },
    back: number,
    TotalAmt: number,
    to: { value: string; name: string },
    payee: string,
  ) => ({
    Id,
    SyncToken: "0",
    PaymentType: from === CARD ? "CreditCard" : "Check",
    AccountRef: from,
    EntityRef: { value: "9700", name: payee },
    TxnDate: d(back),
    TotalAmt,
    CurrencyRef: { value: "USD" },
    Line: [accountLine(TotalAmt, to)],
  });
  const invoice = (
    Id: string,
    c: { value: string; name: string },
    back: number,
    dueBack: number,
    TotalAmt: number,
    Balance: number,
  ) => ({
    Id,
    SyncToken: "0",
    DocNumber: `INV-${Id}`,
    CustomerRef: c,
    TxnDate: d(back),
    DueDate: d(dueBack),
    TotalAmt,
    Balance,
    CurrencyRef: { value: "USD" },
    Line: [{ Amount: TotalAmt, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }],
  });
  const payment = (
    Id: string,
    c: { value: string; name: string },
    back: number,
    TotalAmt: number,
    to?: { value: string; name: string },
  ) => ({
    Id,
    SyncToken: "0",
    CustomerRef: c,
    TxnDate: d(back),
    TotalAmt,
    CurrencyRef: { value: "USD" },
    ...(to ? { DepositToAccountRef: to } : {}),
    Line: [],
  });

  return {
    rows: {
      Account: [
        account(CHECKING, "Bank", 12000, "Checking"),
        // A card with a credit on it: below zero.
        account(CARD, "Credit Card", -320, "CreditCard"),
        account(UF, "Other Current Asset", 1750, "UndepositedFunds"),
        account(UNCAT, "Expense", 1830, "OtherMiscellaneousServiceCost"),
        account(MATERIALS, "Cost of Goods Sold", 0, "SuppliesMaterialsCogs"),
        // Reconciled 20 days ago and quiet since: clean.
        account(ref("9070", "Savings"), "Bank", 5000, "Savings"),
      ],
      Vendor: [vendor(REDWOOD), vendor(REDWOOD_INC), vendor(FASTENERS), vendor(BAY)],
      Bill: [
        // Pacific Fasteners' PF-1001, entered twice a week apart.
        bill("9101", FASTENERS, "PF-1001", 49, 19, 875.5, 0, [accountLine(875.5, MATERIALS)]),
        bill("9102", FASTENERS, "PF-1001", 42, 12, 875.5, 875.5, [accountLine(875.5, MATERIALS)]),
        // Redwood Mill's oak: $24, $24, then $26.40 and $27; two of them unpaid and overdue.
        bill("9103", REDWOOD, "RM-77", 88, 78, 2400, 2400, [itemLine(100, 24)]),
        bill("9106", REDWOOD, "RM-79", 70, 60, 1200, 0, [itemLine(50, 24)]),
        bill("9104", REDWOOD, "RM-81", 50, 40, 2904, 2904, [itemLine(110, 26.4)]),
        bill("9105", REDWOOD, "RM-88", 19, -11, 1080, 1080, [itemLine(40, 27)]),
        // The same mill under a second name.
        bill("9107", REDWOOD_INC, "RM-90", 36, 6, 640, 0, [accountLine(640, MATERIALS)]),
        bill("9108", BAY, "BL-5", 31, 1, 1500, 0, [accountLine(1500, UNCAT)]),
      ],
      Purchase: [
        purchase("9201", CHECKING, 102, 100, MATERIALS, "Home Depot"),
        purchase("9202", CHECKING, 66, 400, MATERIALS, "Home Depot"),
        purchase("9203", CHECKING, 41, 250, UNCAT, "Amazon"),
        purchase("9204", CHECKING, 15, 1200, MATERIALS, "Home Depot"),
        purchase("9205", CARD, 19, 80, UNCAT, "Shell"),
      ],
      Invoice: [
        invoice("9401", MARIN, 140, 110, 6000, 6000),
        invoice("9402", SAUSALITO, 61, 31, 3000, 3000),
        invoice("9403", MARIN, 19, -11, 2000, 2000),
        invoice("9404", SAUSALITO, 142, 112, 3000, 0),
      ],
      Payment: [
        payment("9501", MARIN, 50, 3000, CHECKING),
        payment("9502", SAUSALITO, 18, 1000, UF),
        // No deposit account: QuickBooks puts it in Undeposited Funds.
        payment("9503", MARIN, 10, 750),
      ],
    },
    reconciledThrough: { "9035": d(81), "9070": d(20) },
    expected: [
      { check: "receivables_aging", amount: "9000.0000", count: 2, examples: ["9401", "9402"] },
      { check: "payables_aging", amount: "5304.0000", count: 2, examples: ["9103", "9104"] },
      {
        check: "unreconciled_accounts",
        amount: "4930.0000",
        count: 5,
        examples: ["9501", "9204", "9202", "9203", "9205"],
      },
      { check: "uncategorized", amount: "1830.0000", count: 3, examples: ["9108", "9203", "9205"] },
      { check: "undeposited_funds", amount: "1750.0000", count: 2, examples: ["9502", "9503"] },
      { check: "duplicate_bills", amount: "875.5000", count: 1, examples: ["9102"] },
      { check: "duplicate_vendors", amount: "640.0000", count: 1, examples: ["9057"] },
      { check: "price_drift", amount: "384.0000", count: 2, examples: ["9104", "9105"] },
      { check: "negative_balances", amount: "320.0000", count: 1, examples: ["9041"] },
    ],
  };
}
