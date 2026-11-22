// The back-office client page's frame (docs/ui-plan.md "Client page", drafted in the prototype's
// style for the owner to adjust): the client's name with how many of its agents are live, and its
// tabs: Overview, Agents, Areas (the business areas, each with the connections it needs and its
// reports; docs/plan.md §1.162), File, Data (Documents, Records, Chart of accounts), Setup
// (Connectors, Messaging, Directory, Knowledge) and Settings. Data and Setup each have a small
// switch between their pages instead of more tabs. Every page keeps its own route (../routes.tsx),
// and old addresses redirect (`packs` to `areas`); each
// renders inside this frame, which loads the client once and hands it down (`useClientPage`). The
// client's runs are on the Runs page, filtered to it, linked from the Overview.
import { clientAgentCounts } from "@countersign/core";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import type { ResponseOf } from "../../api/client";
import { apiRoutes } from "../../api/routes";
import { type ApiState, useApi } from "../../api/useApi";
import { AgentHuesProvider } from "../../ui/badges";
import { Page } from "../../ui/page";
import { buttonClass, ErrorNotice, PageHeader, SubTabs, Tabs, Tag } from "../../ui/primitives";
import { SkeletonLine } from "../../ui/skeleton";
import { StatusChip } from "../../ui/status";
import { useAgentsChanged } from "../agents/ui";
import { useClientSummary } from "../OpsLayout";
import { OPS_PATHS } from "../paths";
import { runsLink } from "../run/links";
import { InviteSheet } from "../work/onboarding/InviteSheet";

export type OpsClient = ResponseOf<typeof apiRoutes.opsClient>;

const ClientPageContext = createContext<ApiState<OpsClient> | null>(null);

/** The client the frame loaded, for a tab's screen. Outside a frame it loads nothing. */
export function useClientPage(): ApiState<OpsClient> {
  const state = useContext(ClientPageContext);
  if (!state) throw new Error("useClientPage outside a ClientFrame");
  return state;
}

export type ClientTabId = "overview" | "agents" | "areas" | "file" | "data" | "setup" | "settings";

/**
 * The seven tabs. `pages`: the addresses under `/ops/clients/:clientId` each tab owns, the first
 * its own; a tab with more than one page shows the switch between them.
 */
