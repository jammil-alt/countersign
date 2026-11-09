// The back-office client page's frame (docs/ui-plan.md "Client page", drafted in the prototype's
// style for the owner to adjust): the client's name with how many of its agents are live, and five
// tabs: Overview, Agents, Data (Documents, Records), Setup (Connections, Messaging, Directory,
// Knowledge) and Settings. Data and Setup each have a small switch between their pages instead of
// more tabs. Every page keeps its own route (../routes.tsx), so old addresses keep working; each
// renders inside this frame, which loads the client once and hands it down (`useClientPage`). The
// client's runs are on the Runs page, filtered to it, linked from the Overview.
import { goLiveCounts } from "@countersign/core";
import { createContext, type ReactNode, useContext } from "react";
import { Link, useLocation } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { AgentHuesProvider } from "../../ui/badges";
import { Page } from "../../ui/page";
import { ErrorNotice, PageHeader, SubTabs, Tabs, Tag } from "../../ui/primitives";
import { StatusChip } from "../../ui/status";
import { useAgentsChanged } from "../agents/ui";
import { useClientSummary } from "../OpsLayout";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";

export type OpsClient = ResponseOf<typeof apiRoutes.opsClient>;

const ClientPageContext = createContext<ApiState<OpsClient> | null>(null);

/** The client the frame loaded, for a tab's screen. Outside a frame it loads nothing. */
export function useClientPage(): ApiState<OpsClient> {
  const state = useContext(ClientPageContext);
  if (!state) throw new Error("useClientPage outside a ClientFrame");
  return state;
}

export type ClientTabId = "overview" | "agents" | "data" | "setup" | "packs" | "settings";

/**
 * The six tabs. `pages`: the addresses under `/ops/clients/:clientId` each tab owns, the first
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
      // The ledger per accounting connection (docs/plan.md §1.79).
      ["ledger", "Chart of accounts"],
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
  // P-1: the business areas switched on for the client; their reports open under it.
  { id: "packs", label: "Packs", pages: [["packs", "Packs"]] },
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
  if (first === "reports") return { tab: "packs", page: "packs" };
  for (const tab of CLIENT_TABS) {
    if (tab.pages.some(([p]) => p === first)) return { tab: tab.id, page: first };
  }
  return { tab: "overview", page: "" };
}

/**
 * "2 of 3 agents live · 1 in trial": a template's test copies don't count. "Live" is core's
 * `isLiveAgent` (switched on, at the live stage), as the command center counts it (fix 4 of the
 * design pass: it read "live" for any published version, even one still on the bench).
 */
export function clientLine(data: OpsClient): string {
  const agents = data.agents.filter((a) => !a.testCopy);
  const n = goLiveCounts(agents.map((a) => ({ runStatus: a.runStatus, stage: a.stage })));
  return [
    `${n.live} of ${agents.length} ${agents.length === 1 ? "agent" : "agents"} live`,
    n.trial > 0 ? `${n.trial} in trial` : null,
    n.signoff > 0 ? `${n.signoff} in sign-off` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The client's slim KPI line under its name (design pass): agents live, live runs in the last 7
 * days, Needs us (risk) and runs waiting for approval (signal), the last two as chips with their
 * words and links to their lists, left out at 0; then the client's time zone.
 */
export function ClientKpiLine({ data }: { data: OpsClient }) {
  const summary = useClientSummary(data.client.id);
  const activity = data.activity;
  const runs7d = activity?.reduce((n, a) => n + a.runs7d, 0);
  const needsUs = summary?.needsUs ?? 0;
  const waiting = summary?.waitingRuns ?? 0;
  const words = [
    clientLine(data),
    runs7d !== undefined ? `${runs7d} live ${runs7d === 1 ? "run" : "runs"} in 7 days` : null,
    data.client.timezone,
  ].filter(Boolean);
  return (
    <span className="ui-kpiline" data-testid="ops-client-kpis">
      <span data-testid="ops-client-line">{words.join(" · ")}</span>
      {needsUs > 0 ? (
        <Link to={OPS_PATHS.escalations} data-testid="ops-client-needs-us">
          <StatusChip state="blocked">Needs us {needsUs}</StatusChip>
        </Link>
      ) : null}
      {waiting > 0 ? (
        <Link
          to={runsLink({ statuses: ["waiting"], mode: "live", clients: [data.client.id] })}
          data-testid="ops-client-approvals"
        >
          <StatusChip state="waiting">{waiting} waiting for approval</StatusChip>
        </Link>
      ) : null}
    </span>
  );
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
      <AgentHuesProvider agents={data?.agents ?? []}>
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
              subtitle={data ? <ClientKpiLine data={data} /> : undefined}
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
      </AgentHuesProvider>
    </ClientPageContext.Provider>
  );
}
