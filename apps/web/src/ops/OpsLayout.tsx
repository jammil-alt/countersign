// The back-office frame (docs/design/prototype.html, `#O1-Command`): "Back office" and the client
// picker in the top bar (the one way to choose a client; it keeps the picked client from page to
// page, ./pickedClient.tsx), ⌘K search across the clients served, Escalations with its count; a
// sidebar that lists places only: Home (the command center), Escalations, Runs, Clients, Build and
// Business, with the business pages the prototype leaves out folded under More. A client's own
// pages are tabs on its page; an agent's are tabs on the agent's page.
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import type { ResponseOf } from "../api/client";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { INBOX_COUNT_POLL_MS } from "../portal/inboxCount";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher, canSwitch } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarLink, SidebarMore, SidebarSection } from "../shell/Shell";
import { opsSearchGroups } from "../shell/searchGroups";
import { Icon } from "../ui/icons";
import { useAgentsChanged } from "./agents/ui";
import { OPS_PATHS } from "./paths";
import { PickedClientProvider, usePickedClient, useRouteClientId } from "./pickedClient";

/** `/ops/clients/:clientId/...`, except the "new client" page. */
export const useSelectedClientId = useRouteClientId;

type ClientSummaryRow = ResponseOf<typeof apiRoutes.opsClients>["clients"][number];

/** The clients list the frame polls (Needs us, waiting runs per client); null until it loads. */
const OpsClientsContext = createContext<readonly ClientSummaryRow[] | null>(null);

/** §1.73: the frame's clients list (with `internal` and `sandbox`); null until it loads. */
export function useOpsClients(): readonly ClientSummaryRow[] | null {
  return useContext(OpsClientsContext);
}

/** One client's row of the frame's clients list: its Needs us and runs waiting for approval. */
export function useClientSummary(clientId: string): ClientSummaryRow | null {
  return useContext(OpsClientsContext)?.find((c) => c.id === clientId) ?? null;
}

/** The badges' counts, as GET /api/ops/counts gives them; null while the sharing page loads. */
type SharedCounts = ResponseOf<typeof apiRoutes.opsCounts> | null;
const ShareCountsContext = createContext<((counts: SharedCounts | undefined) => void) | null>(null);

/**
 * For a page that computes the badges' counts itself (the command center, §1.84): hands them to
 * the frame, which then asks for none of its own while the page is open. `null` while loading.
 */
export function useShareCounts(counts: SharedCounts): void {
  const share = useContext(ShareCountsContext);
  useEffect(() => {
    share?.(counts);
  }, [share, counts]);
  useEffect(() => () => share?.(undefined), [share]);
}

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

  // The clients served: the API's list, the session's memberships until it loads. Loaded once, and
  // again when the session's clients change (a client created). Names only (§1.84): its badges
  // come from the counts below.
  const clientsState = useApi(apiRoutes.opsClients, { query: { view: "names" } });
  const { reload: reloadClients } = clientsState;
  const tenantKey = session.tenants.map((t) => t.id).join(",");
  const firstTenants = useRef(tenantKey);
  useEffect(() => {
    if (tenantKey === firstTenants.current) return;
    firstTenants.current = tenantKey;
    reloadClients();
  }, [tenantKey, reloadClients]);

  // The badges (UI cleanup, stream A): Escalations' count and each client's Needs us and runs
  // waiting, refreshed on each page change and every 20 s, as the portal's Desk count does.
  // DECISION: one Needs us per refresh (docs/plan.md §1.84). A page that computes them already (the
  // command center) hands them over through `useShareCounts`, and the frame asks for nothing while
  // it does; elsewhere the frame asks GET /api/ops/counts. The frame waits for its first effects
  // before asking, so a page that shares is known first and no request is sent for nothing.
  const [shared, setShared] = useState<SharedCounts | undefined>(undefined);
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  const own = settled && shared === undefined;
  const countsState = useApi(apiRoutes.opsCounts, own ? {} : null);
  const { reload: reloadCounts } = countsState;
  const { pathname } = useLocation();
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    if (own) reloadCounts();
  }, [pathname, own, reloadCounts]);
  usePoll(reloadCounts, own, INBOX_COUNT_POLL_MS, countsState.loading);
  const counts = own ? countsState.data : (shared ?? undefined);
  const needsUs = counts?.needsUs;
  const clients = useMemo(() => {
    const rows = clientsState.data?.clients ?? [
      ...new Map(session.tenants.map((t) => [t.id, t])).values(),
    ];
    if (!counts) return rows;
    const byId = new Map(counts.clients.map((c) => [c.id, c]));
    return rows.map((r) => {
      const c = byId.get(r.id);
      return c ? { ...r, needsUs: c.needsUs, waitingRuns: c.waitingRuns } : r;
    });
  }, [clientsState.data, session.tenants, counts]);
  const clientRows = clientsState.data ? (clients as ClientSummaryRow[]) : null;

  // On an agent's page: the client's agents, for the agent switcher.
  const agentMatch = useMatch("/ops/clients/:clientId/agents/:slug/*");
  const agentSlug = agentMatch?.params.slug !== "new" ? agentMatch?.params.slug : undefined;
  const client = useApi(
    apiRoutes.opsClient,
    clientId && agentSlug ? { params: { id: clientId } } : null,
  );
  useAgentsChanged(client.reload);
  // The client's agents by the name the client knows (fix 1 of the design pass): the service
  // name, the bundle's own name only where it has none.
  const switchAgents =
    clientId && client.data
      ? client.data.agents.map((a) => ({
          key: a.slug,
          name: a.serviceName ?? a.name,
          href: `/ops/clients/${clientId}/agents/${a.slug}`,
        }))
      : [];

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
        switcher={
          agentSlug && canSwitch(agentSlug, switchAgents) ? (
            <AgentSwitcher current={agentSlug} agents={switchAgents} />
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
              <SidebarLink
                to={OPS_PATHS.packs}
                icon="price-change"
                label="Packs"
                testId="ops-nav-packs"
              />
            </SidebarSection>
            <SidebarSection label="Business">
              <SidebarLink
                to={OPS_PATHS.usage}
                icon="invoice"
                label="Usage and billing"
                testId="ops-nav-usage"
              />
              {/* §1.73: the Marketing area, opening our own client (Mezonas) with the pack on. */}
              <SidebarLink
                to={OPS_PATHS.marketing}
                icon="message"
                label="Marketing"
                testId="ops-nav-marketing"
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
        <OpsClientsContext.Provider value={clientRows}>
          <ShareCountsContext.Provider value={setShared}>{children}</ShareCountsContext.Provider>
        </OpsClientsContext.Provider>
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
