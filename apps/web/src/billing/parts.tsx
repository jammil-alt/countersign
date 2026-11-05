// Billing pieces shared by the back office and the portal (docs/plan.md §1.32): prices as words,
// the credit meter, a statement's lines, and statuses. Amounts are decimal strings, formatted
// without floats. They read in the reader's language (docs/plan.md §1.18); the back office reads
// English, as outside any provider.
import type { Money, StatementLine, StatementStatus } from "@countersign/core";
import { formatAmount } from "@countersign/core";
import type { ReactNode } from "react";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { richText } from "../i18n/rich";
import type { Tone } from "../ui/primitives";
import { count } from "../usage/format";

/** "1,250.00", "0.015": at least two places, up to four when a price has fractions of a cent. */
export function amountText(amount: string): string {
  const [whole = "0", frac = "0000"] = formatAmount(amount, 4).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let places = frac;
  while (places.length > 2 && places.endsWith("0")) places = places.slice(0, -1);
  return `${sign}${digits}.${places}`;
}

/** "$250.00", "$0.015", "-$15.00", or "250.00 EUR" (the back office's words). */
export function price(m: Money): string {
  if (m.currency !== "USD") return `${amountText(m.amount)} ${m.currency}`;
  const text = amountText(m.amount);
  return text.startsWith("-") ? `-$${text.slice(1)}` : `$${text}`;
}

/**
 * A price in the reader's locale, straight from its decimal string through Intl (up to 4 places):
 * "$0.015", "250,00 €". Never a float (invariant 6).
 */
export function localPrice(m: Money, i18n: I18n): string {
  return i18n.fmt.unitPrice(m.amount, m.currency);
}

/** An amount in whole cents, in the reader's locale: "$1,250.00", "1.250,00 €". */
export function localAmount(m: Money, i18n: I18n): string {
  return i18n.fmt.money(m.amount, m.currency);
}

