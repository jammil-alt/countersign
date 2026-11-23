// R5 (docs/plan.md §1.235): a client's report in the back office, the Overview tab's second page
// (`/ops/clients/:clientId/report`), its own chunk with its route's schema. The portal's report,
// with why the client needs us above it. Each figure opens what is behind it: the runs list on
// exactly its runs, the client's Escalations, its connections, billing, an agent's page.
import { accountReportRoutes, type NeedsUsReason, type OpsAccountReport } from "@countersign/core";
import { useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { AccountReportView } from "../../reports/AccountReportView";
import { periodQuery, ReportPeriodForm } from "../../reports/AgentReportView";
import { Loaded } from "../../ui/page";
import { Badge, Card } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";

/** Why a client needs us, in the back office's words. */
export const NEEDS_US_WORDS: Record<NeedsUsReason, string> = {
  waiting: "Waiting over a day",
  failed: "Failed run not looked at",
  connection: "Connection needs attention",
  allowance: "Allowance over 80% used",
};

export const accountLinks = (clientId: string) => ({
  failedUnseen: `${OPS_PATHS.escalations}?client=${clientId}`,
  connection: () => `${OPS_PATHS.client(clientId)}/connections`,
  usage: OPS_PATHS.billing,
  agent: (id: string) => `/ops/agents/${id}`,
});

function NeedsUs({ report }: { report: OpsAccountReport }) {
  if (report.needsUs.length === 0) return null;
  return (
    <Card pad testId="ops-account-needs-us">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Needs us</Badge>
        {report.needsUs.map((r) => (
          <span key={r} className="text-sm text-ink">
            {NEEDS_US_WORDS[r]}
          </span>
        ))}
      </div>
    </Card>
  );
}

export function ClientReportScreen() {
  const { clientId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = periodQuery(period);
  const report = useApi(accountReportRoutes.opsClientReport, { params: { id: clientId }, query });
  const csv = new URLSearchParams(query).toString();
  return (
    <div className="flex flex-col gap-4" data-testid="ops-client-report">
      <ReportPeriodForm period={period} onChange={(p) => setParams(periodQuery(p))} />
      <Loaded state={report} skeleton={<SkeletonRows rows={6} columns={4} />}>
        {(data) => (
          <AccountReportView
            report={data}
            runsLink={runsLink}
            csvHref={`/api/ops/clients/${clientId}/report.csv${csv ? `?${csv}` : ""}`}
            links={accountLinks(clientId)}
            above={<NeedsUs report={data} />}
            surface="ops"
          />
        )}
      </Loaded>
    </div>
  );
}
