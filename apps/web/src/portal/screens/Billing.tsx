// `/billing` (client admin; docs/plan.md §1.24): the plan (agents × base fee), the credit allowance,
// the credits used this period as a meter, and the invoices with Stripe's hosted page and PDF. Never
// what the work cost us, tokens or prompts (invariant 11): credits are the billing unit.
// Plain English strings; the languages stream converts them later.
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { CreditMeter, credits, InvoiceTable, price } from "../../billing/parts";
import {
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { count, periodLabel } from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";

export function PortalBillingScreen() {
  const { data, error, loading, reload } = useApi(apiRoutes.portalBilling);

  return (
    <div>
      <PageHeader
        title="Billing"
        subtitle="Your plan, the credits your services used and your invoices."
      />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && !data.setUp ? (
        <EmptyState>
          Billing is not set up yet. We'll let you know before your first invoice.
        </EmptyState>
      ) : null}
      {data?.setUp && data.plan ? (
        <>
          {data.paymentProblem ? (
            <div
              role="alert"
              className="ds-banner mb-6"
              data-testid="portal-billing-payment-problem"
            >
              <span>Your last payment didn't go through. Open the invoice below to pay it.</span>
            </div>
          ) : null}
          <StatRow cols={3}>
            <Stat
              testId="portal-billing-plan"
              label="Plan"
              value={data.plan.monthly ? price(data.plan.monthly) : count(data.plan.agents)}
              unit={data.plan.monthly ? "a month" : data.plan.agents === 1 ? "service" : "services"}
              note={
                data.plan.baseFee
                  ? `${count(data.plan.agents)} ${data.plan.agents === 1 ? "service" : "services"} × ${price(data.plan.baseFee)}`
                  : `${count(data.plan.agents)} active ${data.plan.agents === 1 ? "service" : "services"}`
              }
            />
            <Stat
              testId="portal-billing-allowance"
              label="Included each month"
              value={count(data.allowance)}
              unit="credits"
              note="Shared by all your services"
            />
            <Stat
              testId="portal-billing-extra"
              label="Extra credits"
              value={count(data.extraCredits)}
              note={
                data.extraCreditPrice
                  ? `${price(data.extraCreditPrice)} each, on your next invoice`
                  : "On your next invoice"
              }
            />
          </StatRow>
          <section className="mb-8">
            <SectionLabel>This period</SectionLabel>
            <Card className="flex flex-col gap-3 p-5">
              <p className="text-sm text-ink-muted">
                {periodLabel(data.period.start, data.period.through)}. Credits measure the work your
                services do: reading documents, messages, calls. {credits(data.allowance)} are
                included.
              </p>
              <CreditMeter
                used={data.creditsUsed}
                allowance={data.allowance}
                testId="portal-billing-meter"
              />
            </Card>
          </section>
          <section>
            <SectionLabel>Invoices</SectionLabel>
            {data.invoicesUnavailable ? (
              <EmptyState>
                We couldn't load your invoices just now. Try again in a few minutes.
              </EmptyState>
            ) : data.invoices.length === 0 ? (
              <EmptyState>
                No invoices yet. Your first one comes at the end of the month.
              </EmptyState>
            ) : (
              <InvoiceTable invoices={data.invoices} testId="portal-billing-invoices" />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
