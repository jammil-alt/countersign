// `/services/:id` (ARCHITECTURE §15): one service as the client sees it: what it does in plain
// words, what it did this month, its recent runs, and the reports about it. Never the agent's
// bundle, instructions or cost.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { packReportPath, packReportsFor } from "../../packs/registry";
import { runStatusLabel, runStatusTone, shortTime } from "../../runs/format";
import {
  AgentAvatar,
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";
import { count, periodLabel, plural } from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";

const STATUS: Record<string, { label: string; tone: "positive" | "neutral" }> = {
  active: { label: "Active", tone: "positive" },
  paused: { label: "Paused", tone: "neutral" },
  retired: { label: "Retired", tone: "neutral" },
};

export function PortalServiceScreen() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useApi(apiRoutes.portalService, { params: { id } });

  if (loading && !data) return <Loading />;
  if (error) {
    return (
      <div>
        <PageHeader title="Service" />
        <ErrorNotice error={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;
  const { service, thisMonth, recentRuns } = data;
  const status = STATUS[service.status] ?? { label: service.status, tone: "neutral" as const };
  const packs = packReportsFor(data.packs);

  return (
    <div>
      <PageHeader
        leading={<AgentAvatar name={service.name} size="lg" />}
        title={service.name}
        badge={<Badge tone={status.tone}>{status.label}</Badge>}
        subtitle={service.description ?? "We'll describe what this service does here."}
      />
      <SectionLabel>This month</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">{periodLabel(thisMonth.from, thisMonth.to)}</p>
      <StatRow>
        <Stat
          testId="portal-service-runs"
          label="Runs"
          value={count(thisMonth.runs.total)}
          note={
            thisMonth.runs.total === 0
              ? "Nothing ran yet this month"
              : `${count(thisMonth.runs.succeeded)} done${
                  thisMonth.runs.failed ? `, ${count(thisMonth.runs.failed)} failed` : ""
                }${thisMonth.runs.waiting ? `, ${count(thisMonth.runs.waiting)} waiting` : ""}`
          }
        />
        <Stat
          testId="portal-service-documents"
          label="Documents read"
          value={count(thisMonth.documentsRead)}
        />
        <Stat
          testId="portal-service-actions"
          label="Changes to your tools"
          value={count(thisMonth.actions)}
        />
      </StatRow>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_340px]">
        <section>
          <SectionLabel
            action={
              <Link to="/runs" className="ds-btn ds-btn--link text-sm">
                All runs
              </Link>
            }
          >
            Recent runs
          </SectionLabel>
          {recentRuns.length === 0 ? (
            <EmptyState>No runs yet. Each run this service makes shows here.</EmptyState>
          ) : (
            <Card className="divide-y divide-line" testId="portal-service-recent-runs">
              {recentRuns.map((r) => (
                <Link
                  key={r.id}
                  to={`/runs/${r.id}`}
                  data-testid={`portal-service-run-${r.id}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-surface-subtle"
                >
                  <span className="text-ink figures">
                    {shortTime(r.startedAt) || "Not started"}
                  </span>
                  <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                </Link>
              ))}
            </Card>
          )}
        </section>
        <section>
          <SectionLabel>Reports</SectionLabel>
          <Card className="flex flex-col gap-3 p-5" testId="portal-service-reports">
            <Link
              to={`/reports?service=${service.id}`}
              className="font-medium text-ink hover:underline"
            >
              Activity
            </Link>
            <span className="text-sm text-ink-muted">
              {plural(thisMonth.runs.total, "run")} this month, by how they ended, with the
              documents read and the changes made.
            </span>
            {packs.map((r) => (
              <span key={packReportPath(r)} className="flex flex-col gap-1">
                <Link to={packReportPath(r)} className="font-medium text-ink hover:underline">
                  {r.title}
                </Link>
                <span className="text-sm text-ink-muted">{r.description}</span>
              </span>
            ))}
          </Card>
        </section>
      </div>
    </div>
  );
}
