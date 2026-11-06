// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Every screen reads in the session's language (docs/plan.md §1.18). The
// sidebar follows the owner's prototype (docs/ui-plan.md, "Client portal"); the routes live in
// ./routes.tsx.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { NavLink, Route, Routes, useLocation, useMatch } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/i18n";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarAgent, SidebarLink, SidebarMore, SidebarSection } from "../shell/Shell";
import { portalSearchGroups } from "../shell/searchGroups";
import { AgentBadge, PersonBadge } from "../ui/badges";
import { Placeholder } from "../ui/primitives";
import { INBOX_COUNT_POLL_MS, InboxCountProvider } from "./inboxCount";
import { PORTAL_PATHS } from "./paths";
import { portalRoutes } from "./routes";

const SERVICE_STATUS = {
  active: "service.status.active",
  paused: "service.status.paused",
  draft: "service.status.draft",
  retired: "service.status.retired",
} as const satisfies Record<string, MessageKey>;

export function PortalLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
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
      portalSearchGroups(await api.call(apiRoutes.portalSearch, { query: { q }, signal }), t),
    [api, t],
  );
  const status = (s: string) => {
    const key = Object.hasOwn(SERVICE_STATUS, s)
      ? SERVICE_STATUS[s as keyof typeof SERVICE_STATUS]
      : null;
    return key ? t(key) : s;
  };

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
              {/* Each agent's role and what it is doing now aren't served on this route yet: its
                  status stands in (docs/ui-plan.md, Not served yet). */}
              {services.map((s) => (
                <SidebarAgent
                  key={s.id}
                  to={PORTAL_PATHS.agent(s.id)}
                  name={s.name}
                  line={status(s.status)}
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
                // Client users read the directory; the client admin also manages who agents reach.
                to={isAdmin ? PORTAL_PATHS.people : PORTAL_PATHS.directory}
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
              <SidebarLink
                to={PORTAL_PATHS.vault}
                label={t("nav.access")}
                testId="portal-nav-access"
              />
              {isAdmin ? (
                <>
                  <SidebarLink
                    to={PORTAL_PATHS.directory}
                    label={t("nav.directory")}
                    testId="portal-nav-directory"
                  />
                  <SidebarLink
                    to={PORTAL_PATHS.contacts}
                    label={t("nav.contacts")}
                    testId="portal-nav-contacts"
                  />
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
