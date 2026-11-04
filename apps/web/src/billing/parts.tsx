// Billing pieces shared by the back office and the portal (docs/plan.md §1.24): prices as words,
// the credit meter, and Stripe's invoices with their hosted page and PDF. Amounts are decimal
// strings, formatted without floats. The meter and the invoices read in the reader's language
// (docs/plan.md §1.18); the back office reads English, as outside any provider.
import type { BillingInvoice, Money } from "@countersign/core";
import { formatAmount } from "@countersign/core";
import type { PlainKey } from "../i18n/catalog";
import { type I18n, useI18n } from "../i18n/i18n";
import { richText } from "../i18n/rich";
import { Badge, type Tone } from "../ui/primitives";
import { count, dayLabel } from "../usage/format";

/** "1,250.00", "0.015": at least two places, up to four when a price has fractions of a cent. */
export function amountText(amount: string): string {
  const [whole = "0", frac = "0000"] = formatAmount(amount, 4).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let places = frac;
  while (places.length > 2 && places.endsWith("0")) places = places.slice(0, -1);
  return `${sign}${digits}.${places}`;
}

/** "$250.00", "$0.015", or "250.00 EUR" (the back office's words). */
export function price(m: Money): string {
  return m.currency === "USD"
    ? `$${amountText(m.amount)}`
    : `${amountText(m.amount)} ${m.currency}`;
}

/**
 * A price in the reader's locale, straight from its decimal string through Intl (up to 4 places):
 * "$0.015", "250,00 €". Never a float (invariant 6).
 */
export function localPrice(m: Money, i18n: I18n): string {
  return i18n.fmt.unitPrice(m.amount, m.currency);
}

/** "1 credit", "1,234 credits" (the back office's words). */
export function credits(n: number): string {
  return `${count(n)} ${n === 1 ? "credit" : "credits"}`;
}

/**
 * Credits used against the allowance: a bar on the data track, filled up to the allowance; what
 * goes past it is said in words, not shown in a colour.
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

const STATUS: Record<string, { label: PlainKey; tone: Tone }> = {
  paid: { label: "billing.status.paid", tone: "positive" },
  open: { label: "billing.status.open", tone: "warning" },
  draft: { label: "billing.status.draft", tone: "neutral" },
  void: { label: "billing.status.void", tone: "neutral" },
  uncollectible: { label: "billing.status.uncollectible", tone: "risk" },
};

/** Stripe's invoices, newest first, with links to the hosted invoice and its PDF. */
export function InvoiceTable({ invoices, testId }: { invoices: BillingInvoice[]; testId: string }) {
  const i18n = useI18n();
  const { t, intl } = i18n;
  const day = (iso: string | null) => (iso ? dayLabel(iso.slice(0, 10), intl) : "");
  return (
    <div className="dt overflow-x-auto">
      <table data-testid={testId}>
        <thead>
          <tr className="dt-cols">
            <th>{t("billing.column.date")}</th>
            <th>{t("billing.column.invoice")}</th>
            <th>{t("billing.column.period")}</th>
            <th className="n">{t("billing.column.amount")}</th>
            <th>{t("billing.column.status")}</th>
            <th>
              <span className="sr-only">{t("billing.column.links")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => {
            const known = STATUS[i.status ?? ""];
            // A status Stripe adds later shows as Stripe wrote it.
            const s: { label: string; tone: Tone } = known
              ? { label: t(known.label), tone: known.tone }
              : { label: i.status ?? t("billing.status.unknown"), tone: "neutral" };
            return (
              <tr key={i.id} data-testid={`${testId}-row-${i.id}`}>
                <td className="text-ink">{day(i.createdAt)}</td>
                <td>{i.number ?? t("billing.draft")}</td>
                <td className="muted">
                  {i.periodStart && i.periodEnd
                    ? `${day(i.periodStart)} – ${day(i.periodEnd)}`
                    : ""}
                </td>
                <td className="n text-ink">{localPrice(i.total, i18n)}</td>
                <td>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </td>
                <td>
                  <span className="flex justify-end gap-3">
                    {i.hostedInvoiceUrl ? (
                      <a
                        className="ds-btn ds-btn--link text-sm"
                        href={i.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.tone === "warning" ? t("billing.viewAndPay") : t("billing.view")}
                      </a>
                    ) : null}
                    {i.pdfUrl ? (
                      <a
                        className="ds-btn ds-btn--link text-sm"
                        href={i.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("billing.pdf")}
                      </a>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
