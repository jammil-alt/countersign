// Books health (docs/plan.md §1.216): the checks library finds every problem the fake company was
// seeded with, with its dollars, count and examples, most dollars first.

import { BOOKS_CHECK_IDS, BooksHealthReport, checkBooks } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { fakeBooksCompany } from "./books-company";

const AS_OF = "2026-11-20";

function snapshot(asOf = AS_OF, withReconciled = true) {
  const c = fakeBooksCompany(asOf);
  const records = Object.entries(c.rows).flatMap(([entity, list]) =>
    list.map((p) => ({
      entity,
      externalId: String(p.Id),
      source: `raw-${entity}-${String(p.Id)}`,
      payload: p,
    })),
  );
  return {
    company: c,
    snapshot: {
      currency: "USD",
      records,
      ...(withReconciled ? { reconciledThrough: c.reconciledThrough } : {}),
    },
  };
}

describe("books health on a company with known problems", () => {
  it("finds every one, ranked by dollars, with its count and examples", () => {
    const { company, snapshot: s } = snapshot();
    const report = BooksHealthReport.parse(checkBooks(s, { asOf: AS_OF }));
    expect(report.findings.map((f) => f.check)).toEqual(company.expected.map((e) => e.check));
    expect(report.clean).toEqual([]);
    for (const e of company.expected) {
      const f = report.findings.find((x) => x.check === e.check);
      expect(f, e.check).toBeDefined();
      expect({ check: f?.check, amount: f?.amount, count: f?.count }).toEqual({
        check: e.check,
        amount: e.amount,
        count: e.count,
      });
      expect(f?.examples.map((x) => x.externalId).sort()).toEqual(
        expect.arrayContaining(e.examples),
      );
      // Evidence: every example's record is among the finding's sources.
      for (const x of f?.examples ?? []) expect(f?.sources).toContain(x.source);
    }
    expect(report.since).toBe("2026-07-01");
    expect(report.records).toBe(s.records.length);
  });

  it("names the area and the pack that fixes each finding, as data", () => {
    const { snapshot: s } = snapshot();
    const report = checkBooks(s, { asOf: AS_OF });
    const by = Object.fromEntries(report.findings.map((f) => [f.check, [f.area, f.pack]]));
    expect(by).toEqual({
      unreconciled_accounts: ["bookkeeping", "bookkeeping"],
      uncategorized: ["bookkeeping", "bookkeeping"],
      negative_balances: ["bookkeeping", "bookkeeping"],
      undeposited_funds: ["bookkeeping", "bookkeeping"],
      duplicate_vendors: ["purchasing", "materials"],
      duplicate_bills: ["purchasing", "materials"],
      payables_aging: ["purchasing", "materials"],
      price_drift: ["purchasing", "materials"],
      receivables_aging: ["receivables", null],
    });
  });

  it("puts the overdue in buckets, and each account's age in words", () => {
    const { snapshot: s } = snapshot();
    const report = checkBooks(s, { asOf: AS_OF });
    const ar = report.findings.find((f) => f.check === "receivables_aging");
    expect(ar?.groups).toEqual([
      { label: "31–60 days past due", amount: "3000.0000", count: 1, note: null },
      { label: "Over 90 days past due", amount: "6000.0000", count: 1, note: null },
    ]);
    const un = report.findings.find((f) => f.check === "unreconciled_accounts");
    expect(un?.groups.map((g) => [g.label, g.amount, g.count, g.note])).toEqual([
      ["Checking", "4850.0000", 4, "Last reconciled through 2026-08-31, 81 days ago"],
      ["Business Card", "80.0000", 1, "Never reconciled with us; activity from 2026-11-01"],
    ]);
    const drift = report.findings.find((f) => f.check === "price_drift");
    expect(drift?.groups[0]).toMatchObject({
      label: "Oak 4/4 from Redwood Mill",
      note: "Was $24, now $27 (+13%)",
    });
    expect(report.findings[0]?.summary).toBe("$9,000 on 2 invoices is more than 30 days past due.");
  });

  it("counts every account as unreconciled when we know of no reconciliation", () => {
    const { snapshot: s } = snapshot(AS_OF, false);
    const un = checkBooks(s, { asOf: AS_OF }).findings.find(
      (f) => f.check === "unreconciled_accounts",
    );
    // The checking account's purchase before the old reconciliation now counts too.
    expect(un?.amount).toBe("5030.0000");
    expect(un?.count).toBe(6);
  });

  it("runs only the checks asked for, and finds nothing in a clean company", () => {
    const { snapshot: s } = snapshot();
    const some = checkBooks(s, { asOf: AS_OF, checks: ["duplicate_bills", "price_drift"] });
    expect(some.findings.map((f) => f.check)).toEqual(["duplicate_bills", "price_drift"]);
    const empty = checkBooks({ currency: "USD", records: [] }, { asOf: AS_OF });
    expect(empty.findings).toEqual([]);
    expect(empty.clean).toEqual([...BOOKS_CHECK_IDS]);
    expect(empty.since).toBeNull();
  });

  it("leaves out a record that doesn't parse rather than failing the report", () => {
    const { snapshot: s } = snapshot();
    const report = checkBooks(
      {
        ...s,
        records: [...s.records, { entity: "Bill", externalId: "x", source: "raw-x", payload: 7 }],
      },
      { asOf: AS_OF },
    );
    expect(report.findings).toHaveLength(9);
  });
});
