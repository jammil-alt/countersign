// Totals validation (ARCHITECTURE §7). Two checks, both in decimals (invariant 6):
//   lines:  |Σ lines.ext_price − subtotal| ≤ max(0.02, 0.5% of |subtotal|)
//   total:  |subtotal + freight + Σ surcharges + tax − total| ≤ 0.02
// A failure sends the document to review.

import { Decimal, dec, type InvoiceExtraction, toNumeric } from "@countersign/core";

export interface TotalsCheck {
  ok: boolean;
  /** Σ lines.extPrice, numeric(14,4). */
  linesSum: string;
  problems: string[];
}

// DECISION: the second check ("≈ total", ARCHITECTURE §7 gives no number) uses the same 2-cent
// floor as the first, without the percentage: the total is a sum of printed figures, so only
// rounding separates it from them.
export const LINES_TOLERANCE_FLOOR = "0.02";
export const LINES_TOLERANCE_SHARE = "0.005";
export const TOTAL_TOLERANCE = "0.02";

type Totals = Pick<
  InvoiceExtraction,
  "lines" | "subtotal" | "freight" | "surcharges" | "tax" | "total"
>;

/** 2 places with thousands separators: "5,843.35". */
const fmt = (d: Decimal) => {
  const [whole = "0", frac = "00"] = d.toDecimalPlaces(2).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac}`;
};

export function validateTotals(x: Totals): TotalsCheck {
  const problems: string[] = [];
  const linesSum = x.lines.reduce((s, l) => s.plus(dec(l.extPrice)), new Decimal(0));
  const subtotal = dec(x.subtotal);
  const tolerance = Decimal.max(
    dec(LINES_TOLERANCE_FLOOR),
    subtotal.abs().times(LINES_TOLERANCE_SHARE),
  );
  const linesGap = linesSum.minus(subtotal).abs();
  if (linesGap.greaterThan(tolerance)) {
    problems.push(
      `The lines add up to ${fmt(linesSum)}, but the subtotal is ${fmt(subtotal)} (off by ${fmt(linesGap)}).`,
    );
  }
  const surcharges = x.surcharges.reduce((s, c) => s.plus(dec(c.amount)), new Decimal(0));
  const computed = subtotal.plus(dec(x.freight)).plus(surcharges).plus(dec(x.tax));
  const totalGap = computed.minus(dec(x.total)).abs();
  if (totalGap.greaterThan(dec(TOTAL_TOLERANCE))) {
    problems.push(
      `Subtotal, freight, surcharges and tax come to ${fmt(computed)}, but the total is ${fmt(dec(x.total))}.`,
    );
  }
  return { ok: problems.length === 0, linesSum: toNumeric(linesSum), problems };
}