/** Days in the month starting `start` (YYYY-MM-01), from integers only. */
export function daysIn(start: string): number {
  const [y, m] = start.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "1 credit", "1,234 credits" (the back office's words). */
export function credits(n: number): string {
  return `${count(n)} ${n === 1 ? "credit" : "credits"}`;
}

/** A statement's status: its words and tone (signal for "to pay", always with a word). */
export const STATEMENT_STATUS: Record<StatementStatus, { label: PlainKey; tone: Tone }> = {
  draft: { label: "billing.status.draft", tone: "neutral" },
  sent: { label: "billing.status.sent", tone: "warning" },
  paid: { label: "billing.status.paid", tone: "positive" },
  payment_failed: { label: "billing.status.payment_failed", tone: "risk" },
  void: { label: "billing.status.void", tone: "neutral" },
  nothing_due: { label: "billing.status.nothing_due", tone: "neutral" },
};

/**
 * Credits used against what is included: a bar on the data track, filled up to the included
 * credits; what goes past them is said in words, not shown in a colour.
 */
export function CreditMeter({
  used,
  allowance,
  testId,
}: {
  used: number;
  allowance: number;
  testId?: string;
}) {
  const { t, intl } = useI18n();
  // Whole percent from integers: no float reaches a figure the client reads.
  const pct =
    allowance > 0 ? Math.min(100, Math.floor((used * 100) / allowance)) : used > 0 ? 100 : 0;
  const extra = Math.max(0, used - allowance);
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> takes the browser's colours; this one is drawn with the data tokens. */}
      <div
        role="meter"
        aria-label={t("billing.meter.label")}
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-valuenow={Math.min(used, allowance)}
        aria-valuetext={t("billing.meter.valueText", {
          used: t("billing.credits", { count: used }),
          allowance: t("billing.credits", { count: allowance }),
        })}
        className="flex h-2 w-full overflow-hidden rounded-sm bg-data-track"
      >
        <span className="block h-full bg-data-bar" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-ink-muted">
        {richText(t("billing.meter.used", { used: "{used}", allowance: "{allowance}" }), {
          used: <span className="text-ink figures">{count(used, intl)}</span>,
          allowance: <span className="figures">{t("billing.credits", { count: allowance })}</span>,
        })}
        {extra > 0 ? (
          <>
            {" · "}
            {richText(t("billing.meter.over", { credits: "{credits}" }), {
              credits: (
                <span className="text-ink figures">{t("billing.credits", { count: extra })}</span>
              ),
            })}
          </>
        ) : null}
      </p>
    </div>
  );
}

/** What a month's credits came to, for the extra usage line. */
export interface CreditsSummary {
  creditsUsed: number;
  creditsIncluded: number;
  extraCredits: number;
  creditPrice: Money;
}

/** A line's own words: an agent's price and days, the extra credits, or the operator's words. */
function lineDetail(
  line: StatementLine,
  daysInMonth: number,
  summary: CreditsSummary,
  i18n: I18n,
): ReactNode {
  const { t } = i18n;
  if (line.kind === "agent") {
    const prices =
      line.prices.length === 1 && line.prices[0]
        ? t("billing.pricePerMonth", { price: localAmount(line.prices[0].monthlyPrice, i18n) })
        : line.prices
            .map((p) =>
              t("billing.priceForDays", {
                price: localAmount(p.monthlyPrice, i18n),
                count: p.days,
              }),
            )
            .join(", ");
    return `${prices} · ${t("billing.daysOf", { days: line.days ?? 0, total: daysInMonth })}`;
  }
  if (line.kind === "usage") {
    return t("billing.extraUsageDetail", {
      credits: t("billing.credits", { count: summary.extraCredits }),
      included: count(summary.creditsIncluded, i18n.intl),
      used: count(summary.creditsUsed, i18n.intl),
      price: localPrice(summary.creditPrice, i18n),
    });
  }
  return null;
}

/**
 * A statement's lines, or the month so far: one row per service with its price and days ("Included"
 * when free), the extra usage, any adjustments, then the total.
 */
export function StatementLines({
  lines,
  daysInMonth,
  summary,
  total,
  totalLabel,
  testId,
  action,
}: {
  lines: readonly StatementLine[];
  daysInMonth: number;
  summary: CreditsSummary;
  total: Money;
  totalLabel: string;
  testId: string;
  /** Something to put at the end of a line (the back office's Remove on an adjustment). */
  action?: (line: StatementLine) => ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  return (
    <div className="dt dt-ana overflow-x-auto">
      <table data-testid={testId}>
        <thead>
          <tr className="dt-cols">
            <th>{t("billing.column.item")}</th>
            <th className="n">{t("billing.column.amount")}</th>
            {action ? (
              <th>
                <span className="sr-only">{t("billing.column.links")}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const free = l.kind === "agent" && /^-?0+(\.0+)?$/.test(l.amount.amount);
            const detail = lineDetail(l, daysInMonth, summary, i18n);
            return (
              <tr
                key={l.id ?? `${l.kind}-${l.agentId ?? i}`}
                data-testid={`${testId}-${l.kind}-${i}`}
              >
                <td>
                  <span className="flex flex-col py-1">
                    <span className="text-ink">
                      {l.kind === "usage" ? t("billing.extraUsage") : l.description}
                    </span>
                    {detail ? <span className="text-sm text-ink-muted">{detail}</span> : null}
                  </span>
                </td>
                <td className="n text-ink">
                  {free ? t("billing.includedPrice") : localAmount(l.amount, i18n)}
                </td>
                {action ? <td>{action(l)}</td> : null}
              </tr>
            );
          })}
          <tr data-testid={`${testId}-total`}>
            <td className="font-medium text-ink">{totalLabel}</td>
            <td className="n font-medium text-ink">{localAmount(total, i18n)}</td>
            {action ? <td /> : null}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
