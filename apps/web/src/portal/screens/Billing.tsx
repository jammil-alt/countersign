// `/billing` (client admin; docs/plan.md §1.24): the plan (agents × base fee), the credit allowance,
// the credits used this period as a meter, and the invoices with Stripe's hosted page and PDF. Never
// what the work cost us, tokens or prompts (invariant 11): credits are the billing unit. Words in
// the reader's language; prices through Intl from their decimal strings (docs/plan.md §1.18).
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { CreditMeter, InvoiceTable, localPrice } from "../../billing/parts";
import { useI18n } from "../../i18n/i18n";
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
  const i18n = useI18n();
  const { t, intl } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalBilling);

  return (
    <div>
      <PageHeader title={t("billing.title")} subtitle={t("billing.subtitle")} />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && !data.setUp ? <EmptyState>{t("billing.notSetUp")}</EmptyState> : null}
      {data?.setUp && data.plan ? (
        <>
          {data.paymentProblem ? (
            <div
              role="alert"
              className="ds-banner mb-6"
              data-testid="portal-billing-payment-problem"
            >
              <span>{t("billing.paymentProblem")}</span>
            </div>
          ) : null}
          <StatRow cols={3}>
            <Stat
              testId="portal-billing-plan"
              label={t("billing.plan")}
              value={
                data.plan.monthly
                  ? localPrice(data.plan.monthly, i18n)
                  : count(data.plan.agents, intl)
              }
              unit={
                data.plan.monthly
                  ? t("billing.aMonth")
                  : t("billing.serviceUnit", { count: data.plan.agents })
              }
              note={
                data.plan.baseFee
                  ? t("billing.planFee", {
                      count: data.plan.agents,
                      fee: localPrice(data.plan.baseFee, i18n),
                    })
                  : t("billing.planActive", { count: data.plan.agents })
              }
            />
            <Stat
              testId="portal-billing-allowance"
              label={t("billing.included")}
              value={count(data.allowance, intl)}
              unit={t("billing.creditUnit", { count: data.allowance })}
              note={t("billing.shared")}
            />
            <Stat
              testId="portal-billing-extra"
              label={t("billing.extra")}
              value={count(data.extraCredits, intl)}
              note={
                data.extraCreditPrice
                  ? t("billing.extraEach", { price: localPrice(data.extraCreditPrice, i18n) })
                  : t("billing.extraNext")
              }
            />
          </StatRow>
          <section className="mb-8">
            <SectionLabel>{t("billing.thisPeriod")}</SectionLabel>
            <Card className="flex flex-col gap-3 p-5">
              <p className="text-sm text-ink-muted">
                {t("billing.periodBody", {
                  period: periodLabel(data.period.start, data.period.through, intl),
                  credits: t("billing.credits", { count: data.allowance }),
                })}
              </p>
              <CreditMeter
                used={data.creditsUsed}
                allowance={data.allowance}
                testId="portal-billing-meter"
              />
            </Card>
          </section>
          <section>
            <SectionLabel>{t("billing.invoices")}</SectionLabel>
            {data.invoicesUnavailable ? (
              <EmptyState>{t("billing.invoicesUnavailable")}</EmptyState>
            ) : data.invoices.length === 0 ? (
              <EmptyState>{t("billing.noInvoices")}</EmptyState>
            ) : (
              <InvoiceTable invoices={data.invoices} testId="portal-billing-invoices" />
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
