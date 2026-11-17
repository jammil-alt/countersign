import type { InvoiceExtraction } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { validateTotals } from "./validate";

const line = (extPrice: string) => ({ extPrice }) as unknown as InvoiceExtraction["lines"][number];

function totals(
  lines: string[],
  subtotal: string,
  rest: Partial<Record<"freight" | "tax" | "total", string>> = {},
  surcharges: string[] = [],
) {
  return validateTotals({
    lines: lines.map(line),
    subtotal,
    freight: rest.freight ?? "0",
    tax: rest.tax ?? "0",
    surcharges: surcharges.map((amount) => ({ label: "s", amount })),
    total: rest.total ?? subtotal,
  });
}

describe("validateTotals", () => {
  it("passes exact totals and sums lines in decimals", () => {
    const r = totals(["0.10", "0.20"], "0.30");
    expect(r).toEqual({ ok: true, linesSum: "0.3000", problems: [], lineProblems: [] });
  });

  it("allows lines off by 2 cents on a small subtotal (the floor), not 3", () => {
    expect(totals(["2.00"], "2.02").ok).toBe(true);
    expect(totals(["2.00"], "2.03").ok).toBe(false);
  });

  it("allows 0.5% of a large subtotal, not a cent more", () => {
    // 0.5% of 10,000 = 50.00
    expect(totals(["9950.00"], "10000.00").ok).toBe(true);
    const r = totals(["9949.99"], "10000.00");
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain("off by 50.01");
  });

  it("checks subtotal + freight + surcharges + tax against the total within 2 cents", () => {
    const base = { freight: "185.00", tax: "0" };
    expect(totals(["5467.00"], "5467.00", { ...base, total: "5843.35" }, ["191.35"]).ok).toBe(true);
    expect(totals(["5467.00"], "5467.00", { ...base, total: "5843.37" }, ["191.35"]).ok).toBe(true);
    const r = totals(["5467.00"], "5467.00", { ...base, total: "5843.38" }, ["191.35"]);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
  });

  it("handles credits (negative amounts)", () => {
    expect(totals(["-50.00", "-25.00"], "-75.00").ok).toBe(true);
  });

  it("checks each line's quantity times unit price against its amount, to the cent", () => {
    const full = (lines: Partial<InvoiceExtraction["lines"][number]>[]) => {
      const ls = lines.map(
        (l, i) =>
          ({
            lineNo: i + 1,
            qty: "1",
            unitPrice: "0",
            discount: null,
            ...l,
          }) as InvoiceExtraction["lines"][number],
      );
      const sum = ls.reduce((s, l) => s + Number(l.extPrice), 0).toFixed(2);
      return validateTotals({
        lines: ls,
        subtotal: sum,
        freight: "0",
        tax: "0",
        surcharges: [],
        total: sum,
      });
    };
    // 12.50 misread as 1.25, with the amount right: the totals add up, the line doesn't.
    const misread = full([
      { qty: "12", unitPrice: "1.25", extPrice: "150.00" },
      { qty: "3", unitPrice: "20.00", extPrice: "60.00" },
    ]);
    expect(misread.ok).toBe(false);
    expect(misread.problems).toEqual([
      "Line 1: 12 at 1.25 comes to 15.00, but its amount is 150.00.",
    ]);
    expect(misread.lineProblems).toEqual([1]);
    // A unit price printed to the cent: 250 at 0.13 is 32.50, but 0.1275 was billed (31.88).
    expect(full([{ qty: "250", unitPrice: "0.13", extPrice: "31.88" }]).ok).toBe(true);
    // Rounding (the amount to the cent, the unit price to its printed places) passes; more doesn't.
    expect(full([{ qty: "3", unitPrice: "0.3333", extPrice: "1.00" }]).ok).toBe(true);
    expect(full([{ qty: "2", unitPrice: "10.00", extPrice: "20.02" }]).ok).toBe(true);
    expect(full([{ qty: "2", unitPrice: "10.00", extPrice: "20.05" }]).ok).toBe(false);
    // Credits, and lines with a printed discount (paid what the amount says), pass.
    expect(full([{ qty: "-2", unitPrice: "10.00", extPrice: "-20.00" }]).ok).toBe(true);
    expect(full([{ qty: "10", unitPrice: "10.00", extPrice: "90.00", discount: "10.00" }]).ok).toBe(
      true,
    );
    // A line with no quantity (a note) isn't checked.
    expect(full([{ qty: "0", unitPrice: "0", extPrice: "5.00" }]).ok).toBe(true);
  });
});
