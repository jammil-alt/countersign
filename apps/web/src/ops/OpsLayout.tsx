// The back-office frame (docs/design/screens/1-home.png): the client switcher in the header, and a
// sidebar scoped to the selected client: Home, Inbox, its agents, then Build.
import type { ReactNode } from "react";
import { Link, useMatch, useNavigate } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { useSession } from "../session/session";
import { AppShell, SidebarLink, SidebarSection } from "../shell/Shell";
import { Icon } from "../ui/icons";
import { AgentAvatar } from "../ui/primitives";
import { useAgentsChanged } from "./agents/ui";

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
    <>
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
              <SidebarLink to="/ops/requests" label="Requests" testId="ops-nav-requests" />
              {base ? (
                <SidebarLink
                  to={`${base}/documents`}
                  label="Documents"
                  testId="ops-nav-documents"
                />
              ) : null}
              {base ? (
                <SidebarLink to={`${base}/records`} label="Records" testId="ops-nav-records" />
              ) : null}
              {base ? null : (
                <SidebarLink to="/ops/clients" label="Clients" testId="ops-nav-clients" />
              )}
            </div>
            {clientId ? <AgentsSection clientId={clientId} /> : null}
            <SidebarSection label="Build">
              <SidebarLink to="/ops/templates" label="Templates" testId="ops-nav-templates" />
              <SidebarLink to="/ops/skills" label="Skills" testId="ops-nav-skills" />
              <SidebarLink
                to="/ops/browser-sites"
                label="Websites"
                testId="ops-nav-browser-sites"
              />
              <SidebarLink
                to={base ? `${base}/connections` : "/ops/clients"}
                label="Connections"
                testId="ops-nav-connections"
              />
              <SidebarLink to="/ops/runs" label="Runs" testId="ops-nav-runs" />
              <SidebarLink to="/ops/usage" label="Usage" testId="ops-nav-usage" />
              <SidebarLink to="/ops/billing" label="Billing" testId="ops-nav-billing" />
              <SidebarLink to="/ops/feedback" label="Feedback" testId="ops-nav-feedback" />
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
      {/* The back office always has the Feedback button. */}
      <FeedbackButton surface="ops" />
    </>
  );
}

function ClientSwitcher({ selected }: { selected: string | null }) {
  const session = useSession();
  const navigate = useNavigate();
  // An operator's memberships list the clients they serve, one row per client.
  const clients = [...new Map(session.tenants.map((t) => [t.id, t])).values()];

  return (
    <label className="ds-selectwrap flex items-center">
      <span className="sr-only">Client</span>
      <select
        data-testid="ops-client-switcher"
        value={selected ?? ""}
        onChange={(e) => navigate(e.target.value ? `/ops/clients/${e.target.value}` : "/ops")}
        className="ds-select h-8 max-w-56 border-transparent bg-transparent pr-8 pl-2 text-sm font-medium hover:border-line-strong"
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

function AgentsSection({ clientId }: { clientId: string }) {
  const { data, error, reload } = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  // The agent screens say when they create or change an agent, so this list follows.
  useAgentsChanged(reload);
  return (
    <SidebarSection
      label="Agents"
      action={
        <Link
          to={`/ops/clients/${clientId}/agents/new`}
          className="ds-btn ds-btn--link gap-1 text-xs"
        >
          <Icon name="add" size={14} />
          New
        </Link>
      }
    >
      {error ? <p className="px-2.5 text-sm text-ink-muted">Couldn't load agents.</p> : null}
      {data?.agents.length === 0 ? (
        <p className="px-2.5 text-sm text-ink-muted">No agents yet.</p>
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
                <span className="block truncate text-xs font-normal text-ink-muted">{a.role}</span>
              ) : null}
            </span>
          </span>
          {a.liveVersionId === null ? <span className="eyebrow text-ink-muted">Draft</span> : null}
        </SidebarLink>
      ))}
    </SidebarSection>
  );
}
