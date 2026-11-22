// R5 (docs/plan.md §1.235): the portal's account report, `/reports/account`, its own chunk with its
// route's schema and words. Its period is in the address (`?from&to`); none is this month. Each
// figure opens the portal's runs list on exactly its runs, a connection its Connectors page, usage
// the Billing page (shown to a client admin only), an agent its own report.
import { accountReportRoutes, type RunFilter, runFilterQuery } from "@countersign/core";
import { useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { packReportsFor } from "../../packs/registry";
import { AccountReportView } from "../../reports/AccountReportView";
import { periodQuery, ReportPeriodForm } from "../../reports/AgentReportView";
import { Loaded, Page } from "../../ui/page";
import { PageHeader } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { PORTAL_PATHS } from "../paths";
import { ReportLinks } from "./Reports";

/** The portal's runs list on exactly a figure's runs. */
function portalRunsLink(filter: RunFilter): string {
  const q = new URLSearchParams(runFilterQuery(filter)).toString();
  return q ? `${PORTAL_PATHS.runs}?${q}` : PORTAL_PATHS.runs;
}

export function AccountReportScreen() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = periodQuery(period);
  const report = useApi(accountReportRoutes.portalAccountReport, { query });
  // The tabs name the client's pack reports, as the pack report screens do.
  const activity = useApi(apiRoutes.portalActivityReport);
  const csv = new URLSearchParams(query).toString();
  return (
    <Page testId="portal-account-report">
      <PageHeader title={t("nav.reports")} />
      <ReportLinks packs={packReportsFor(activity.data?.packs ?? [])} current="/reports/account" />
      <ReportPeriodForm period={period} onChange={(p) => setParams(periodQuery(p))} />
      <Loaded state={report} skeleton={<SkeletonRows rows={6} columns={4} />}>
        {(data) => (
          <AccountReportView
            report={data}
            runsLink={portalRunsLink}
            csvHref={`/api/reports/account.csv${csv ? `?${csv}` : ""}`}
            links={{
              connection: (c) => PORTAL_PATHS.connector(c.connector),
              usage: PORTAL_PATHS.billing,
              agent: (id) => PORTAL_PATHS.agentReport(id),
            }}
          />
        )}
      </Loaded>
    </Page>
  );
}
