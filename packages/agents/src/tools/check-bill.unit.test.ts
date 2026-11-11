// Review (invariant 7): Check bill, the deterministic check between Prepare bill (AI) and the
// Create bill action. Code compares the model's bill with the invoice as read and the lists the
// process read, in decimals; any difference vetoes the write.

import { isToolWrapper, skillKind, toolLookup } from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  BillCheckIn,
  CHECK_BILL_SKILL,
  checkPreparedBill,
  DOCS_SPLIT_SKILLS,
  DOCS_SPLIT_TOOLS,
  docsBillCheck,
} from "./docs-split";

const invoice = {
  id: "ext-1",
  model: "docs.read-document",
  header: {
    vendorName: "Acme Lumber",
    invoiceNumber: "INV-100",
    invoiceDate: "2026-11-01",
    currency: "USD",
  },
  subtotal: "150.00",
  freight: "25.00",
  surcharges: [{ label: "Fuel surcharge", amount: "0" }],
  tax: "12.50",
  total: "187.50",
  totalsMatch: true,
  problems: [],
  lines: [
    { lineNo: 1, description: "2x4 stud", qty: "10", extPrice: "100.00", unitPrice: "10.00" },
    { lineNo: 2, description: "Nails", qty: "1", extPrice: "50.00", unitPrice: "50.00" },
  ],
};

const bill = {
  vendorId: "56",
  invoiceNumber: "INV-100",
  date: "2026-11-01",
  dueDate: "2026-12-01",
  lines: [
    { description: "2x4 stud", amount: "100.00", account: "80" },
    { description: "Nails", amount: "50", account: "80" },
    { description: "Freight", amount: "25.00", account: "81" },
    { description: "Sales tax", amount: "12.50", account: "82" },
  ],
  total: "187.50",
  currency: "USD",
  memo: "Invoice INV-100 from Acme Lumber",
  sources: ["doc-1", "ext-1"],
};

const vendors = [{ id: "56", name: "Acme Lumber" }];
const accounts = [{ id: "80" }, { id: "81" }, { id: "82" }];

const check = (over: Partial<typeof bill> = {}, lists = { vendors, accounts }) =>
  BillCheckIn.parse({ bill: { ...bill, ...over }, invoice, ...lists });

describe("Check bill", () => {
  it("passes a bill that is the invoice, on a vendor and accounts read", () => {
    expect(checkPreparedBill(check())).toEqual({
      ok: true,
      problems: [],
      linesSum: "187.50",
      invoiceTotal: "187.50",
      billTotal: "187.50",
      sources: ["doc-1", "ext-1"],
    });
  });

  it("vetoes a vendor that wasn't found", () => {
    const r = checkPreparedBill(check({ vendorId: "99" }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(["The vendor 99 is not one of the vendors found for the invoice."]);
  });

  it("vetoes an account that wasn't read", () => {
    const lines = bill.lines.map((l, i) => (i === 0 ? { ...l, account: "7" } : l));
    expect(checkPreparedBill(check({ lines })).problems).toEqual([
      "Accounts 7 are not among the accounts read.",
    ]);
  });

  it("vetoes a dropped line with the total lowered to match", () => {
    const r = checkPreparedBill(check({ lines: bill.lines.slice(1), total: "87.50" }));
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      "The bill's total 87.50 is not the invoice's total 187.50.",
      "The bill's 3 line amounts are not the invoice's 4 (its lines, freight, surcharges and tax).",
    ]);
  });

  it("vetoes lines that don't add up, and an amount moved between lines", () => {
    const moved = bill.lines.map((l, i) =>
      i === 0 ? { ...l, amount: "90.00" } : i === 1 ? { ...l, amount: "60.00" } : l,
    );
    expect(checkPreparedBill(check({ lines: moved })).problems).toEqual([
      "The bill's 4 line amounts are not the invoice's 4 (its lines, freight, surcharges and tax).",
    ]);
    const short = bill.lines.map((l, i) => (i === 0 ? { ...l, amount: "99.99" } : l));
    expect(checkPreparedBill(check({ lines: short })).problems).toEqual([
      "The bill's lines add up to 187.49, not 187.50.",
      "The bill's 4 line amounts are not the invoice's 4 (its lines, freight, surcharges and tax).",
    ]);
  });

  it("vetoes another number, date or currency than the invoice's", () => {
    expect(
      checkPreparedBill(check({ invoiceNumber: "INV-101", date: "2026-11-02", currency: "CAD" }))
        .problems,
    ).toEqual([
      "The bill's number INV-101 is not the invoice's INV-100.",
      "The bill's date 2026-11-02 is not the invoice's 2026-11-01.",
      "The bill is in CAD, the invoice in USD.",
    ]);
  });

  it("is a deterministic built-in that writes nothing, kept in the Library", () => {
    const def = DOCS_SPLIT_SKILLS.find((s) => s.id === CHECK_BILL_SKILL);
    expect(def).toBeDefined();
    if (!def) return;
    const lookup = toolLookup(DOCS_SPLIT_TOOLS.map((t) => t.spec));
    expect(skillKind(def, lookup)).toBe("deterministic");
    expect(isToolWrapper(def)).toBe(false);
    expect(docsBillCheck.spec.sideEffect).toBe("none");
  });
});
