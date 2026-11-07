// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Every screen reads in the session's language (docs/plan.md §1.18). The
// sidebar follows the owner's prototype (docs/ui-plan.md, "Client portal"); the routes live in
// ./routes.tsx.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { NavLink, Route, Routes, useLocation, useMatch } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { useI18n } from "../i18n/i18n";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import {
  AppShell,
  SidebarAgent,
  SidebarAgentSkeleton,
  SidebarLink,
  SidebarMore,
  SidebarSection,
} from "../shell/Shell";
import { portalSearchGroups } from "../shell/searchGroups";
import { AgentBadge, PersonBadge } from "../ui/badges";
import { Placeholder } from "../ui/primitives";
import { INBOX_COUNT_POLL_MS, InboxCountProvider } from "./inboxCount";
import { PORTAL_PATHS } from "./paths";
import { portalRoutes } from "./routes";
import { agentChip } from "./status";

/** Sidebar skeleton rows while the agents load: as many as last time (this browser), else one. */
// DECISION: the count of agents last shown is kept per client in this browser only, so the
// sidebar keeps its height on a full load; it is a convenience, never read for anything else.
function agentRowsKey(clientId: string | undefined): string {
  return `mz.portal.agentRows.${clientId ?? ""}`;
}
function rememberedAgentRows(clientId: string | undefined): number {
  try {
    const n = Number(window.localStorage.getItem(agentRowsKey(clientId)));
    return Number.isInteger(n) && n > 0 ? Math.min(n, 8) : 1;
  } catch {
    return 1;
  }
}
function rememberAgentRows(clientId: string | undefined, n: number): void {
  try {
    window.localStorage.setItem(agentRowsKey(clientId), String(n));
  } catch {
    // Private windows and blocked storage: the skeleton shows one row.
  }
}

