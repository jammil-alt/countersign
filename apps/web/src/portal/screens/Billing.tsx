// `/billing` (client admin; docs/plan.md §1.32): this month so far by service, the credits
// included and used, the price of an extra credit, and past statements with Stripe's hosted page
// and PDF. Never what the work cost us, tokens or prompts (invariant 11): credits are the billing
// unit. Words in the reader's language; prices through Intl from their decimal strings
// (docs/plan.md §1.18).
import type { PortalStatement } from "@countersign/core";
import { useState } from "react";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  CreditMeter,
  daysIn,
  localAmount,
  localPrice,
  STATEMENT_STATUS,
  StatementLines,
} from "../../billing/parts";
import { useI18n } from "../../i18n/i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { count, dayLabel, periodLabel } from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";

/** `embedded`: inside Settings (its Billing section), without a header of its own. */
export function PortalBillingScreen({ embedded = false }: { embedded?: boolean } = {}) {
  const i18n = useI18n();
  const { t, intl } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalBilling);
  const month = data?.monthSoFar ?? null;

  return (
    <div>
      {embedded ? null : <PageHeader title={t("billing.title")} subtitle={t("billing.subtitle")} />}
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && !data.setUp ? <EmptyState>{t("billing.notSetUp")}</EmptyState> : null}
      {data?.setUp && month ? (
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
              testId="portal-billing-so-far"
              label={t("billing.soFar")}
              value={localAmount(month.total, i18n)}
              note={t("billing.soFarNote", {
                period: periodLabel(month.period.start, month.period.through, intl),
              })}
            />
            <Stat
              testId="portal-billing-allowance"
              label={t("billing.included")}
              value={count(month.creditsIncluded, intl)}
              unit={t("billing.creditUnit", { count: month.creditsIncluded })}
              note={t("billing.shared")}
            />
            <Stat
              testId="portal-billing-extra"
              label={t("billing.extra")}
              value={count(month.extraCredits, intl)}
              note={t("billing.extraEach", { price: localPrice(month.creditPrice, i18n) })}
            />
          </StatRow>
          <section className="mb-8">
            <SectionLabel>{t("billing.byService")}</SectionLabel>
            <Card className="flex flex-col gap-4 p-5">
              <p className="text-sm text-ink-muted">
                {t("billing.periodBody", {
                  period: periodLabel(month.period.start, month.period.through, intl),
                  credits: t("billing.credits", { count: month.creditsIncluded }),
                })}
              </p>
              <CreditMeter
                used={month.creditsUsed}
                allowance={month.creditsIncluded}
                testId="portal-billing-meter"
              />
              <StatementLines
                lines={month.lines}
                daysInMonth={month.daysInMonth}
                summary={month}
                total={month.total}
                totalLabel={t("billing.totalSoFar")}
                testId="portal-billing-month"
              />
            </Card>
          </section>
          <section>
            <SectionLabel>{t("billing.statements")}</SectionLabel>
            {data.statements.length === 0 ? (
              <EmptyState>{t("billing.noStatements")}</EmptyState>
            ) : (
              <div className="flex flex-col gap-3">
                {data.statements.map((s) => (
                  <StatementCard key={s.id} statement={s} />
                ))}
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function StatementCard({ statement: s }: { statement: PortalStatement }) {
  const i18n = useI18n();
  const { t, intl } = i18n;
  const [open, setOpen] = useState(false);
  const status = STATEMENT_STATUS[s.status];
  const toPay = s.status === "sent" || s.status === "payment_failed";
  const testId = `portal-billing-statement-${s.id}`;
  return (
    <Card className="flex flex-col gap-4 p-5" testId={testId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-medium text-ink">
            {new Date(`${s.period.start}T00:00:00.000Z`).toLocaleDateString(intl, {
              month: "long",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
          <span className="text-sm text-ink-muted">
            {[
              s.invoiceNumber,
              s.dueAt && toPay
                ? t("billing.dueOn", { date: dayLabel(s.dueAt.slice(0, 10), intl) })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-ink figures">{localAmount(s.total, i18n)}</span>
          <Badge tone={status.tone}>{t(status.label)}</Badge>
          {s.hostedInvoiceUrl ? (
            <a
              className="ds-btn ds-btn--link text-sm"
              href={s.hostedInvoiceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {toPay ? t("billing.viewAndPay") : t("billing.view")}
            </a>
          ) : null}
          {s.pdfUrl ? (
            <a
              className="ds-btn ds-btn--link text-sm"
              href={s.pdfUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("billing.pdf")}
            </a>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            data-testid={`${testId}-toggle`}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t("billing.hideDetails") : t("billing.details")}
          </Button>
        </span>
      </div>
      {open ? (
        <StatementLines
          lines={s.lines}
          daysInMonth={daysIn(s.period.start)}
          summary={s}
          total={s.total}
          totalLabel={t("billing.total")}
          testId={`${testId}-lines`}
        />
      ) : null}
    </Card>
  );
}
