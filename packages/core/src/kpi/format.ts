// A KPI's value in words for the client (docs/plan.md §1.50): counts as whole numbers, money with
// its currency, ratios as a percentage, in the reader's language. Values stay decimal strings end
// to end (invariant 6): Intl formats the string itself, never a JS float of it.

import type { Locale } from "../i18n/locale";
import { Decimal } from "../money";
import type { KpiFormat } from "./schema";

/** The currency a money KPI is shown in when its rows name none. */
// DECISION: a client has no currency setting; money KPIs whose step outputs name no currency
// beside the amount are shown in USD, as billing is.
export const KPI_DEFAULT_CURRENCY = "USD";

/**
 * Intl.NumberFormat formats a decimal string exactly (Intl.NumberFormat v3, in every runtime we
 * use); the ES2022 types only declare numbers, hence the cast.
 */
const exact = (value: string) => value as unknown as number;

export function formatKpi(
  value: string | null,
  format: KpiFormat,
  locale: Locale,
  currency: string = KPI_DEFAULT_CURRENCY,
): string | null {
  if (value === null) return null;
  const d = new Decimal(value);
  if (!d.isFinite()) return null;
  switch (format) {
    case "count":
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(exact(d.toFixed()));
    case "money":
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
        exact(d.toFixed()),
      );
    case "percent":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
        exact(d.toFixed()),
      );
  }
}
