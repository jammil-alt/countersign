// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Every screen reads in the session's language (docs/plan.md §1.18). The
// sidebar lists places only: Home, Inbox, Runs, Accounts and Contacts (Review 1, approved by the
// owner). The agents are on Home and the agent switcher on an agent's page; Settings and the lead
// are in the avatar menu (Settings also at the sidebar's foot); Sloan is Ask Sloan in the top bar
// and in the search box. The routes live in ./routes.tsx.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Link, NavLink, Route, Routes, useLocation, useMatch } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { useI18n } from "../i18n/i18n";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AgentSwitcher, canSwitch } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarLink } from "../shell/Shell";
import { portalSearchGroups } from "../shell/searchGroups";
import { AgentBadge, AgentHuesProvider, PersonBadge } from "../ui/badges";
import { Placeholder } from "../ui/primitives";
import { INBOX_COUNT_POLL_MS, InboxCountProvider } from "./inboxCount";
import { askSloan, PORTAL_PATHS } from "./paths";
import { portalRoutes } from "./routes";

export function PortalLayout({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const api = useApiClient();
  const client =
    session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  // The Inbox's count and the agents (for the switcher); Home reads the same route.
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
  const switchAgents = services.map((s) => ({
    key: s.id,
    name: s.name,
    href: PORTAL_PATHS.agent(s.id),
  }));
  const agentMatch = useMatch("/agents/:id/*");

  const search: SearchRun = useCallback(
    async (q, signal) =>
      portalSearchGroups(await api.call(apiRoutes.portalSearch, { query: { q }, signal }), t, i18n),
    [api, t, i18n],
  );

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
            href: (q) => askSloan(q),
          },
        }}
        desk={{
          to: PORTAL_PATHS.inbox,
          label: t("nav.inbox"),
          count: overview.data?.needsYou.inbox,
          // QA round 1: the badge's slot is kept while the count loads (no shift).
          reserve: true,
        }}
        switcher={
          agentMatch?.params.id && canSwitch(agentMatch.params.id, switchAgents) ? (
            <AgentSwitcher current={agentMatch.params.id} agents={switchAgents} />
          ) : null
        }
        topAction={<AskSloanButton />}
        sidebar={
          <nav className="flex flex-col gap-0.5">
            <SidebarLink
              to={PORTAL_PATHS.home}
              icon="table"
              label={t("nav.home")}
              end
              testId="portal-nav-home"
            />
            <SidebarLink
              to={PORTAL_PATHS.inbox}
              icon="desk"
              label={t("nav.inbox")}
              count={overview.data?.needsYou.inbox}
              reserveCount
              testId="portal-nav-inbox"
            />
            <SidebarLink
              to={PORTAL_PATHS.runs}
              icon="report"
              label={t("nav.runs")}
              testId="portal-nav-runs"
            />
            <SidebarLink
              to={PORTAL_PATHS.accounts}
              icon="bank"
              label={t("nav.accounts")}
              testId="portal-nav-accounts"
            />
            <SidebarLink
              to={PORTAL_PATHS.contacts}
              icon="team"
              label={t("nav.contacts")}
              testId="portal-nav-contacts"
            />
          </nav>
        }
        sidebarFooter={
          // Everyone has settings of their own (notifications, language); the admin, all of them.
          <SidebarLink
            to={PORTAL_PATHS.settings}
            icon="settings"
            label={t("nav.settings")}
            testId="portal-nav-settings"
          />
        }
        menu={
          <>
            <Link
              to={PORTAL_PATHS.settings}
              className="text-sm font-medium text-ink hover:underline"
              data-testid="shell-menu-settings"
            >
              {t("nav.settings")}
            </Link>
            {/* The lead shows in one place: here. */}
            {session.lead ? (
              <div data-testid="portal-lead">
                <PersonBadge name={session.lead.name} line={t("nav.lead")} size="sm" />
              </div>
            ) : null}
          </>
        }
      >
        <InboxCountProvider refresh={reloadOverview}>
          <AgentHuesProvider agents={services}>{children}</AgentHuesProvider>
        </InboxCountProvider>
      </AppShell>
      {feedback.data?.enabled ? <FeedbackButton surface="portal" /> : null}
    </>
  );
}

/**
 * Ask Sloan in the top bar, beside the Inbox: Sloan's badge and the words (the badge alone at
 * phone width, named for screen readers), with what Sloan is in its title. It opens `/sloan`;
 * the search box still offers "Ask Sloan" for what was typed.
 */
export function AskSloanButton() {
  const { t } = useI18n();
  const label = t("shell.askSloanButton");
  const hint = t("shell.askSloanHint");
  return (
    <NavLink
      to={PORTAL_PATHS.sloan}
      className="ui-topbar__ask"
      title={hint}
      aria-label={`${label}. ${hint}`}
      data-testid="shell-ask-sloan"
    >
      <AgentBadge name="Sloan" size="sm" />
      <span className="ui-topbar__asklabel">{label}</span>
    </NavLink>
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
