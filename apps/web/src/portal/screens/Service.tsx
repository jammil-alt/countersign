// `/services/:id` (ARCHITECTURE §15): one service as the client sees it: what it does in plain
// words, what it did this month, its recent runs, and the reports about it. Never the agent's
// bundle, instructions or cost.
import { Link, useParams } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import type { PlainKey } from "../../i18n/catalog";
import { useI18n } from "../../i18n/i18n";
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
import { periodLabel } from "../../usage/format";
import { Stat, StatRow } from "../../usage/Stat";
import { runsNote } from "./Reports";

const STATUS: Record<string, { label: PlainKey; tone: "positive" | "neutral" }> = {
  active: { label: "service.status.active", tone: "positive" },
  paused: { label: "service.status.paused", tone: "neutral" },
  retired: { label: "service.status.retired", tone: "neutral" },
};

export function PortalServiceScreen() {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useApi(apiRoutes.portalService, { params: { id } });

  if (loading && !data) return <Loading />;
  if (error) {
    return (
      <div>
        <PageHeader title={t("page.service")} />
        <ErrorNotice error={error} onRetry={reload} />
      </div>
    );
  }
  if (!data) return null;
  const { service, thisMonth, recentRuns } = data;
  const known = STATUS[service.status];
  const status = known
    ? { label: t(known.label), tone: known.tone }
    : { label: service.status, tone: "neutral" as const };
  const packs = packReportsFor(data.packs);

  return (
    <div>
      <PageHeader
        leading={<AgentAvatar name={service.name} size="lg" />}
        title={service.name}
        badge={<Badge tone={status.tone}>{status.label}</Badge>}
        subtitle={service.description ?? t("service.noDescription")}
      />
      <SectionLabel>{t("service.thisMonth")}</SectionLabel>
      <p className="mb-3 text-sm text-ink-muted">
        {periodLabel(thisMonth.from, thisMonth.to, i18n.intl)}
      </p>
      <StatRow cols={3}>
        <Stat
          testId="portal-service-runs"
          label={t("reports.runs")}
          value={fmt.number(thisMonth.runs.total)}
          note={
            thisMonth.runs.total === 0
              ? t("service.nothingRan")
              : runsNote(thisMonth.runs, i18n, "reports.runs.waiting")
          }
        />
        <Stat
          testId="portal-service-documents"
          label={t("reports.documentsRead")}
          value={fmt.number(thisMonth.documentsRead)}
        />
        <Stat
          testId="portal-service-actions"
          label={t("reports.changes")}
          value={fmt.number(thisMonth.actions)}
        />
      </StatRow>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_340px]">
        <section>
          <SectionLabel
            action={
              <Link to="/runs" className="ds-btn ds-btn--link text-sm">
                {t("service.allRuns")}
              </Link>
            }
          >
            {t("service.recentRuns")}
          </SectionLabel>
          {recentRuns.length === 0 ? (
            <EmptyState>{t("service.noRuns")}</EmptyState>
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
                    {shortTime(r.startedAt, undefined, i18n) || t("run.notStarted")}
                  </span>
                  <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status, i18n)}</Badge>
                </Link>
              ))}
            </Card>
          )}
        </section>
        <section>
          <SectionLabel>{t("nav.reports")}</SectionLabel>
          <Card className="flex flex-col gap-3 p-5" testId="portal-service-reports">
            <Link
              to={`/reports?service=${service.id}`}
              className="font-medium text-ink hover:underline"
            >
              {t("reports.activity")}
            </Link>
            <span className="text-sm text-ink-muted">
              {t("service.activityHelp", { count: thisMonth.runs.total })}
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
