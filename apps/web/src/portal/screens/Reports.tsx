// `/reports` (ARCHITECTURE §15; UI-3a restyled the frame, packs own their content): what the client's services did in a period, in the client's own
// days: runs and how they ended, documents read, changes made to its tools. Never cost, tokens or
// prompts (invariant 11). Pack reports (Materials: Price watch, Catalog) mount under
// `/reports/<pack>/<report>` from the pack registry, for packs the client has enabled.
import type { ActivityReport } from "@countersign/core";
import { Link, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { type I18n, useI18n } from "../../i18n/i18n";
import { StatusFilter } from "../../inbox/StatusFilter";
import { type PackReport, packReportPath, packReportsFor } from "../../packs/registry";
import { StatTile } from "../../ui/figures";
import { Columns, Page, Section } from "../../ui/page";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  Tabs,
} from "../../ui/primitives";
import { isoDay, monthEnd, monthStart, periodLabel } from "../../usage/format";

const PERIODS = [
  ["month", "reports.period.month"],
  ["last", "reports.period.last"],
  ["quarter", "reports.period.quarter"],
] as const satisfies readonly (readonly [string, PlainKey])[];
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
  const { t } = useI18n();
  if (packs.length === 0) return null;
  // UI-3a: the reports as tabs, as on the agent page.
  return (
    <div className="overflow-x-auto" data-testid="portal-report-links">
      <Tabs
        items={[
          // Pack reports carry their own titles (a pack's screens), as message keys.
          { to: "/reports", title: t("reports.activity") },
          ...packs.map((r) => ({ to: packReportPath(r), title: t(r.titleKey) })),
        ].map((r) => ({ to: r.to, label: r.title, active: current === r.to }))}
      />
    </div>
  );
}

/**
 * "1 done, 1 failed, 1 waiting on you": how a period's runs stand, the empty ones left out. The
 * same counts and words as the Table and an agent's page (QA round 1).
 */
export function runsNote(
  runs: Pick<ActivityReport["runs"], "succeeded" | "failed" | "waiting" | "going" | "cancelled">,
  { t }: Pick<I18n, "t">,
): string | null {
  const parts = [
    runs.succeeded ? t("reports.runs.done", { count: runs.succeeded }) : null,
    runs.failed ? t("reports.runs.failed", { count: runs.failed }) : null,
    runs.waiting ? t("table.meta.waiting", { count: runs.waiting }) : null,
    runs.going ? t("reports.runs.running", { count: runs.going }) : null,
    runs.cancelled ? t("reports.runs.cancelled", { count: runs.cancelled }) : null,
  ].filter(Boolean);
  // DECISION: a plain comma list in every language; the counts carry the grammar.
  return parts.length > 0 ? parts.join(", ") : null;
}

