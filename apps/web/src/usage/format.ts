// Words, numbers and periods for the usage and report screens (plan §1.15).
import { dec, formatAmount } from "@countersign/core";

/**
 * Model cost (operator only) from its decimal string, never a float: "$12.40", and under a cent
 * "$0.0003", so small runs don't read as free.
 */
export function cost(amount: string): string {
  const d = dec(amount);
  if (d.isZero()) return "$0.00";
  return d.abs().lt("0.01") ? `$${formatAmount(amount, 4)}` : `$${formatAmount(amount, 2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 2026" for "2026-11". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** "Nov 3, 2026" for "2026-11-03". */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`;
}

/** "Nov 1 – Nov 3, 2026", or one day. */
export function periodLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const start = sameYear ? dayLabel(from).replace(/, \d{4}$/, "") : dayLabel(from);
  return `${start} – ${dayLabel(to)}`;
}

/** Whole counts with thousands separators: "12,345". */
export function count(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** "1 run", "3 runs". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** `YYYY-MM-DD` of a date in UTC. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The first day of the month `back` months before `day`'s month (`YYYY-MM-DD`). */
export function monthStart(day: string, back = 0): string {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return isoDay(d);
}

/** The last day of `day`'s month. */
export function monthEnd(day: string): string {
  const d = new Date(`${monthStart(day, -1)}T00:00:00.000Z`);
  d.setUTCDate(0);
  return isoDay(d);
}
