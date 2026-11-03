import DecimalJs from "decimal.js";
import { z } from "zod";

/**
 * Money is decimal (CLAUDE.md invariant 6): `numeric(14,4)` + currency in Postgres, strings on the
 * wire, decimal.js in code. JS numbers are refused as inputs so a float can't slip in.
 */
export const Decimal = DecimalJs.clone({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = string | Decimal;

/** At most 10 integer digits and 4 decimals: what `numeric(14,4)` holds. */
export const DECIMAL_RE = /^-?\d{1,10}(\.\d{1,4})?$/;
export const DecimalString = z.string().regex(DECIMAL_RE, "a decimal with at most 4 places");
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code");

export const MoneySchema = z.object({ amount: DecimalString, currency: CurrencyCode });
export type Money = z.infer<typeof MoneySchema>;

export function dec(value: DecimalInput): Decimal {
  if (typeof value !== "string" && !(value instanceof Decimal) && !DecimalJs.isDecimal(value)) {
    throw new TypeError("money values must be strings or Decimals, never JS numbers");
  }
  const d = new Decimal(value);
  if (!d.isFinite()) throw new RangeError(`not a finite decimal: ${String(value)}`);
  return d;
}

/** The `numeric(14,4)` string for a value, rounded half up. */
export function toNumeric(value: DecimalInput): string {
  return dec(value).toDecimalPlaces(4).toFixed(4);
}

export function money(amount: DecimalInput, currency: string): Money {
  return MoneySchema.parse({ amount: toNumeric(amount), currency });
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(dec(a.amount).plus(b.amount), a.currency);
}

export function subMoney(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(dec(a.amount).minus(b.amount), a.currency);
}

export function mulMoney(a: Money, factor: DecimalInput): Money {
  return money(dec(a.amount).times(dec(factor)), a.currency);
}

export function sumMoney(items: readonly Money[], currency: string): Money {
  let total = new Decimal(0);
  for (const m of items) {
    if (m.currency !== currency) throw new Error(`currency mismatch: ${m.currency} vs ${currency}`);
    total = total.plus(m.amount);
  }
  return money(total, currency);
}

/** -1, 0 or 1. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return dec(a.amount).comparedTo(b.amount) as -1 | 0 | 1;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && dec(a.amount).equals(b.amount);
}

/** |a - b| <= tolerance, all decimals. */
export function withinTolerance(
  a: DecimalInput,
  b: DecimalInput,
  tolerance: DecimalInput,
): boolean {
  return dec(a).minus(dec(b)).abs().lessThanOrEqualTo(dec(tolerance));
}

/** Percent change from `before` to `after` (e.g. "12.5" for +12.5%), or null when before is 0. */
export function percentChange(before: DecimalInput, after: DecimalInput): Decimal | null {
  const b = dec(before);
  if (b.isZero()) return null;
  return dec(after).minus(b).dividedBy(b.abs()).times(100);
}

/** Display string with 2 decimals (half up), e.g. "1234.50". */
export function formatAmount(value: DecimalInput, places = 2): string {
  return dec(value).toDecimalPlaces(places).toFixed(places);
}
