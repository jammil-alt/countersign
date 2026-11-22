// Books health (docs/plan.md §1.216): the checks' own rules, one at a time. The whole set on a
// company with one of each problem is `packages/connectors/src/qbo/books-company.test.ts`.
import { describe, expect, it } from "vitest";
import { type BooksRecord, checkBooks, daysBetween, vendorKey } from "./checks";

const AS_OF = "2026-11-20";
let n = 0;
const rec = (entity: string, payload: Record<string, unknown>): BooksRecord => ({
  entity,
  externalId: String(payload.Id),
  source: `raw-${++n}`,
  payload,
});
const run = (records: BooksRecord[], check: Parameters<typeof checkBooks>[1]["checks"]) =>
  checkBooks({ currency: "USD", records }, { asOf: AS_OF, ...(check ? { checks: check } : {}) })
    .findings[0];

describe("books health checks", () => {
  it("compares vendor names without case, punctuation, a leading 'the' or a company suffix", () => {
    expect(vendorKey("The Redwood Mill, Inc.")).toBe("redwood mill");
    expect(vendorKey("Redwood Mill LLC")).toBe("redwood mill");
    expect(vendorKey("Smith & Sons Co")).toBe("smith and sons");
    // A name that is only a suffix keeps it.
    expect(vendorKey("Co")).toBe("co");
  });

  it("counts days between calendar days", () => {
    expect(daysBetween("2026-10-21", AS_OF)).toBe(30);
    expect(daysBetween(AS_OF, "2026-10-21")).toBe(-30);
  });

  it("takes two bills as one only on the same number, or with no number, within 3 days", () => {
    const bill = (Id: string, TxnDate: string, DocNumber?: string) =>
      rec("Bill", {
        Id,
        VendorRef: { value: "1", name: "Acme" },
        TxnDate,
        TotalAmt: 100,
        ...(DocNumber ? { DocNumber } : {}),
      });
    expect(
      run([bill("1", "2026-11-01", "A-1"), bill("2", "2026-11-15", "a-1 ")], ["duplicate_bills"])
        ?.count,
    ).toBe(1);
    expect(
      run([bill("1", "2026-11-01", "A-1"), bill("2", "2026-11-01", "A-2")], ["duplicate_bills"]),
    ).toBeUndefined();
    expect(
      run([bill("1", "2026-11-01"), bill("2", "2026-11-04")], ["duplicate_bills"])?.count,
    ).toBe(1);
    expect(
      run([bill("1", "2026-11-01"), bill("2", "2026-11-05")], ["duplicate_bills"]),
    ).toBeUndefined();
  });

  it("counts an invoice only once it is more than 30 days past due", () => {
    const inv = (Id: string, DueDate: string) =>
      rec("Invoice", { Id, TxnDate: "2026-09-01", DueDate, TotalAmt: 50, Balance: 50 });
    const f = run([inv("1", "2026-10-21"), inv("2", "2026-10-20")], ["receivables_aging"]);
    expect(f?.count).toBe(1);
    expect(f?.examples[0]?.externalId).toBe("2");
    expect(f?.amount).toBe("50.0000");
  });

  it("adds amounts as decimals, never as floats", () => {
    const f = run(
      [
        rec("Account", { Id: "9", Name: "Uncategorized Expense", AccountType: "Expense" }),
        ...["1", "2", "3"].map((Id) =>
          rec("Purchase", {
            Id,
            TxnDate: "2026-11-01",
            TotalAmt: 0.1,
            Line: [
              {
                Amount: 0.1,
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: { AccountRef: { value: "9" } },
              },
            ],
          }),
        ),
      ],
      ["uncategorized"],
    );
    expect(f?.amount).toBe("0.3000");
  });

  it("leaves waiting payments alone for their first week", () => {
    const records = [
      rec("Account", {
        Id: "4",
        Name: "Undeposited Funds",
        AccountType: "Other Current Asset",
        AccountSubType: "UndepositedFunds",
        CurrentBalance: 200,
      }),
      rec("Payment", { Id: "1", TxnDate: "2026-11-15", TotalAmt: 200 }),
    ];
    expect(run(records, ["undeposited_funds"])).toBeUndefined();
    const older = [
      ...records.slice(0, 1),
      rec("Payment", { Id: "1", TxnDate: "2026-11-10", TotalAmt: 200 }),
    ];
    expect(run(older, ["undeposited_funds"])?.amount).toBe("200.0000");
  });

  it("refuses a report day that isn't a day", () => {
    expect(() => checkBooks({ currency: "USD", records: [] }, { asOf: "today" })).toThrow();
  });
});
