// `/ops/clients`: every client the operator serves (the sidebar's "All N clients"), in the
// prototype's back-office style: a line of totals, then one row per client with its agents, what
// needs us there and its runs waiting for approval, and when it started. Each row opens the client
// page. "Needs us" is the command center's count for the client (the sidebar's badge reads the same
// field), and its figure links to Escalations for that client; waiting runs link to its runs.
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { useApi } from "../../api/useApi";
import { Loaded, Page } from "../../ui/page";
import { buttonClass, EmptyState, PageHeader, Tag } from "../../ui/primitives";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";

type Clients = ResponseOf<typeof apiRoutes.opsClients>["clients"];

/** "4 clients · 9 agents · 2 need us · 1 run waiting for approval". */
export function clientsLine(clients: Clients): string {
  const agents = clients.reduce((n, c) => n + c.agents, 0);
  const needs = clients.reduce((n, c) => n + (c.needsUs ?? 0), 0);
  const waiting = clients.reduce((n, c) => n + (c.waitingRuns ?? 0), 0);
  return [
    `${clients.length} ${clients.length === 1 ? "client" : "clients"}`,
    `${agents} ${agents === 1 ? "agent" : "agents"}`,
    needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} us` : "nothing needs us",
    waiting > 0 ? `${waiting} ${waiting === 1 ? "run" : "runs"} waiting for approval` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
            <th className="n">Needs us</th>
            <th className="n">Waiting for approval</th>
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
              <td className="n" data-testid={`ops-client-needs-${c.id}`}>
                {c.needsUs ? (
                  <Link
                    to={`${OPS_PATHS.escalations}?client=${c.id}`}
                    className="text-link hover:underline"
                  >
                    {c.needsUs}
                  </Link>
                ) : (
                  0
                )}
              </td>
              <td className="n" data-testid={`ops-client-waiting-${c.id}`}>
                {c.waitingRuns ? (
                  <Link
                    to={runsLink({ clients: [c.id], statuses: ["waiting"], mode: "live" })}
                    className="text-link hover:underline"
                  >
                    {c.waitingRuns}
                  </Link>
                ) : (
                  0
                )}
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
