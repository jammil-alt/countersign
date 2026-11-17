// Totals validation (ARCHITECTURE §7). Two checks, both in decimals (invariant 6):
//   lines:  |Σ lines.ext_price − subtotal| ≤ max(0.02, 0.5% of |subtotal|)
//   total:  |subtotal + freight + Σ surcharges + tax − total| ≤ 0.02
// A failure sends the document to review. Each line's own arithmetic (its quantity times its unit
// price against its amount, `lineArithmetic`) is checked as well: a line that doesn't add up is
// noted, never a reason to send the whole document to review, and is kept out of price history.

import { Decimal, dec, type InvoiceExtraction, toNumeric } from "@countersign/core";

export interface TotalsCheck {
  ok: boolean;
  /** Σ lines.extPrice, numeric(14,4). */
  linesSum: string;
  /** The totals that don't add up (what sends the document to review). */
  problems: string[];
  /** The lines (1-based, printed order) whose quantity times unit price isn't their amount. */
  lineProblems: number[];
  /** Those lines, in words: noted on the reading, not a failure of its totals. */
  lineNotes: string[];
}

// DECISION: the second check ("≈ total", ARCHITECTURE §7 gives no number) uses the same 2-cent
// floor as the first, without the percentage: the total is a sum of printed figures, so only
// rounding separates it from them.
export const LINES_TOLERANCE_FLOOR = "0.02";
export const LINES_TOLERANCE_SHARE = "0.005";
export const TOTAL_TOLERANCE = "0.02";
/** A line's amount against its quantity times its unit price: a cent, plus the printed rounding. */
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

/** A line as its arithmetic is checked: what a reading or a stored document line has. */
export interface LineFigures {
  qty: string;
  unitPrice: string;
  extPrice: string;
  discount?: string | null | undefined;
}

/**
 * A line's own arithmetic: its quantity times its unit price against its amount. `per` is how many
 * units the printed unit price is for: 1, or 100 or 1000 for a price per hundred (C) or per
 * thousand (M), as lumber and fastener invoices print them (1,240 BF at 1,850.00/M is 2,294.00).
 * `problem` says, in words, why the line doesn't add up; null when it does or isn't checked.
 */
// DECISION (audit 7.9; review of fix/materials, finding 4): a line is checked only when it can be.
// Not checked: a unit price of 0 (an amount-only fee or a note read as 1 at 0), a quantity of 0, a
// printed discount (the amount is net of it, however the discount is printed). Signs aside: a
// credit may print a positive quantity and a negative amount. The allowance is a cent for the
// amount's rounding, plus the unit price's rounding to its printed places (at least two) times the
// quantity, plus, when the quantity has decimals, its own rounding times the price.
export function lineArithmetic(line: LineFigures): { per: 1 | 100 | 1000; problem: string | null } {
  const fits = { per: 1 as const, problem: null };
  if (typeof line.qty !== "string" || typeof line.unitPrice !== "string") return fits;
  if (line.discount !== null && line.discount !== undefined && !dec(line.discount).isZero()) {
    return fits;
  }
  const qty = dec(line.qty);
  const unitPrice = dec(line.unitPrice);
  if (qty.isZero() || unitPrice.isZero()) return fits;
  const amount = dec(line.extPrice).abs();
  const computed = qty.abs().times(unitPrice.abs());
  const half = (places: number) => dec("0.5").times(dec(`1e-${places}`));
  // The printed figures' rounding scales with the price (per hundred or thousand); the cent the
  // amount is rounded to doesn't.
  const rounding = qty
    .abs()
    .times(half(Math.max(2, unitPrice.decimalPlaces())))
    .plus(qty.decimalPlaces() > 0 ? unitPrice.abs().times(half(qty.decimalPlaces())) : dec("0"));
  for (const per of [1, 100, 1000] as const) {
    // DECISION (third review of fix/materials, finding 5): a price per hundred or thousand is read
    // only from an amount that isn't zero (2 at 4.50 for 0.00 is no price per thousand), and its
    // amount rounds to the half cent, not the whole one.
    if (per !== 1 && amount.isZero()) break;
    const allowance = dec(per === 1 ? LINE_TOLERANCE : "0.005").plus(rounding.dividedBy(per));
    if (computed.dividedBy(per).minus(amount).abs().lessThanOrEqualTo(allowance)) {
      return { per, problem: null };
    }
  }
  return {
    per: 1,
    problem: `${qty.toString()} at ${unitPrice.toString()} comes to ${fmt(computed)}, but its amount is ${fmt(amount)}`,
  };
}

export function validateTotals(x: Totals): TotalsCheck {
  const problems: string[] = [];
  const lineProblems: number[] = [];
  const lineNotes: string[] = [];
  x.lines.forEach((l, i) => {
    const { problem } = lineArithmetic(l);
    if (problem) {
      lineProblems.push(i + 1);
      lineNotes.push(`Line ${i + 1}: ${problem}.`);
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
  return {
    ok: problems.length === 0,
    linesSum: toNumeric(linesSum),
    problems,
    lineProblems,
    lineNotes,
  };
}
