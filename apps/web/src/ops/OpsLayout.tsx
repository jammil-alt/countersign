// The back-office frame (docs/design/prototype.html, `#O1-Command`): "Back office" and the client
// switcher in the top bar, ⌘K search across the clients served, Escalations with its count; a
// sidebar with the command center, the clients (each with what needs us), Build and Business, and
// a folded "More" for the pages the prototype's sidebar leaves out. With a client selected, its
// own pages and agents follow its row.
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { INBOX_COUNT_POLL_MS } from "../portal/inboxCount";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarAgent, SidebarLink, SidebarMore, SidebarSection } from "../shell/Shell";
import { opsSearchGroups } from "../shell/searchGroups";
import { AgentBadge } from "../ui/badges";
import { Icon } from "../ui/icons";
import { useAgentsChanged } from "./agents/ui";
import { OPS_PATHS } from "./paths";

/** The most clients the sidebar lists; "All N clients" opens the rest. */
export const SIDEBAR_CLIENTS = 8;

/** `/ops/clients/:clientId/...`, except the "new client" page. */
export function useSelectedClientId(): string | null {
  const match = useMatch("/ops/clients/:clientId/*");
  const id = match?.params.clientId;
  return id && id !== "new" ? id : null;
}

export function OpsLayout({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useApiClient();
  const clientId = useSelectedClientId();
  const base = clientId ? OPS_PATHS.client(clientId) : null;

  // The clients served: the API's list, the session's memberships until it loads.
  const clientsState = useApi(apiRoutes.opsClients);
  const clients = useMemo(
    () =>
      clientsState.data?.clients ?? [...new Map(session.tenants.map((t) => [t.id, t])).values()],
    [clientsState.data, session.tenants],
  );

  // Escalations: the operator's open items, counted in all and per client. Reloads on each page
  // change and every 20 s, as the portal's Desk count does.
  const inbox = useApi(apiRoutes.opsInbox, { query: { status: "open", assigned: "operator" } });
  const { pathname } = useLocation();
  const { reload: reloadInbox } = inbox;
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    reloadInbox();
  }, [pathname, reloadInbox]);
  usePoll(reloadInbox, true, INBOX_COUNT_POLL_MS, inbox.loading);
  const perClient = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of inbox.data?.items ?? []) {
      counts.set(item.tenantId, (counts.get(item.tenantId) ?? 0) + 1);
    }
    return counts;
  }, [inbox.data]);

  // The selected client's agents: its sidebar rows and the agent switcher.
  const client = useApi(apiRoutes.opsClient, clientId ? { params: { id: clientId } } : null);
  useAgentsChanged(client.reload);
  const agentMatch = useMatch("/ops/clients/:clientId/agents/:slug/*");
  const agentSlug = agentMatch?.params.slug !== "new" ? agentMatch?.params.slug : undefined;

  const search: SearchRun = useCallback(
    async (q, signal) =>
      opsSearchGroups(await api.call(apiRoutes.opsSearch, { query: { q }, signal }), clients, q),
    [api, clients],
  );

  const listed = clients.slice(0, SIDEBAR_CLIENTS);
  const selected = clients.find((c) => c.id === clientId);

  return (
    <>
      <AppShell
        surface="ops"
        home="/ops"
        place="Back office"
        context={
          <>
            <span>Back office</span>
            <ClientSwitcher selected={clientId} clients={clients} />
          </>
        }
        search={{ placeholder: "Find a client, agent, run or record", run: search }}
        desk={{ to: OPS_PATHS.escalations, label: "Escalations", count: inbox.data?.items.length }}
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
                label="Command center"
                end
                testId="ops-nav-home"
              />
              <SidebarLink
                to={OPS_PATHS.escalations}
                icon="desk"
                label="Escalations"
                count={inbox.data?.items.length}
                testId="ops-nav-inbox"
              />
              <SidebarLink
                to={OPS_PATHS.runs}
                icon="report"
                label="Runs"
                end
                testId="ops-nav-runs"
              />
            </div>
            <SidebarSection
              label="Clients"
              testId="ops-nav-clients-section"
              action={
                <Link to="/ops/clients/new" className="ds-btn ds-btn--link gap-1 text-xs">
                  <Icon name="add" size={14} />
                  New
                </Link>
              }
            >
              {listed.map((c) => (
                <SidebarLink
                  key={c.id}
                  to={OPS_PATHS.client(c.id)}
                  label={c.name}
                  end
                  count={inbox.data ? (perClient.get(c.id) ?? 0) : undefined}
                  testId={`ops-nav-client-${c.id}`}
                />
              ))}
              <Link
                to={OPS_PATHS.clients}
                data-testid="ops-nav-clients"
                className="px-2.5 py-1.5 text-sm text-ink-muted hover:text-ink"
              >
                {`All ${clients.length} clients`}
              </Link>
            </SidebarSection>
            {base && clientId ? (
              <SidebarSection label={selected?.name ?? "Client"} testId="ops-nav-client-section">
                <SidebarLink
                  to={`${base}/documents`}
                  label="Documents"
                  testId="ops-nav-documents"
                />
                <SidebarLink to={`${base}/records`} label="Records" testId="ops-nav-records" />
                <SidebarLink
                  to={`${base}/connections`}
                  label="Connections"
                  testId="ops-nav-connections"
                />
                <SidebarLink to={`${base}/settings`} label="Settings" testId="ops-nav-settings" />
                <AgentRows clientId={clientId} state={client} selected={agentSlug} />
              </SidebarSection>
            ) : null}
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
                label="Skills and automations"
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
              <SidebarLink
                to={OPS_PATHS.feedback}
                icon="message"
                label="Feedback"
                testId="ops-nav-feedback"
              />
            </SidebarSection>
            <SidebarMore label="More" testId="ops-nav-more">
              <SidebarLink to={OPS_PATHS.requests} label="Requests" testId="ops-nav-requests" />
              <SidebarLink to={OPS_PATHS.billing} label="Billing" testId="ops-nav-billing" />
              <SidebarLink
                to={OPS_PATHS.browserSites}
                label="Website logins"
                testId="ops-nav-browser-sites"
              />
              <SidebarLink to={OPS_PATHS.audit} label="Audit log" testId="ops-nav-audit" />
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

function ClientSwitcher({
  selected,
  clients,
}: {
  selected: string | null;
  clients: readonly { id: string; name: string }[];
}) {
  const navigate = useNavigate();
  return (
    <label className="ds-selectwrap flex items-center">
      <span className="sr-only">Client</span>
      <select
        data-testid="ops-client-switcher"
        value={selected ?? ""}
        onChange={(e) => navigate(e.target.value ? OPS_PATHS.client(e.target.value) : "/ops")}
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

function AgentRows({
  clientId,
  state,
  selected,
}: {
  clientId: string;
  state: ReturnType<typeof useApi<typeof apiRoutes.opsClient>>;
  /** The agent whose page is open: its Workflow and Triggers (UI-2c) show under its row. */
  selected?: string | undefined;
}) {
  const { data, error } = state;
  return (
    <>
      <div className="mt-3 mb-1 flex items-center justify-between px-2.5">
        <h3 className="eyebrow text-ink-muted">Agents</h3>
        <Link to={OPS_PATHS.newAgent(clientId)} className="ds-btn ds-btn--link gap-1 text-xs">
          <Icon name="add" size={14} />
          New
        </Link>
      </div>
      {error ? <p className="px-2.5 text-sm text-ink-muted">Couldn't load agents.</p> : null}
      {data?.agents.length === 0 ? (
        <p className="px-2.5 text-sm text-ink-muted">No agents yet.</p>
      ) : null}
      {data?.agents.map((a) => (
        <Fragment key={a.id}>
          <SidebarAgent
            to={OPS_PATHS.agent(clientId, a.slug)}
            name={a.name}
            line={[a.role, a.liveVersionId === null ? "Draft" : null].filter(Boolean).join(" · ")}
            badge={<AgentBadge name={a.name} size="sm" />}
            testId={`ops-nav-agent-${a.slug}`}
          />
          {a.slug === selected ? (
            <div className="ml-6 flex flex-col gap-0.5">
              <SidebarLink
                to={OPS_PATHS.agentWorkflow(clientId, a.slug)}
                label="Workflow"
                testId="ops-nav-agent-workflow"
              />
              <SidebarLink
                to={OPS_PATHS.agentTriggers(clientId, a.slug)}
                label="Triggers"
                testId="ops-nav-agent-triggers"
              />
            </div>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}