export const CLIENT_TABS: {
  id: ClientTabId;
  label: string;
  pages: readonly (readonly [string, string])[];
}[] = [
  // R5 (docs/plan.md §1.235): the client's report, the Overview's second page.
  {
    id: "overview",
    label: "Overview",
    pages: [
      ["", "Overview"],
      ["report", "Report"],
    ],
  },
  { id: "agents", label: "Agents", pages: [["agents", "Agents"]] },
  // §1.162 (owner, 2026-11-20): the business areas switched on for the client (packs in the code),
  // the connections each needs with the client's status; their reports open under it. It was
  // the Packs tab. Each area links to the client's one place for connections,
  // Setup's Connectors (§1.161).
  { id: "areas", label: "Areas", pages: [["areas", "Areas"]] },
  // §1.149: what we know about the client, from the first call on (operator only).
  // §1.217: process interviews with the client's people, beside the file.
  {
    id: "file",
    label: "File",
    pages: [
      ["file", "Client file"],
      ["interviews", "Interviews"],
    ],
  },
  {
    id: "data",
    label: "Data",
    pages: [
      ["documents", "Documents"],
      ["records", "Records"],
      // The ledger per accounting connection (docs/plan.md §1.79).
      ["ledger", "Chart of accounts"],
      // §1.216: what the checks find in the client's QuickBooks.
      ["books-health", "Books health"],
    ],
  },
  {
    id: "setup",
    label: "Setup",
    pages: [
      // docs/setup-plan.md §8 (§1.206): where the client's setup stands, by chapter, first.
      ["progress", "Progress"],
      // Connectors C6: the client's Connectors (its address stays `connections`).
      ["connections", "Connectors"],
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
  // An area's reports, and the old Packs address (it redirects), are Areas'.
  if (first === "reports" || first === "packs") return { tab: "areas", page: "areas" };
  // A connector's own page is under Setup's Connectors.
  if (first === "connectors") return { tab: "setup", page: "connections" };
  for (const tab of CLIENT_TABS) {
    if (tab.pages.some(([p]) => p === first)) return { tab: tab.id, page: first };
  }
  return { tab: "overview", page: "" };
}

/**
 * "2 of 3 agents live · 1 in trial": the client's agents as every count counts them (core
 * `clientAgentCounts`: no template test copies, retired or discarded agents), so the command
 * center's card, the clients list and this line agree. "Live" is core's `isLiveAgent` (switched
 * on, at the live stage; fix 4 of the design pass: it read "live" for any published version).
 */
export function clientLine(data: OpsClient): string {
  const n = clientAgentCounts(data.agents);
  return [
    `${n.live} of ${n.total} ${n.total === 1 ? "agent" : "agents"} live`,
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

/**
 * Where a tab's screen puts its intro and its buttons when the frame is the layout route above it
 * (`ClientLayout`): the frame owns the elements, the screen renders into them through a portal, so
 * the header never remounts on a tab click (docs/audit-plan.md 1.4).
 */
interface FrameSlots {
  clientId: string;
  intro: HTMLElement | null;
  actions: HTMLElement | null;
}

const FrameSlotsContext = createContext<FrameSlots | null>(null);

/**
 * The client page's layout route (`../routes.tsx`): the header, tabs and the client's one load,
 * kept mounted while the tabs change below it in `<Outlet />`.
 */
// DECISION: the frame is a pathless layout route around the tabs' own routes, so every
// `path="…"` line stays as it was (the route sweep reads them). A tab's screen still wraps itself
// in `ClientFrame`; inside the layout that only hands its intro and buttons to the frame's slots,
// so the screens (some in other folders and packs) need no change and still render alone in tests.
export function ClientLayout() {
  const { clientId = "" } = useParams();
  const [intro, setIntro] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const slots = useMemo(() => ({ clientId, intro, actions }), [clientId, intro, actions]);
  return (
    <FrameSlotsContext.Provider value={slots}>
      <FrameView
        clientId={clientId}
        actions={<span ref={setActions} className="contents" />}
        intro={<div ref={setIntro} data-testid="ops-client-intro" />}
      >
        <Outlet />
      </FrameView>
    </FrameSlotsContext.Provider>
  );
}

/**
 * A tab's screen in its frame. Under `ClientLayout` (the app) it renders its content and hands
 * `intro` and `actions` to the layout's header; on its own (a screen test) it draws the frame.
 */
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
  const slots = useContext(FrameSlotsContext);
  if (slots && slots.clientId === clientId) {
    return (
      <>
        {intro && slots.intro
          ? createPortal(<p className="mt-4 text-ink-muted">{intro}</p>, slots.intro)
          : null}
        {actions && slots.actions ? createPortal(actions, slots.actions) : null}
        {children}
      </>
    );
  }
  return (
    <FrameView
      clientId={clientId}
      actions={actions}
      intro={intro ? <p className="mt-4 text-ink-muted">{intro}</p> : null}
    >
      {children}
    </FrameView>
  );
}

function FrameView({
  clientId,
  intro,
  actions,
  children,
}: {
  clientId: string;
  intro?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const client = useApi(apiRoutes.opsClient, { params: { id: clientId } });
  useAgentsChanged(client.reload);
  const { pathname } = useLocation();
  // The title at once from the frame's clients list (the session's client names), before the
  // client itself has loaded (1.4).
  const summary = useClientSummary(clientId);
  const data = client.data;
  const sandbox = (data?.client.settings.sandbox ?? summary?.sandbox) === true;
  const name = data?.client.name ?? summary?.name;
  const at = clientPageOf(pathname, clientId);
  const tab = CLIENT_TABS.find((t) => t.id === at.tab);
  // §1.149: Invite from the client page: more people, or an intake for an expansion or a new area.
  const [inviting, setInviting] = useState(false);

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
              title={
                name ?? (
                  <span data-testid="ops-client-title-skeleton">
                    <SkeletonLine size="title" width={240} />
                  </span>
                )
              }
              badge={sandbox ? <Tag>Sandbox</Tag> : null}
              subtitle={
                data ? (
                  <ClientKpiLine data={data} />
                ) : client.error ? undefined : (
                  <SkeletonLine width={320} />
                )
              }
              actions={
                <>
                  {/* docs/plan.md §1.101: a conversation with Reggie about this client. */}
                  <Link
                    to={OPS_PATHS.askReggie(clientId)}
                    className={buttonClass("ghost")}
                    data-testid="ops-client-ask-reggie"
                  >
                    Ask Reggie
                  </Link>
                  <button
                    type="button"
                    className={buttonClass("ghost")}
                    onClick={() => setInviting(true)}
                    data-testid="ops-client-intake-invite"
                  >
                    Invite
                  </button>
                  {actions}
                </>
              }
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
            {intro}
          </div>
          {children}
          {inviting ? (
            <InviteSheet
              setup={{
                target: { clientId },
                name: name ?? "the client",
                people: [],
                existingClient: true,
              }}
              onClose={() => setInviting(false)}
            />
          ) : null}
        </Page>
      </AgentHuesProvider>
    </ClientPageContext.Provider>
  );
}
