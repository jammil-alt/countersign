// The back-office frame (docs/design/prototype.html, `#O1-Command`): "Back office" and the client
// picker in the top bar (the one way to choose a client; it keeps the picked client from page to
// page, ./pickedClient.tsx), ⌘K search across the clients served, Escalations with its count; a
// sidebar that lists places only: Home (the command center), Escalations, Runs, Clients, Build and
// Business, with the business pages the prototype leaves out folded under More. A client's own
// pages are tabs on its page; an agent's are tabs on the agent's page.
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { INBOX_COUNT_POLL_MS } from "../portal/inboxCount";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarLink, SidebarMore, SidebarSection } from "../shell/Shell";
import { opsSearchGroups } from "../shell/searchGroups";
import { Icon } from "../ui/icons";
import { useAgentsChanged } from "./agents/ui";
import { OPS_PATHS } from "./paths";
import { PickedClientProvider, usePickedClient, useRouteClientId } from "./pickedClient";

/** `/ops/clients/:clientId/...`, except the "new client" page. */
export const useSelectedClientId = useRouteClientId;

export function OpsLayout({ children }: { children: ReactNode }) {
  return (
    <PickedClientProvider>
      <OpsFrame>{children}</OpsFrame>
    </PickedClientProvider>
  );
}

function OpsFrame({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useApiClient();
  const clientId = useRouteClientId();
  const picked = usePickedClient();

  // The clients served: the API's list, the session's memberships until it loads.
  const clientsState = useApi(apiRoutes.opsClients);
  const clients = useMemo(
    () =>
      clientsState.data?.clients ?? [...new Map(session.tenants.map((t) => [t.id, t])).values()],
    [clientsState.data, session.tenants],
  );

  // Escalations: what needs us (UI cleanup, stream A), from the clients list's `needsUs`, the
  // count the Clients page and the command center show. Reloads on each page change and every
  // 20 s, as the portal's Desk count does.
  const { pathname } = useLocation();
  const { reload: reloadClients } = clientsState;
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    reloadClients();
  }, [pathname, reloadClients]);
  usePoll(reloadClients, true, INBOX_COUNT_POLL_MS, clientsState.loading);
  const needsUs = clientsState.data
    ? clientsState.data.clients.reduce((n, c) => n + (c.needsUs ?? 0), 0)
    : undefined;

  // On an agent's page: the client's agents, for the agent switcher.
  const agentMatch = useMatch("/ops/clients/:clientId/agents/:slug/*");
  const agentSlug = agentMatch?.params.slug !== "new" ? agentMatch?.params.slug : undefined;
  const client = useApi(
    apiRoutes.opsClient,
    clientId && agentSlug ? { params: { id: clientId } } : null,
  );
  useAgentsChanged(client.reload);

  const search: SearchRun = useCallback(
    async (q, signal) =>
      opsSearchGroups(await api.call(apiRoutes.opsSearch, { query: { q }, signal }), clients, q),
    [api, clients],
  );

  return (
    <>
      <AppShell
        surface="ops"
        home="/ops"
        place="Back office"
        context={
          <>
            <span>Back office</span>
            <ClientPicker
              selected={picked.clientId}
              clients={clients}
              onPick={(id) => picked.remember(id)}
            />
          </>
        }
        search={{ placeholder: "Find a client, agent, run or record", run: search }}
        desk={{ to: OPS_PATHS.escalations, label: "Escalations", count: needsUs }}
        pageBar={
          clientId && agentSlug && client.data ? (
            <AgentSwitcher
              current={agentSlug}
              agents={client.data.agents.map((a) => ({
                key: a.slug,
                name: a.name,
                href: `/ops/clients/${clientId}/agents/${a.slug}`,
              }))}
            />
          ) : null
        }
        sidebar={
          <nav className="flex flex-col">
            <div className="flex flex-col gap-0.5">
              <SidebarLink
                to={OPS_PATHS.command}
                icon="table"
                label="Home"
                end
                testId="ops-nav-home"
              />
              <SidebarLink
                to={OPS_PATHS.escalations}
                icon="desk"
                label="Escalations"
                count={needsUs}
                testId="ops-nav-inbox"
              />
              <SidebarLink
                to={OPS_PATHS.runs}
                icon="report"
                label="Runs"
                end
                testId="ops-nav-runs"
              />
              <SidebarLink
                to={OPS_PATHS.clients}
                icon="customer"
                label="Clients"
                testId="ops-nav-clients"
              />
            </div>
            <SidebarSection label="Build">
              <SidebarLink
                to={OPS_PATHS.lab}
                icon="worksheet"
                label="Agent lab"
                testId="ops-nav-lab"
              />
              <SidebarLink
                to={OPS_PATHS.skills}
                icon="document"
                label="Skills"
                testId="ops-nav-skills"
              />
              <SidebarLink
                to={OPS_PATHS.connectors}
                icon="bank"
                label="Connectors"
                testId="ops-nav-connectors"
              />
            </SidebarSection>
            <SidebarSection label="Business">
              <SidebarLink
                to={OPS_PATHS.usage}
                icon="invoice"
                label="Usage and billing"
                testId="ops-nav-usage"
              />
            </SidebarSection>
            <SidebarMore label="More" testId="ops-nav-more">
              <SidebarLink to={OPS_PATHS.feedback} label="Feedback" testId="ops-nav-feedback" />
              <SidebarLink to={OPS_PATHS.audit} label="Audit log" testId="ops-nav-audit" />
              <SidebarLink to={OPS_PATHS.requests} label="Requests" testId="ops-nav-requests" />
              <SidebarLink
                to={OPS_PATHS.browserSites}
                label="Website logins"
                testId="ops-nav-browser-sites"
              />
            </SidebarMore>
          </nav>
        }
      >
        {children}
      </AppShell>
      {/* The back office always has the Feedback button. */}
      <FeedbackButton surface="ops" />
    </>
  );
}

/** The top bar's client picker: picking a client opens its page; "All clients" opens Home. */
function ClientPicker({
  selected,
  clients,
  onPick,
}: {
  selected: string | null;
  clients: readonly { id: string; name: string }[];
  onPick: (id: string | null) => void;
}) {
  const navigate = useNavigate();
  // A remembered client this operator no longer serves shows as all clients.
  const value = selected && clients.some((c) => c.id === selected) ? selected : "";
  return (
    <label className="ds-selectwrap flex items-center">
      <span className="sr-only">Client</span>
      <select
        data-testid="ops-client-switcher"
        value={value}
        onChange={(e) => {
          const id = e.target.value || null;
          onPick(id);
          navigate(id ? OPS_PATHS.client(id) : OPS_PATHS.command);
        }}
        className="ds-select h-8 max-w-56 bg-surface-subtle pr-8 pl-2 text-sm font-medium hover:border-line-strong"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-muted"
      />
    </label>
  );
}
