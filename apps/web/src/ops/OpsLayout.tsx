// The back-office frame (docs/design/screens/1-home.png): the client switcher in the header, and a
// sidebar scoped to the selected client: Home, Inbox, its agents, then Build.
import type { ReactNode } from "react";
import { Link, useMatch, useNavigate } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { useSession } from "../session/session";
import { AppShell, SidebarLink, SidebarSection } from "../shell/Shell";
import { AgentAvatar } from "../ui/primitives";

/** `/ops/clients/:clientId/...`, except the "new client" page. */
export function useSelectedClientId(): string | null {
  const match = useMatch("/ops/clients/:clientId/*");
  const id = match?.params.clientId;
  return id && id !== "new" ? id : null;
}

export function OpsLayout({ children }: { children: ReactNode }) {
  const clientId = useSelectedClientId();
  const base = clientId ? `/ops/clients/${clientId}` : null;

  return (
    <AppShell
      surface="ops"
      home="/ops"
      context={<ClientSwitcher selected={clientId} />}
      inboxTo="/ops/inbox"
      sidebar={
        <nav className="flex flex-col">
          <div className="flex flex-col gap-0.5">
            <SidebarLink to={base ?? "/ops"} label="Home" end testId="ops-nav-home" />
            <SidebarLink to="/ops/inbox" label="Inbox" testId="ops-nav-inbox" />
            {base ? null : (
              <SidebarLink to="/ops/clients" label="Clients" testId="ops-nav-clients" />
            )}
          </div>
          {clientId ? <AgentsSection clientId={clientId} /> : null}
          <SidebarSection label="Build">
            <SidebarLink to="/ops/templates" label="Templates" testId="ops-nav-templates" />
            <SidebarLink to="/ops/skills" label="Skills" testId="ops-nav-skills" />
            <SidebarLink
              to={base ? `${base}/connections` : "/ops/clients"}
              label="Connections"
              testId="ops-nav-connections"
            />
            <SidebarLink to="/ops/runs" label="Runs" testId="ops-nav-runs" />
            <SidebarLink
              to={base ? `${base}/settings` : "/ops/settings"}
              label="Settings"
              testId="ops-nav-settings"
            />
          </SidebarSection>
        </nav>
      }
    >
      {children}
    </AppShell>
  );
}

function ClientSwitcher({ selected }: { selected: string | null }) {
  const session = useSession();
  const navigate = useNavigate();
  // An operator's memberships list the clients they serve, one row per client.
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];

  return (
    <label className="flex items-center gap-2 text-sm text-primary">
      <span className="sr-only">Client</span>
      <select
        data-testid="ops-client-switcher"
        value={selected ?? ""}
        onChange={(e) => navigate(e.target.value ? `/ops/clients/${e.target.value}` : "/ops")}
        className="h-8 max-w-56 rounded-sm border border-transparent bg-card pr-6 text-sm font-medium text-primary hover:border-control"
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgentsSection({ clientId }: { clientId: string }) {
  const { data, error } = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  return (
    <SidebarSection
      label="Agents"
      action={
        <Link to={`/ops/clients/${clientId}/agents/new`} className="text-sm text-link underline">
          + New
        </Link>
      }
    >
      {error ? <p className="px-2.5 text-sm text-secondary">Couldn't load agents.</p> : null}
      {data?.agents.length === 0 ? (
        <p className="px-2.5 text-sm text-secondary">No agents yet.</p>
      ) : null}
      {data?.agents.map((a) => (
        <SidebarLink
          key={a.id}
          to={`/ops/clients/${clientId}/agents/${a.slug}`}
          testId={`ops-nav-agent-${a.slug}`}
        >
          <span className="flex min-w-0 items-center gap-3">
            <AgentAvatar name={a.name} seed={a.slug} />
            <span className="min-w-0">
              <span className="block truncate">{a.name}</span>
              {a.role ? (
                <span className="block truncate text-xs font-normal text-secondary">{a.role}</span>
              ) : null}
            </span>
          </span>
          {a.liveVersionId === null ? (
            <span className="label-caps text-secondary">Draft</span>
          ) : null}
        </SidebarLink>
      ))}
    </SidebarSection>
  );
}
