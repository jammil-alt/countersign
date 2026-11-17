// Money as the pack words and adds it: an amount in its currency, and what alerts put at stake per
// currency (never added across currencies). No import of the rules or the contract check, so both
// can use it.

import { type Decimal, dec, formatAmount, toNumeric } from "@countersign/core";

/** An amount in its currency: `$12.50` in US dollars, `CAD 12.50` in any other. */
export const moneyIn = (v: Decimal | string, currency: string): string =>
  currency === "USD" ? `$${formatAmount(v)}` : `${currency} ${formatAmount(v)}`;

/** The currency an alert's money is in: the alert's own (`alert.currency`), else its facts'. */
export const alertCurrency = (a: { facts: unknown; currency?: string | null }): string => {
  if (a.currency) return a.currency;
  const c = (a.facts as Record<string, unknown> | null)?.currency;
  return typeof c === "string" ? c : "USD";
};

/**
 * What alerts put at stake, per currency (never added across currencies): money to claim back, so
 * a saving (a negative impact, §1.104) doesn't net it out. `dollarImpact` is in `currency`, the one
 * most of the alerts are in (US dollars on a tie).
 */
export function atStakeOf(
  alerts: readonly { dollarImpact: string | null; facts: unknown; currency?: string | null }[],
): {
  dollarImpact: string;
  currency: string;
  atStake: { currency: string; amount: string }[];
} {
  const sums = new Map<string, { amount: Decimal; alerts: number }>();
  for (const a of alerts) {
    const cur = alertCurrency(a);
    const s = sums.get(cur) ?? { amount: dec("0"), alerts: 0 };
    const d = dec(a.dollarImpact ?? "0");
    sums.set(cur, { amount: d.greaterThan(0) ? s.amount.plus(d) : s.amount, alerts: s.alerts + 1 });
  }
  const ranked = [...sums.entries()].sort(
    (a, b) =>
      b[1].alerts - a[1].alerts ||
      Number(b[0] === "USD") - Number(a[0] === "USD") ||
      a[0].localeCompare(b[0]),
  );
  const currency = ranked[0]?.[0] ?? "USD";
  return {
    dollarImpact: toNumeric(sums.get(currency)?.amount ?? dec("0")),
    currency,
    atStake: ranked.map(([c, s]) => ({ currency: c, amount: toNumeric(s.amount) })),
  };
}
