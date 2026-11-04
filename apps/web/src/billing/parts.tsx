// Billing pieces shared by the back office and the portal (docs/plan.md §1.24): prices as words,
// the credit meter, and Stripe's invoices with their hosted page and PDF. Amounts are decimal
// strings, formatted without floats.
import type { BillingInvoice, Money } from "@countersign/core";
import { formatAmount } from "@countersign/core";
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

/** "$250.00", "$0.015", or "250.00 EUR". */
export function price(m: Money): string {
  return m.currency === "USD"
    ? `$${amountText(m.amount)}`
    : `${amountText(m.amount)} ${m.currency}`;
}

/** "1 credit", "1,234 credits". */
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
  // Whole percent from integers: no float reaches a figure the client reads.
  const pct =
    allowance > 0 ? Math.min(100, Math.floor((used * 100) / allowance)) : used > 0 ? 100 : 0;
  const extra = Math.max(0, used - allowance);
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> takes the browser's colours; this one is drawn with the data tokens. */}
      <div
        role="meter"
        aria-label="Credits used this period"
        aria-valuemin={0}
        aria-valuemax={allowance}
        aria-valuenow={Math.min(used, allowance)}
        aria-valuetext={`${credits(used)} of ${credits(allowance)}`}
        className="flex h-2 w-full overflow-hidden rounded-sm bg-data-track"
      >
        <span className="block h-full bg-data-bar" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-ink-muted">
        <span className="text-ink figures">{count(used)}</span> of{" "}
        <span className="figures">{credits(allowance)}</span> used
        {extra > 0 ? (
          <>
            {" · "}
            <span className="text-ink figures">{credits(extra)}</span> over the allowance
          </>
        ) : null}
      </p>
    </div>
  );
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  paid: { label: "Paid", tone: "positive" },
  open: { label: "To pay", tone: "warning" },
  draft: { label: "Draft", tone: "neutral" },
  void: { label: "Void", tone: "neutral" },
  uncollectible: { label: "Not collected", tone: "risk" },
};

const day = (iso: string | null) => (iso ? dayLabel(iso.slice(0, 10)) : "");

/** Stripe's invoices, newest first, with links to the hosted invoice and its PDF. */
export function InvoiceTable({ invoices, testId }: { invoices: BillingInvoice[]; testId: string }) {
  return (
    <div className="dt overflow-x-auto">
      <table data-testid={testId}>
        <thead>
          <tr className="dt-cols">
            <th>Date</th>
            <th>Invoice</th>
            <th>Period</th>
            <th className="n">Amount</th>
            <th>Status</th>
            <th>
              <span className="sr-only">Links</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => {
            const s = STATUS[i.status ?? ""] ?? { label: i.status ?? "Unknown", tone: "neutral" };
            return (
              <tr key={i.id} data-testid={`${testId}-row-${i.id}`}>
                <td className="text-ink">{day(i.createdAt)}</td>
                <td>{i.number ?? "Draft"}</td>
                <td className="muted">
                  {i.periodStart && i.periodEnd
                    ? `${day(i.periodStart)} – ${day(i.periodEnd)}`
                    : ""}
                </td>
                <td className="n text-ink">{price(i.total)}</td>
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
                        {s.tone === "warning" ? "View and pay" : "View"}
                      </a>
                    ) : null}
                    {i.pdfUrl ? (
                      <a
                        className="ds-btn ds-btn--link text-sm"
                        href={i.pdfUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        PDF
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
