import { Link } from "react-router-dom";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import {
  buttonClass,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeader,
  SectionLabel,
} from "../../ui/primitives";

/** `/ops/clients`: every client the operator serves. */
export function ClientsScreen() {
  return (
    <div>
      <PageHeader
        title="Clients"
        subtitle="Clients you serve and the agents running for them."
        actions={<NewClientLink />}
      />
      <ClientsTable />
    </div>
  );
}

export function NewClientLink() {
  return (
    <Link to="/ops/clients/new" className={buttonClass("primary")} data-testid="ops-new-client">
      New client
    </Link>
  );
}

/** The clients table, on the clients list and the overview. */
export function ClientsTable() {
  const { data, error, loading, reload } = useApi(apiRoutes.opsClients);
  return (
    <section>
      <SectionLabel>Clients</SectionLabel>
      {loading && !data ? <Loading /> : null}
      {error ? <ErrorNotice error={error} onRetry={reload} /> : null}
      {data && data.clients.length === 0 ? <EmptyState>No clients yet.</EmptyState> : null}
      {data && data.clients.length > 0 ? (
        <div className="dt dt-ana">
          <table data-testid="ops-clients-table">
            <thead>
              <tr className="dt-cols">
                <th>Client</th>
                <th className="n">Agents</th>
                <th className="n">Open inbox</th>
                <th>Timezone</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link
                      to={`/ops/clients/${c.id}`}
                      data-testid={`ops-client-${c.id}`}
                      className="font-medium text-ink hover:underline"
                    >
                      {c.name}
                    </Link>
                  </td>
                  <td className="n">{c.agents}</td>
                  <td className="n">{c.openInbox}</td>
                  <td>{c.timezone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
