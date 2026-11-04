// `/runs`: what the client's services did, newest first (ARCHITECTURE §10.6, §15). Live runs only;
// no costs. Polls while any run is still going.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { useI18n } from "../../i18n/i18n";
import { duration, isRunGoing, runStatusLabel, runStatusTone, shortTime } from "../../runs/format";
import { usePoll } from "../../runs/usePoll";
import {
  AgentAvatar,
  Badge,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
} from "../../ui/primitives";

export function PortalRunsScreen() {
  const i18n = useI18n();
  const { t } = i18n;
  const { data, error, loading, reload } = useApi(apiRoutes.portalRuns, { query: { limit: 100 } });
  usePoll(reload, data?.runs.some((r) => isRunGoing(r.status)) ?? false, 5_000);

  return (
    <div className="max-w-5xl">
      <PageHeader title={t("runs.title")} subtitle={t("runs.subtitle")} />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.runs.length === 0 ? <EmptyState>{t("runs.empty")}</EmptyState> : null}
      {data && data.runs.length > 0 ? (
        <div className="dt dt-ana">
          <table data-testid="portal-runs">
            <thead>
              <tr className="dt-cols">
                <th>{t("runs.col.service")}</th>
                <th>{t("runs.col.status")}</th>
                <th>{t("runs.col.started")}</th>
                <th>{t("runs.col.took")}</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      to={`/runs/${r.id}`}
                      data-testid={`portal-run-${r.id}-open`}
                      className="flex items-center gap-3 font-medium text-ink hover:underline"
                    >
                      <AgentAvatar name={r.service.name} seed={r.service.id} />
                      {r.service.name}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status, i18n)}</Badge>
                  </td>
                  <td className="text-ink figures">{shortTime(r.startedAt, undefined, i18n)}</td>
                  <td className="text-ink figures">
                    {duration(r.startedAt, r.finishedAt, undefined, i18n)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
