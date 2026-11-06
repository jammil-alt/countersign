// The back-office client page's frame (docs/ui-plan.md "Client page", drafted in the prototype's
// style for the owner to adjust): the client's name with how many of its agents are live, a Runs
// link, and the tabs Overview, Agents, Connections, Messaging, Knowledge, Directory, Documents,
// Records, Settings and Exports. Every tab is its own route (../routes.tsx); each tab's screen
// renders inside this frame, which loads the client once and hands it down (`useClientPage`).
// Per-client runs keep their own page (UI-2a); the frame only links to it.
import { createContext, type ReactNode, useContext } from "react";
import { Link } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { Page } from "../../ui/page";
import { buttonClass, ErrorNotice, PageHeader, Tabs, Tag } from "../../ui/primitives";
import { useAgentsChanged } from "../agents/ui";
import { OPS_PATHS } from "../paths";

export type OpsClient = ResponseOf<typeof apiRoutes.opsClient>;

const ClientPageContext = createContext<ApiState<OpsClient> | null>(null);

/** The client the frame loaded, for a tab's screen. Outside a frame it loads nothing. */
export function useClientPage(): ApiState<OpsClient> {
  const state = useContext(ClientPageContext);
  if (!state) throw new Error("useClientPage outside a ClientFrame");
  return state;
}

/** Where each tab lives, under `/ops/clients/:clientId`. */
export const CLIENT_TABS = [
  ["", "Overview"],
  ["agents", "Agents"],
  ["connections", "Connections"],
  ["messaging", "Messaging"],
  ["knowledge", "Knowledge"],
  ["directory", "Directory"],
  ["documents", "Documents"],
  ["records", "Records"],
  ["settings", "Settings"],
  ["exports", "Exports"],
] as const;

export function clientTabPath(clientId: string, tab: (typeof CLIENT_TABS)[number][0]): string {
  const base = OPS_PATHS.client(clientId);
  return tab ? `${base}/${tab}` : base;
}

/** "2 of 3 agents live · America/Chicago": a template's test copies don't count. */
export function clientLine(data: OpsClient): string {
  const agents = data.agents.filter((a) => !a.testCopy);
  const live = agents.filter((a) => a.liveVersionId !== null).length;
  return `${live} of ${agents.length} ${agents.length === 1 ? "agent" : "agents"} live · ${data.client.timezone}`;
}

export function ClientFrame({
  clientId,
  intro,
  actions,
  children,
}: {
  clientId: string;
  /** What this tab is for, in a line under the tabs. */
  intro?: ReactNode;
  /** Buttons beside the client's name, before Runs. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  useAgentsChanged(client.reload);
  const data = client.data;
  const sandbox = data?.client.settings.sandbox === true;

  return (
    <ClientPageContext.Provider value={client}>
      <Page testId="ops-client-page">
        <div>
          <PageHeader
            eyebrow={
              <Link to={OPS_PATHS.clients} className="hover:underline">
                Clients
              </Link>
            }
            title={data?.client.name ?? "Client"}
            badge={sandbox ? <Tag>Sandbox</Tag> : null}
            subtitle={data ? clientLine(data) : undefined}
            actions={
              <>
                {actions}
                <Link
                  to={`${OPS_PATHS.client(clientId)}/runs`}
                  className={buttonClass("secondary")}
                  data-testid="ops-client-runs"
                >
                  Runs
                </Link>
              </>
            }
          />
          {client.error ? <ErrorNotice error={client.error} onRetry={client.reload} /> : null}
          {/* Ten tabs: they scroll sideways at phone width instead of wrapping. */}
          <div className="overflow-x-auto" data-testid="ops-client-tabs">
            <div className="min-w-max">
              <Tabs
                items={CLIENT_TABS.map(([tab, label]) => ({
                  to: clientTabPath(clientId, tab),
                  label,
                  end: tab === "",
                }))}
              />
            </div>
          </div>
          {intro ? <p className="mt-4 text-ink-muted">{intro}</p> : null}
        </div>
        {children}
      </Page>
    </ClientPageContext.Provider>
  );
}
