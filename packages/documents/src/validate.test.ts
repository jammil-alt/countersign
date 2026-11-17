import type { InvoiceExtraction } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { lineArithmetic, validateTotals } from "./validate";

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
    expect(r).toEqual({
      ok: true,
      linesSum: "0.3000",
      problems: [],
      lineProblems: [],
      lineNotes: [],
    });
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

  it("notes a line whose quantity times unit price isn't its amount, and only such a line", () => {
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
    // 12.50 misread as 1.25, with the amount right: the totals add up, the line doesn't. The line
    // is noted; the document's totals still pass (no review for every client's invoice).
    const misread = full([
      { qty: "12", unitPrice: "1.25", extPrice: "150.00" },
      { qty: "3", unitPrice: "20.00", extPrice: "60.00" },
    ]);
    expect(misread).toMatchObject({ ok: true, problems: [], lineProblems: [1] });
    expect(misread.lineNotes).toEqual([
      "Line 1: 12 at 1.25 comes to 15.00, but its amount is 150.00.",
    ]);
    const fits = (l: Partial<InvoiceExtraction["lines"][number]>) =>
      full([l]).lineProblems.length === 0;
    // A unit price printed to the cent: 250 at 0.13 is 32.50, but 0.1275 was billed (31.88).
    expect(fits({ qty: "250", unitPrice: "0.13", extPrice: "31.88" })).toBe(true);
    // Rounding (the amount to the cent, the unit price to its printed places) passes; more doesn't.
    expect(fits({ qty: "3", unitPrice: "0.3333", extPrice: "1.00" })).toBe(true);
    expect(fits({ qty: "2", unitPrice: "10.00", extPrice: "20.02" })).toBe(true);
    expect(fits({ qty: "2", unitPrice: "10.00", extPrice: "20.05" })).toBe(false);
    // Credits: a negative quantity, or a positive quantity with a negative amount.
    expect(fits({ qty: "-2", unitPrice: "10.00", extPrice: "-20.00" })).toBe(true);
    expect(fits({ qty: "2", unitPrice: "10.00", extPrice: "-20.00" })).toBe(true);
    // A printed discount (paid what the amount says), and an amount-only fee read as 1 at 0.
    expect(fits({ qty: "10", unitPrice: "10.00", extPrice: "90.00", discount: "10.00" })).toBe(
      true,
    );
    expect(fits({ qty: "1", unitPrice: "0", extPrice: "45.00" })).toBe(true);
    // Priced per thousand (M) and per hundred (C).
    expect(fits({ qty: "1240", unitPrice: "1850.00", extPrice: "2294.00" })).toBe(true);
    expect(fits({ qty: "500", unitPrice: "12.50", extPrice: "62.50" })).toBe(true);
    // ...with the amount rounded to the cent: 733 BF at 1,855.00/M is 1,359.715; 50 at 12.55/C
    // is 6.275.
    expect(fits({ qty: "733", unitPrice: "1855.00", extPrice: "1359.72" })).toBe(true);
    expect(fits({ qty: "50", unitPrice: "12.55", extPrice: "6.28" })).toBe(true);
    expect(lineArithmetic({ qty: "733", unitPrice: "1855.00", extPrice: "1359.72" }).per).toBe(
      1000,
    );
    expect(lineArithmetic({ qty: "1240", unitPrice: "1850.00", extPrice: "2294.00" }).per).toBe(
      1000,
    );
    expect(lineArithmetic({ qty: "500", unitPrice: "12.50", extPrice: "62.50" }).per).toBe(100);
    // A quantity printed rounded: 2.5 sheets at 40.00 billed for 2.47 (98.80).
    expect(fits({ qty: "2.5", unitPrice: "40.00", extPrice: "98.80" })).toBe(true);
    // A line with no quantity (a note) isn't checked.
    expect(fits({ qty: "0", unitPrice: "0", extPrice: "5.00" })).toBe(true);
  });
});
