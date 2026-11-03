import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  buttonClass,
  Card,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";

/** `/ops` and `/ops/clients`: every client the operator serves. */
export function ClientsScreen({ overview }: { overview?: boolean }) {
  const { data, error, loading, reload } = useApi(apiRoutes.opsClients);

  return (
    <div>
      <PageHeader
        title={overview ? "Overview" : "Clients"}
        subtitle={
          overview
            ? "Every client you serve. Needs attention and usage arrive with the inbox and runs."
            : "Clients you serve and the agents running for them."
        }
        actions={
          <Link to="/ops/clients/new" className={buttonClass("primary")}>
            New client
          </Link>
        }
      />
      <SectionLabel>Clients</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.clients.length === 0 ? <EmptyState>No clients yet.</EmptyState> : null}
      {data && data.clients.length > 0 ? (
        <Card className="overflow-hidden">
          <table data-testid="ops-clients-table" className="w-full text-left">
            <thead className="border-b border-edge bg-subtle">
              <tr className="label-caps text-secondary">
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Agents</th>
                <th className="px-4 py-2.5 font-medium">Open inbox</th>
                <th className="px-4 py-2.5 font-medium">Timezone</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.id} className="border-b border-divider last:border-0 hover:bg-hover">
                  <td className="px-4 py-3">
                    <Link
                      to={`/ops/clients/${c.id}`}
                      data-testid={`ops-client-${c.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono">{c.agents}</td>
                  <td className="px-4 py-3 font-mono">{c.openInbox}</td>
                  <td className="px-4 py-3 text-secondary">{c.timezone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
