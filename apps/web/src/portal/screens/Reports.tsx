// `/reports` (ARCHITECTURE §15): what the client's services did in a period, in the client's own
// days: runs and how they ended, documents read, changes made to its tools. Never cost, tokens or
// prompts (invariant 11). Pack reports (Materials: Price watch, Catalog) mount under
// `/reports/<pack>/<report>` from the pack registry, for packs the client has enabled.
import type { ActivityReport } from "@countersign/core";
import { Link, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type PackReport, packReportPath, packReportsFor } from "../../packs/registry";
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
import { count, isoDay, monthEnd, monthStart, periodLabel, plural } from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";

const PERIODS = [
  ["month", "This month"],
  ["last", "Last month"],
  ["quarter", "Last 3 months"],
] as const;
type Period = (typeof PERIODS)[number][0];

/**
 * The period's days. "This month" leaves the days to the API, which counts them in the client's
 * time zone; the others are whole calendar months.
 */
export function reportPeriod(
  period: Period,
  today: Date = new Date(),
): { from?: string; to?: string } {
  const day = isoDay(today);
  if (period === "last") {
    const from = monthStart(day, 1);
    return { from, to: monthEnd(from) };
  }
  if (period === "quarter") return { from: monthStart(day, 2), to: day };
  return {};
}

/** The reports the client can open: activity, then its packs' reports. */
function ReportLinks({ packs, current }: { packs: PackReport[]; current: string }) {
  if (packs.length === 0) return null;
  return (
    <nav className="mb-6 flex flex-wrap gap-2" aria-label="Reports">
      {[
        { to: "/reports", title: "Activity" },
        ...packs.map((r) => ({ to: packReportPath(r), title: r.title })),
      ].map((r) => (
        <Link
          key={r.to}
          to={r.to}
          aria-current={current === r.to ? "page" : undefined}
          className={`ds-btn ds-btn--sm ${current === r.to ? "ds-btn--primary" : "ds-btn--secondary"}`}
        >
          {r.title}
        </Link>
      ))}
    </nav>
  );
}

function RunsNote({ runs }: { runs: ActivityReport["runs"] }) {
  const parts = [
    runs.succeeded ? `${count(runs.succeeded)} done` : null,
    runs.failed ? `${count(runs.failed)} failed` : null,
    runs.waiting ? `${count(runs.waiting)} waiting for a person` : null,
    runs.going ? `${count(runs.going)} running` : null,
    runs.cancelled ? `${count(runs.cancelled)} cancelled` : null,
  ].filter(Boolean);
  return <>{parts.length > 0 ? parts.join(", ") : "Nothing ran"}</>;
}

export function ActivityReportScreen() {
  const [params, setParams] = useSearchParams();
  const period = (PERIODS.find(([p]) => p === params.get("period"))?.[0] ?? "month") as Period;
  const service = params.get("service") ?? "";
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  const { data, error, loading, reload } = useApi(apiRoutes.portalActivityReport, {
    query: { ...reportPeriod(period), ...(service ? { service } : {}) },
  });
  const packs = packReportsFor(data?.packs ?? []);
  const serviceName = service ? data?.services.find((s) => s.id === service)?.name : undefined;

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle={
          data
            ? `What your services did, ${periodLabel(data.from, data.to)}.`
            : "What your services did."
        }
      />
      <ReportLinks packs={packs} current="/reports" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusFilter
          value={period}
          onChange={(p) => set({ period: p === "month" ? "" : p })}
          area="portal-report-period"
          label="Period"
          options={PERIODS.map(([p, l]) => [p, l])}
        />
        {service ? (
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            Service: <span className="text-ink">{serviceName ?? "this service"}</span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="portal-report-all-services"
              onClick={() => set({ service: "" })}
            >
              All services
            </Button>
          </span>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <StatRow cols={3}>
            <Stat
              testId="portal-report-runs"
              label="Runs"
              value={count(data.runs.total)}
              note={<RunsNote runs={data.runs} />}
            />
            <Stat
              testId="portal-report-documents"
              label="Documents read"
              value={count(data.documents.read)}
              note={`${plural(data.documents.received, "document")} came in`}
            />
            <Stat
              testId="portal-report-actions"
              label="Changes to your tools"
              value={count(data.actions.total)}
              note={
                data.actions.byConnector.length > 0
                  ? data.actions.byConnector.map((c) => `${c.name} ${count(c.count)}`).join(", ")
                  : "None in this period"
              }
            />
          </StatRow>
          <section>
            <SectionLabel>By service</SectionLabel>
            {data.services.length === 0 ? (
              <EmptyState>
                No services yet. We set them up with you, and their work shows here.
              </EmptyState>
            ) : (
              <div className="dt dt-ana overflow-x-auto">
                <table data-testid="portal-report-services">
                  <thead>
                    <tr className="dt-cols">
                      <th>Service</th>
                      {["Runs", "Done", "Failed", "Waiting", "Documents read", "Changes"].map(
                        (h) => (
                          <th key={h} className="n">
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.services.map((s) => (
                      <tr key={s.id} data-testid={`portal-report-service-${s.id}`}>
                        <td>
                          <Link
                            to={`/services/${s.id}`}
                            className="font-medium text-ink hover:underline"
                          >
                            {s.name}
                          </Link>
                        </td>
                        <td className="n">{count(s.runs.total)}</td>
                        <td className="n">{count(s.runs.succeeded)}</td>
                        <td className="n">{count(s.runs.failed)}</td>
                        <td className="n">
                          {s.runs.waiting > 0 ? (
                            <Badge tone="warning">{count(s.runs.waiting)} waiting</Badge>
                          ) : (
                            "0"
                          )}
                        </td>
                        <td className="n">{count(s.documentsRead)}</td>
                        <td className="n">{count(s.actions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

/** `/reports/<pack>/<report>`: a registered pack report, if the client has its pack. */
function PackReportScreen() {
  const { pack, report } = useParams();
  const { data, error, loading, reload } = useApi(apiRoutes.portalActivityReport);
  const packs = packReportsFor(data?.packs ?? []);
  const found = packs.find((r) => r.pack === pack && r.slug === report);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!found) {
    return (
      <div>
        <PageHeader title="Reports" />
        <Card className="p-6">
          <p className="text-ink">This report isn't available for you.</p>
          <Link to="/reports" className="ds-btn ds-btn--link mt-2 text-sm">
            See your activity
          </Link>
        </Card>
      </div>
    );
  }
  const { Component } = found;
  return (
    <div>
      <ReportLinks packs={packs} current={packReportPath(found)} />
      <Component />
    </div>
  );
}

export function PortalReportsScreen() {
  return (
    <Routes>
      <Route index element={<ActivityReportScreen />} />
      <Route path=":pack/:report" element={<PackReportScreen />} />
    </Routes>
  );
}
