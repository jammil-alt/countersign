// R4 (docs/plan.md §1.214): a client agent's Report tab in the back office, its own chunk with
// its route's schema: the portal's report, with the agent's errors and cost below it.
import { agentReportRoutes, type OpsAgentReport } from "@countersign/core";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../../api/useApi";
import { AgentReportView, periodQuery, ReportPeriodForm } from "../../reports/AgentReportView";
import { KpiStrip, StatTile } from "../../ui/figures";
import { Loaded, Section } from "../../ui/page";
import { Card } from "../../ui/primitives";
import { SkeletonRows } from "../../ui/skeleton";
import { cost } from "../../usage/format";
import { runsLink } from "../run/links";

const n = (v: number) => v.toLocaleString("en-US");

function OpsExtras({ report }: { report: OpsAgentReport }) {
  const s = report.spend;
  return (
    <>
      <Section title="Errors" testId="ops-agent-report-errors">
        {report.errors.length === 0 ? (
          <p className="text-sm text-ink-muted">No failed runs in this period.</p>
        ) : (
          <Card>
            <div className="dt dt-ana overflow-x-auto">
              <table>
                <thead>
                  <tr className="dt-cols">
                    <th>Error</th>
                    <th className="n">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errors.map((e) => (
                    <tr key={e.key}>
                      <td>
                        <Link to={runsLink(e.filter)} className="font-mono hover:underline">
                          {e.key}
                        </Link>
                      </td>
                      <td className="n figures">{n(e.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Section>
      <Section title="Cost and tokens" testId="ops-agent-report-spend">
        <KpiStrip>
          <StatTile
            label="Model cost"
            value={cost(s.costUsd)}
            to={runsLink(s.filter)}
            note={`${n(s.runs)} runs`}
          />
          <StatTile
            label="Per run"
            value={s.costPerRunUsd === null ? "–" : cost(s.costPerRunUsd)}
          />
          <StatTile
            label="Tokens per run"
            value={s.tokensPerRun === null ? "–" : n(s.tokensPerRun)}
            note={`${n(s.tokensIn)} in, ${n(s.tokensOut)} out`}
          />
        </KpiStrip>
      </Section>
    </>
  );
}

export function ReportTab({ agentId }: { agentId: string }) {
  const [params, setParams] = useSearchParams();
  const from = params.get("from");
  const to = params.get("to");
  const period = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  const query = periodQuery(period);
  const report = useApi(agentReportRoutes.opsAgentReport, { params: { id: agentId }, query });
  const csv = new URLSearchParams(query).toString();
  return (
    <div className="flex flex-col gap-4" data-testid="ops-agent-report">
      <ReportPeriodForm period={period} onChange={(p) => setParams(periodQuery(p))} />
      <Loaded state={report} skeleton={<SkeletonRows rows={6} columns={4} />}>
        {(data) => (
          <AgentReportView
            report={data}
            runsLink={runsLink}
            csvHref={`/api/ops/agents/${agentId}/report.csv${csv ? `?${csv}` : ""}`}
            extra={<OpsExtras report={data} />}
          />
        )}
      </Loaded>
    </div>
  );
}