export function PortalLayout({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const api = useApiClient();
  const client =
    session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  const isAdmin = client?.role === "client_admin";
  // The Desk's count and the agents list; the Table reads the same route for its own panel.
  // DECISION: the count reloads on each page change, every 20 s and after a resolve (it loaded
  // once before, so an approval proposed while the portal was open never showed in it).
  const overview = useApi(apiRoutes.portalOverview);
  const { pathname } = useLocation();
  const { reload: reloadOverview } = overview;
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    reloadOverview();
  }, [pathname, reloadOverview]);
  usePoll(reloadOverview, true, INBOX_COUNT_POLL_MS, overview.loading);
  // The operator switches the Feedback button on per client; off, there is no button.
  const feedback = useApi(apiRoutes.portalFeedbackStatus);
  const services = overview.data?.services ?? [];
  const agentMatch = useMatch("/agents/:id/*");

  const search: SearchRun = useCallback(
    async (q, signal) =>
      portalSearchGroups(await api.call(apiRoutes.portalSearch, { query: { q }, signal }), t, i18n),
    [api, t, i18n],
  );
  const loaded = overview.data !== undefined;
  useEffect(() => {
    if (loaded) rememberAgentRows(client?.id, services.length);
  }, [loaded, client?.id, services.length]);

  return (
    <>
      <AppShell
        surface="portal"
        home="/"
        place={client?.name ?? null}
        context={
          <span data-testid="portal-client-name">{client?.name ?? t("shell.noClient")}</span>
        }
        search={{
          placeholder: t("shell.searchPlaceholder"),
          run: search,
          ask: {
            label: (q) => t("shell.askSloan", { q }),
            href: (q) => `${PORTAL_PATHS.sloan}?ask=${encodeURIComponent(q)}`,
          },
        }}
        desk={{
          to: PORTAL_PATHS.desk,
          label: t("shell.desk"),
          count: overview.data?.needsYou.inbox,
          // QA round 1: the badge's slot is kept while the count loads (no shift).
          reserve: true,
        }}
        pageBar={
          agentMatch?.params.id ? (
            <AgentSwitcher
              current={agentMatch.params.id}
              agents={services.map((s) => ({
                key: s.id,
                name: s.name,
                href: PORTAL_PATHS.agent(s.id),
              }))}
            />
          ) : null
        }
        sidebar={
          <nav className="flex flex-col">
            <div className="flex flex-col gap-0.5">
              <SidebarLink
                to={PORTAL_PATHS.table}
                icon="table"
                label={t("nav.table")}
                end
                testId="portal-nav-table"
              />
              <SidebarLink
                to={PORTAL_PATHS.desk}
                icon="desk"
                label={t("nav.desk")}
                count={overview.data?.needsYou.inbox}
                reserveCount
                testId="portal-nav-desk"
              />
              <SidebarLink
                to={PORTAL_PATHS.runs}
                icon="report"
                label={t("nav.runs")}
                testId="portal-nav-runs"
              />
            </div>
            <SidebarSection label={t("nav.yourAgents")} testId="portal-nav-agents">
              {overview.data && services.length === 0 ? (
                <p className="px-2.5 text-sm text-ink-muted">{t("nav.noAgents")}</p>
              ) : null}
              {/* QA round 1: skeleton rows hold the list's place while it loads (no shift). */}
              {loaded ? null : <SidebarAgentSkeleton rows={rememberedAgentRows(client?.id)} />}
              {/* Each agent's role isn't served on this route yet; its state (the status model,
                  ./status.ts) is its line (docs/ui-plan.md, Not served yet). */}
              {services.map((s) => (
                <SidebarAgent
                  key={s.id}
                  to={PORTAL_PATHS.agent(s.id)}
                  name={s.name}
                  line={agentChip(s, t).label}
                  badge={<AgentBadge name={s.name} size="sm" />}
                  testId={`portal-nav-agent-${s.id}`}
                />
              ))}
            </SidebarSection>
            <SidebarSection label={t("nav.yourBusiness")}>
              <SidebarLink
                to={PORTAL_PATHS.weekly}
                icon="weekly-table"
                label={t("nav.weekly")}
                testId="portal-nav-weekly"
              />
              <SidebarLink
                to={PORTAL_PATHS.accounts}
                icon="bank"
                label={t("nav.accounts")}
                testId="portal-nav-accounts"
              />
              <SidebarLink
                // Everyone reads it; the client admin also edits it (consent, reach, voice).
                to={PORTAL_PATHS.people}
                icon="team"
                label={t("nav.people")}
                testId="portal-nav-people"
              />
              {/* Everyone has settings of their own (notifications, language); the admin, all. */}
              <SidebarLink
                to={PORTAL_PATHS.settings}
                icon="settings"
                label={t("nav.settings")}
                testId="portal-nav-settings"
              />
            </SidebarSection>
            <SidebarMore label={t("nav.more")} testId="portal-nav-more">
              {/* UI-3a */}
              <SidebarLink
                to={PORTAL_PATHS.upload}
                label={t("nav.upload")}
                testId="portal-nav-upload"
              />
              <SidebarLink
                to={PORTAL_PATHS.reports}
                label={t("nav.reports")}
                testId="portal-nav-reports"
              />
              <SidebarLink
                to={PORTAL_PATHS.records}
                label={t("nav.records")}
                testId="portal-nav-records"
              />
              <SidebarLink
                to={PORTAL_PATHS.requests}
                label={t("nav.requests")}
                testId="portal-nav-requests"
              />
              {/* The vault, the directory and contacts live on Accounts and People (UI-1c). */}
              {isAdmin ? (
                <>
                  <SidebarLink
                    to={PORTAL_PATHS.knowledge}
                    label={t("nav.knowledge")}
                    testId="portal-nav-knowledge"
                  />
                  {/* v0.14 capture */}
                  <SidebarLink
                    to={PORTAL_PATHS.conversations}
                    label={t("nav.conversations")}
                    testId="portal-nav-conversations"
                  />
                  <SidebarLink
                    to={PORTAL_PATHS.billing}
                    label={t("nav.billing")}
                    testId="portal-nav-billing"
                  />
                </>
              ) : null}
            </SidebarMore>
          </nav>
        }
        sidebarFooter={
          <div className="flex flex-col gap-2">
            <NavLink
              to={PORTAL_PATHS.sloan}
              className="ui-sloancard"
              data-testid="portal-nav-sloan"
            >
              <AgentBadge name="Sloan" size="sm" />
              <span className="min-w-0">
                <span className="block font-medium text-ink">{t("nav.sloan")}</span>
                <span className="block text-sm text-ink-muted">{t("nav.sloanLine")}</span>
              </span>
            </NavLink>
            {session.lead ? (
              <div className="px-2.5 py-1.5" data-testid="portal-lead">
                <PersonBadge name={session.lead.name} line={t("nav.lead")} />
              </div>
            ) : null}
          </div>
        }
      >
        <InboxCountProvider refresh={reloadOverview}>{children}</InboxCountProvider>
      </AppShell>
      {feedback.data?.enabled ? <FeedbackButton surface="portal" /> : null}
    </>
  );
}

export function PortalApp() {
  const { t } = useI18n();
  return (
    <PortalLayout>
      <Routes>
        {portalRoutes}
        <Route
          path="*"
          element={
            <Placeholder title={t("common.notFoundTitle")}>{t("common.notFoundBody")}</Placeholder>
          }
        />
      </Routes>
    </PortalLayout>
  );
}
