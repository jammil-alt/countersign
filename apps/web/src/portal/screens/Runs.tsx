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
  Card,
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
        <Card className="overflow-hidden">
          <table data-testid="portal-runs" className="w-full text-sm">
            <thead>
              <tr className="bg-subtle text-left">
                <th className="label-caps px-4 py-2 font-medium text-secondary">Service</th>
                <th className="label-caps px-4 py-2 font-medium text-secondary">Status</th>
                <th className="label-caps px-4 py-2 font-medium text-secondary">Started</th>
                <th className="label-caps px-4 py-2 font-medium text-secondary">Took</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id} className="border-t border-divider hover:bg-subtle">
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/runs/${r.id}`}
                      data-testid={`portal-run-${r.id}-open`}
                      className="flex items-center gap-3 font-medium text-primary hover:underline"
                    >
                      <AgentAvatar name={r.service.name} seed={r.service.id} />
                      {r.service.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={runStatusTone(r.status)}>{runStatusLabel(r.status)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-body">{shortTime(r.startedAt)}</td>
                  <td className="px-4 py-2.5 font-mono text-body">
                    {duration(r.startedAt, r.finishedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
