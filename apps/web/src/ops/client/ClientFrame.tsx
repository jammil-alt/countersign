// The back-office client page's frame (docs/ui-plan.md "Client page", drafted in the prototype's
// style for the owner to adjust): the client's name with how many of its agents are live, and five
// tabs: Overview, Agents, Data (Documents, Records), Setup (Connections, Messaging, Directory,
// Knowledge) and Settings. Data and Setup each have a small switch between their pages instead of
// more tabs. Every page keeps its own route (../routes.tsx), so old addresses keep working; each
// renders inside this frame, which loads the client once and hands it down (`useClientPage`). The
// client's runs are on the Runs page, filtered to it, linked from the Overview.
import { createContext, type ReactNode, useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { Page } from "../../ui/page";
import { ErrorNotice, PageHeader, SubTabs, Tabs, Tag } from "../../ui/primitives";
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

export type ClientTabId = "overview" | "agents" | "data" | "setup" | "settings";

/**
 * The five tabs. `pages`: the addresses under `/ops/clients/:clientId` each tab owns, the first
 * its own; a tab with more than one page shows the switch between them.
 */
export const CLIENT_TABS: {
  id: ClientTabId;
  label: string;
  pages: readonly (readonly [string, string])[];
}[] = [
  { id: "overview", label: "Overview", pages: [["", "Overview"]] },
  { id: "agents", label: "Agents", pages: [["agents", "Agents"]] },
  {
    id: "data",
    label: "Data",
    pages: [
      ["documents", "Documents"],
      ["records", "Records"],
    ],
  },
  {
    id: "setup",
    label: "Setup",
    pages: [
      ["connections", "Connections"],
      ["messaging", "Messaging"],
      ["directory", "Directory"],
      ["knowledge", "Knowledge"],
    ],
  },
  // The old Exports tab is a section of Settings now.
  { id: "settings", label: "Settings", pages: [["settings", "Settings"]] },
];

/** `/ops/clients/:clientId/<page>`, or the Overview's address for "". */
export function clientPagePath(clientId: string, page: string): string {
  const base = OPS_PATHS.client(clientId);
  return page ? `${base}/${page}` : base;
}

/** The tab and page an address under the client is on: `records/…` is Data's Records. */
export function clientPageOf(
  pathname: string,
  clientId: string,
): { tab: ClientTabId; page: string } {
  const base = OPS_PATHS.client(clientId);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : "";
  const first = rest.split("/")[0] ?? "";
  if (first === "exports") return { tab: "settings", page: "settings" };
  for (const tab of CLIENT_TABS) {
    if (tab.pages.some(([p]) => p === first)) return { tab: tab.id, page: first };
  }
  return { tab: "overview", page: "" };
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
  /** What this page is for, in a line under the tabs. */
  intro?: ReactNode;
  /** Buttons beside the client's name. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  useAgentsChanged(client.reload);
  const { pathname } = useLocation();
  const data = client.data;
  const sandbox = data?.client.settings.sandbox === true;
  const at = clientPageOf(pathname, clientId);
  const tab = CLIENT_TABS.find((t) => t.id === at.tab);

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
            actions={actions}
          />
          {client.error ? <ErrorNotice error={client.error} onRetry={client.reload} /> : null}
          <div data-testid="ops-client-tabs">
            <Tabs
              items={CLIENT_TABS.map((t) => ({
                to: clientPagePath(clientId, t.pages[0]?.[0] ?? ""),
                label: t.label,
                // The tab owns several addresses: the frame says which is current, not the link.
                end: true,
                active: t.id === at.tab,
              }))}
            />
          </div>
          {tab && tab.pages.length > 1 ? (
            <div className="mt-4">
              <SubTabs
                label={tab.label}
                testId={`ops-client-${tab.id}-pages`}
                items={tab.pages.map(([page, label]) => ({
                  to: clientPagePath(clientId, page),
                  label,
                  active: page === at.page,
                  testId: `ops-client-page-${page}`,
                }))}
              />
            </div>
          ) : null}
          {intro ? <p className="mt-4 text-ink-muted">{intro}</p> : null}
        </div>
        {children}
      </Page>
    </ClientPageContext.Provider>
  );
}
