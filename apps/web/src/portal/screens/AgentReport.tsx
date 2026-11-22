// R4 (docs/plan.md §1.214): the portal agent page's Report tab, its own chunk with its route's
// schema and words. Its period is in the address (`?from&to`); none is this month.
import { agentReportRoutes, type RunFilter, runFilterQuery } from "@countersign/core";
import { useSearchParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { AgentReportView, periodQuery, ReportPeriodForm } from "../../reports/AgentReportView";
import { Loaded } from "../../ui/page";
import { SkeletonRows } from "../../ui/skeleton";
import { PORTAL_PATHS } from "../paths";

/** The portal's runs list on exactly a figure's runs. */
function portalRunsLink(filter: RunFilter): string {
  const q = new URLSearchParams(runFilterQuery(filter)).toString();
  return q ? `${PORTAL_PATHS.runs}?${q}` : PORTAL_PATHS.runs;
}

export function AgentReport({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = periodQuery(period);
  const report = useApi(agentReportRoutes.portalServiceReport, { params: { id }, query });
  const csv = new URLSearchParams(query).toString();
  return (
    <div className="flex flex-col gap-4" data-testid="portal-agent-report">
      <ReportPeriodForm period={period} onChange={(p) => setParams(periodQuery(p))} />
      <Loaded state={report} skeleton={<SkeletonRows rows={6} columns={4} />}>
        {(data) => (
          <AgentReportView
            report={data}
            runsLink={portalRunsLink}
            csvHref={`/api/services/${id}/report.csv${csv ? `?${csv}` : ""}`}
          />
        )}
      </Loaded>
    </div>
  );
}
