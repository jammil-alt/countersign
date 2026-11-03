// `/runs`: what the client's services did, newest first (ARCHITECTURE §10.6, §15). Live runs only;
// no costs. Polls while any run is still going.
import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
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
  const { data, error, loading, reload } = useApi(apiRoutes.portalRuns, { query: { limit: 100 } });
  usePoll(reload, data?.runs.some((r) => isRunGoing(r.status)) ?? false, 5_000);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Runs" subtitle="Each time one of your services did its work." />
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.runs.length === 0 ? <EmptyState>No runs yet.</EmptyState> : null}
      {data && data.runs.length > 0 ? (
        <div className="dt dt-ana">
          <table data-testid="portal-runs">
            <thead>
              <tr className="dt-cols">
                <th>Service</th>
                <th>Status</th>
                <th>Started</th>
                <th>Took</th>
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
                    <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                  </td>
                  <td className="text-ink figures">{shortTime(r.startedAt)}</td>
                  <td className="text-ink figures">{duration(r.startedAt, r.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
