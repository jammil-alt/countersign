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
    expect(r).toEqual({ ok: true, linesSum: "0.3000", problems: [] });
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
});