export function ActivityReportScreen() {
  const i18n = useI18n();
  const { t, fmt } = i18n;
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
    <Page testId="portal-reports-page">
      <PageHeader
        title={t("nav.reports")}
        subtitle={
          data
            ? t("reports.subtitlePeriod", { period: periodLabel(data.from, data.to, i18n.intl) })
            : t("reports.subtitle")
        }
      />
      <ReportLinks packs={packs} current="/reports" />
      <div className="flex flex-wrap items-center gap-3">
        <StatusFilter
          value={period}
          onChange={(p) => set({ period: p === "month" ? "" : p })}
          area="portal-report-period"
          label={t("reports.period")}
          options={PERIODS.map(([p, l]) => [p, t(l)])}
        />
        {service ? (
          <span className="flex items-center gap-2 text-sm text-ink-muted">
            {t("reports.forService")}{" "}
            <span className="text-ink">{serviceName ?? t("reports.thisService")}</span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="portal-report-all-services"
              onClick={() => set({ service: "" })}
            >
              {t("reports.allServices")}
            </Button>
          </span>
        ) : null}
      </div>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data ? (
        <>
          <Columns count={3}>
            <StatTile
              testId="portal-report-runs"
              label={t("reports.runs")}
              value={fmt.number(data.runs.total)}
              note={runsNote(data.runs, i18n) ?? t("reports.runs.none")}
            />
            <StatTile
              testId="portal-report-documents"
              label={t("reports.documentsRead")}
              value={fmt.number(data.documents.read)}
              note={t("reports.documentsIn", { count: data.documents.received })}
            />
            <StatTile
              testId="portal-report-actions"
              label={t("reports.changes")}
              value={fmt.number(data.actions.total)}
              note={
                data.actions.byConnector.length > 0
                  ? data.actions.byConnector
                      .map((c) => `${c.name} ${fmt.number(c.count)}`)
                      .join(", ")
                  : t("reports.changesNone")
              }
            />
          </Columns>
          <Section title={t("reports.byService")}>
            {data.services.length === 0 ? (
              <EmptyState>{t("reports.noServices")}</EmptyState>
            ) : (
              <Card>
                <div className="dt dt-ana overflow-x-auto">
                  <table data-testid="portal-report-services">
                    <thead>
                      <tr className="dt-cols">
                        <th>{t("runs.col.service")}</th>
                        {(
                          [
                            "reports.runs",
                            "reports.col.done",
                            "reports.col.failed",
                            "reports.col.waiting",
                            "reports.documentsRead",
                            "reports.col.changes",
                          ] as const
                        ).map((h) => (
                          <th key={h} className="n">
                            {t(h)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.services.map((s) => (
                        <tr key={s.id} data-testid={`portal-report-service-${s.id}`}>
                          <td>
                            <Link
                              to={`/agents/${s.id}`}
                              className="font-medium text-ink hover:underline"
                            >
                              {s.name}
                            </Link>
                          </td>
                          <td className="n">{fmt.number(s.runs.total)}</td>
                          <td className="n">{fmt.number(s.runs.succeeded)}</td>
                          <td className="n">{fmt.number(s.runs.failed)}</td>
                          <td className="n">
                            {s.runs.waiting > 0 ? (
                              <Badge tone="warning">
                                {t("table.meta.waiting", { count: s.runs.waiting })}
                              </Badge>
                            ) : (
                              fmt.number(0)
                            )}
                          </td>
                          <td className="n">{fmt.number(s.documentsRead)}</td>
                          <td className="n">{fmt.number(s.actions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </Section>
        </>
      ) : null}
    </Page>
  );
}

/** `/reports/<pack>/<report>`: a registered pack report, if the client has its pack. */
function PackReportScreen() {
  const { t } = useI18n();
  const { pack, report } = useParams();
  const { data, error, loading, reload } = useApi(apiRoutes.portalActivityReport);
  const packs = packReportsFor(data?.packs ?? []);
  const found = packs.find((r) => r.pack === pack && r.slug === report);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice error={error} onRetry={reload} />;
  if (!found) {
    return (
      <Page>
        <PageHeader title={t("nav.reports")} />
        <Card pad>
          <p className="text-ink">{t("reports.notAvailable")}</p>
          <Link to="/reports" className="ds-btn ds-btn--link mt-2 text-sm">
            {t("reports.seeActivity")}
          </Link>
        </Card>
      </Page>
    );
  }
  // The frame is the platform's; what is inside belongs to the pack.
  const { Component } = found;
  return (
    <Page testId="portal-pack-report">
      <ReportLinks packs={packs} current={packReportPath(found)} />
      <div>
        <Component />
      </div>
    </Page>
  );
}

export function PortalReportsScreen() {
  return (
    <Routes>
      <Route index element={<ActivityReportScreen />} />
      <Route path=":pack/:report" element={<PackReportScreen />} />
      {/* P-9: one row of a pack report (a purchase request's page) */}
      <Route path=":pack/:report/:id" element={<PackReportScreen />} />
    </Routes>
  );
}
