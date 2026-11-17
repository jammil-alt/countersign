// Totals validation (ARCHITECTURE §7). Three checks, all in decimals (invariant 6):
//   each line: |qty × unit_price − ext_price| ≤ 0.01 + |qty| × half the unit price's last place
//   lines:     |Σ lines.ext_price − subtotal| ≤ max(0.02, 0.5% of |subtotal|)
//   total:     |subtotal + freight + Σ surcharges + tax − total| ≤ 0.02
// A failure sends the document to review (a person checks it before its prices are recorded).

import { Decimal, dec, type InvoiceExtraction, toNumeric } from "@countersign/core";

export interface TotalsCheck {
  ok: boolean;
  /** Σ lines.extPrice, numeric(14,4). */
  linesSum: string;
  problems: string[];
  /** The lines (1-based, printed order) whose quantity times unit price isn't their amount. */
  lineProblems: number[];
}

// DECISION: the second check ("≈ total", ARCHITECTURE §7 gives no number) uses the same 2-cent
// floor as the first, without the percentage: the total is a sum of printed figures, so only
// rounding separates it from them.
export const LINES_TOLERANCE_FLOOR = "0.02";
export const LINES_TOLERANCE_SHARE = "0.005";
export const TOTAL_TOLERANCE = "0.02";
/** A line's amount against its quantity times its unit price: a cent, plus the price's rounding. */
export const LINE_TOLERANCE = "0.01";

type Totals = Pick<
  InvoiceExtraction,
  "lines" | "subtotal" | "freight" | "surcharges" | "tax" | "total"
>;

/** 2 places with thousands separators: "5,843.35". */
const fmt = (d: Decimal) => {
  const [whole = "0", frac = "00"] = d.toDecimalPlaces(2).toFixed(2).split(".");
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac}`;
};

/**
 * A line's own arithmetic: its quantity times its unit price against its amount. A unit price
 * misread (1.25 for 12.50) with the amount read right leaves the totals adding up, so only this
 * finds it, before the wrong price reaches the price history.
 */
// DECISION (audit 7.9): the allowance is a cent for the amount's rounding, plus the unit price's
// own rounding to its printed places (at least two) times the quantity: 250 at a printed 0.13 may
// be 31.88 (0.1275 billed). A line with a printed discount is paid at its amount and isn't checked
// here (how a discount is printed varies); nor is a line with no quantity (a note).
function lineProblem(line: Totals["lines"][number], no: number): string | null {
  if (typeof line.qty !== "string" || typeof line.unitPrice !== "string") return null;
  if (line.discount !== null && line.discount !== undefined && !dec(line.discount).isZero()) {
    return null;
  }
  const qty = dec(line.qty);
  if (qty.isZero()) return null;
  const unitPrice = dec(line.unitPrice);
  const amount = dec(line.extPrice);
  const computed = qty.times(unitPrice);
  const places = Math.max(2, unitPrice.decimalPlaces());
  const allowance = dec(LINE_TOLERANCE).plus(
    qty.abs().times(dec("0.5").times(dec(`1e-${places}`))),
  );
  if (computed.minus(amount).abs().lessThanOrEqualTo(allowance)) return null;
  return `Line ${no}: ${qty.toString()} at ${unitPrice.toString()} comes to ${fmt(computed)}, but its amount is ${fmt(amount)}.`;
}

export function validateTotals(x: Totals): TotalsCheck {
  const problems: string[] = [];
  const lineProblems: number[] = [];
  x.lines.forEach((l, i) => {
    const problem = lineProblem(l, i + 1);
    if (problem) {
      problems.push(problem);
      lineProblems.push(i + 1);
    }
  });
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
  return { ok: problems.length === 0, linesSum: toNumeric(linesSum), problems, lineProblems };
}
