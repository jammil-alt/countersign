// docs/plan.md §1.234 (Y5): `/billing/work`, the client admin's work statement for a month (in
// the address, `?month=YYYY-MM`; none is last month, the one invoiced), and its PDF: the same PDF
// that went with the invoice. Its own chunk, with its route's schema and core's words.
import { WORK_STATEMENT_WORDS, workStatementRoutes } from "@countersign/core";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { WorkMonthForm, WorkStatementView } from "../../billing/WorkStatementView";
import { useI18n } from "../../i18n/i18n";
import { Loaded, Page } from "../../ui/page";
import { PageHeader } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";

export function PortalWorkStatementScreen() {
  const { locale, t } = useI18n();
  const w = WORK_STATEMENT_WORDS[locale];
  const [params, setParams] = useSearchParams();
  const month = params.get("month");
  const query = month ? { month } : {};
  const state = useApi(workStatementRoutes.portalWorkStatement, { query });
  const pdf = `/api/billing/work.pdf${month ? `?month=${encodeURIComponent(month)}` : ""}`;
  return (
    <Page testId="portal-work-statement">
      <PageHeader title={w.title} subtitle={t("billing.workStatement")} />
      <div className="mb-6">
        <WorkMonthForm month={month} onChange={(m) => setParams(m ? { month: m } : {})} />
      </div>
      <Loaded state={state} skeleton={<SkeletonRows rows={6} columns={6} />}>
        {(statement) => <WorkStatementView statement={statement} pdfHref={pdf} />}
      </Loaded>
    </Page>
  );
}
