// `/ops/clients`: every client the operator serves (the sidebar's "All N clients"), in the
// prototype's back-office style: a line of totals, then one row per client with its agents, what
// is open there (for us or for the client) and when it started. Each row opens the client page.
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Loaded, Page } from "../../ui/page";
import { buttonClass, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";

type Clients = ResponseOf<typeof apiRoutes.opsClients>["clients"];

/** "4 clients · 9 agents · 3 open items" (items waiting on anyone: us or the client). */
export function clientsLine(clients: Clients): string {
  const agents = clients.reduce((n, c) => n + c.agents, 0);
  const waiting = clients.reduce((n, c) => n + c.openInbox, 0);
  return [
    `${clients.length} ${clients.length === 1 ? "client" : "clients"}`,
    `${agents} ${agents === 1 ? "agent" : "agents"}`,
    waiting > 0 ? `${waiting} open ${waiting === 1 ? "item" : "items"}` : "nothing open",
  ].join(" · ");
}

export function ClientsScreen() {
  const state = useApi(apiRoutes.opsClients);
  return (
    <Page testId="ops-clients-page">
      <PageHeader
        title="Clients"
        subtitle={
          state.data ? clientsLine(state.data.clients) : "Clients you serve and their agents."
        }
        actions={<NewClientLink />}
      />
      <Loaded state={state}>{(data) => <ClientRows clients={data.clients} />}</Loaded>
    </Page>
  );
}

export function NewClientLink() {
  return (
    <Link to="/ops/clients/new" className={buttonClass("primary")} data-testid="ops-new-client">
      New client
    </Link>
  );
}

const since = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });

function ClientRows({ clients }: { clients: Clients }) {
  if (clients.length === 0) return <EmptyState>No clients yet.</EmptyState>;
  return (
    <div className="dt dt-ana overflow-x-auto">
      <table data-testid="ops-clients-table">
        <thead>
          <tr className="dt-cols">
            <th>Client</th>
            <th className="n">Agents</th>
            <th className="n">Open items</th>
            <th>Timezone</th>
            <th>Client since</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="flex flex-wrap items-center gap-2">
                  <Link
                    to={OPS_PATHS.client(c.id)}
                    data-testid={`ops-client-${c.id}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {c.name}
                  </Link>
                  {c.sandbox ? <Tag>Sandbox</Tag> : null}
                </span>
              </td>
              <td className="n">{c.agents}</td>
              <td className="n" data-testid={`ops-client-open-${c.id}`}>
                {c.openInbox}
              </td>
              <td className="text-ink-muted">{c.timezone}</td>
              <td className="text-ink-muted">{since(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
