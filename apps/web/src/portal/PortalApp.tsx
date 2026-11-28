// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Every screen reads in the session's language (docs/plan.md §1.18). The
// sidebar lists places only: Home, Inbox, Runs, Sandbox (§1.243), Accounts and Contacts (Review 1,
// approved by the owner). The agents are on Home and the agent switcher on an agent's page;
// Settings and the lead are in the avatar menu (Settings also at the sidebar's foot); Sloan is Ask
// Sloan in the top bar and in the search box. The routes live in ./routes.tsx.
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { Link, Route, Routes, useLocation, useMatch } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi, useApiClient } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { useI18n } from "../i18n/i18n";
import { clearLocked, useAccountLocked } from "../lockdown/locked";
import { usePoll } from "../runs/usePoll";
import { useAssignedAgents, useSession } from "../session/session";
import { AgentSwitcher, canSwitch } from "../shell/AgentSwitcher";
import type { SearchRun } from "../shell/Search";
import { AppShell, SidebarLink } from "../shell/Shell";
import { portalSearchGroups } from "../shell/searchGroups";
import { AgentBadge, AgentHuesProvider, PersonBadge } from "../ui/badges";
import { NotFoundPage } from "../ui/primitives";
import { INBOX_COUNT_POLL_MS, InboxCountProvider } from "./inboxCount";
import { useIntentZone } from "./intent";
import { askSloan, PORTAL_PATHS } from "./paths";
import { portalRoutes } from "./routes";
import { SloanPanelProvider, useSloanPanel } from "./SloanPanel";
import { LockedPage } from "./screens/Locked";

/** A page change asks the overview again only when its answer is older than this. */
export const OVERVIEW_STALE_MS = 5_000;

export function PortalLayout({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  const { t } = i18n;
  const session = useSession();
  const api = useApiClient();
  const client =
    session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  // The Inbox's count and the agents (for the switcher). Home, Runs, Sloan and the agent and run
  // pages read the same stored answer: `/api/overview` is asked once per load (2.1).
  // DECISION: the count reloads on a page change when the answer is older than a few seconds
  // (OVERVIEW_STALE_MS), every 20 s and after a resolve (it loaded once before, so an approval
  // proposed while the portal was open never showed in it). A screen mounting with the same route
  // joins that request, so a move asks it at most once.
  const overview = useApi(apiRoutes.portalOverview);
  const { pathname } = useLocation();
  const { reload: reloadOverview } = overview;
  const answeredAt = useRef(0);
  const lastData = useRef(overview.data);
  if (overview.data !== undefined && overview.data !== lastData.current) {
    lastData.current = overview.data;
    answeredAt.current = Date.now();
  }
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = pathname;
    if (Date.now() - answeredAt.current >= OVERVIEW_STALE_MS) reloadOverview();
  }, [pathname, reloadOverview]);
  // §1.243: while the account is locked every screen gives way to the locked page, and the count
  // isn't asked again every 20 s. Choosing another account asks afresh.
  const locked = useAccountLocked();
  const activeTenant = session.activeTenantId;
  useEffect(() => {
    if (activeTenant !== undefined) clearLocked();
  }, [activeTenant]);
  usePoll(reloadOverview, !locked, INBOX_COUNT_POLL_MS, overview.loading);
  // The operator switches the Feedback button on per client; off, there is no button.
  const feedback = useApi(apiRoutes.portalFeedbackStatus);
  const services = overview.data?.services ?? [];
  const switchAgents = services.map((s) => ({
    key: s.id,
    name: s.name,
    href: PORTAL_PATHS.agent(s.id),
  }));
  const agentMatch = useMatch("/agents/:id/*");
  // docs/plan.md §1.122: a client user limited to some agents has their agents, their runs and
  // their inbox; the business's accounts, contacts, search and Sloan are closed to them.
  const limited = useAssignedAgents() !== null;
  const intentZone = useIntentZone();

  const search: SearchRun = useCallback(
    async (q, signal) =>
      portalSearchGroups(await api.call(apiRoutes.portalSearch, { query: { q }, signal }), t, i18n),
    [api, t, i18n],
  );

  return (
    <SloanPanelProvider>
      <AppShell
        surface="portal"
        home="/"
        place={client?.name ?? null}
        context={
          <span data-testid="portal-client-name">{client?.name ?? t("shell.noClient")}</span>
        }
        search={
          limited
            ? null
            : {
                placeholder: t("shell.searchPlaceholder"),
                run: search,
                ask: {
                  label: (q) => t("shell.askSloan", { q }),
                  href: (q) => askSloan(q),
                },
              }
        }
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
        topAction={limited ? null : <AskSloanButton />}
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
            {/* §1.124: the client's Requests (issues and asks). */}
            <SidebarLink
              to={PORTAL_PATHS.requests}
              icon="message"
              label={t("nav.requests")}
              testId="portal-nav-requests"
            />
            <SidebarLink
              to={PORTAL_PATHS.runs}
              icon="report"
              label={t("nav.runs")}
              testId="portal-nav-runs"
            />
            {/* docs/plan.md §1.243: run an agent on your own data; nothing is written. */}
            <SidebarLink
              to={PORTAL_PATHS.sandbox}
              icon="worksheet"
              label={t("nav.sandbox")}
              testId="portal-nav-sandbox"
            />
            {limited ? null : (
              <>
                <SidebarLink
                  to={PORTAL_PATHS.connectors}
                  icon="bank"
                  label={t("nav.connectors")}
                  testId="portal-nav-connectors"
                />
                <SidebarLink
                  to={PORTAL_PATHS.contacts}
                  icon="team"
                  label={t("nav.contacts")}
                  testId="portal-nav-contacts"
                />
              </>
            )}
            {/* §1.122: the admin's team management (who uses the portal and what each works on). */}
            {client?.role === "client_admin" ? (
              <SidebarLink
                to={PORTAL_PATHS.team}
                icon="lead"
                label={t("teamPage.title")}
                testId="portal-nav-team"
              />
            ) : null}
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
          <AgentHuesProvider agents={services}>
            {/* Links and rows to a run, an agent or the Inbox ask for it on hover or focus (1.6). */}
            <div className="contents" {...intentZone}>
              {locked ? <LockedPage /> : children}
            </div>
          </AgentHuesProvider>
        </InboxCountProvider>
      </AppShell>
      {feedback.data?.enabled ? <FeedbackButton surface="portal" /> : null}
    </SloanPanelProvider>
  );
}

/**
 * Ask Sloan in the top bar, beside the Inbox: Sloan's badge and the words (the badge alone at
 * phone width, named for screen readers), with what Sloan is in its title. Feedback (2026-11-11):
 * it opens Sloan in a side panel over the page you're on (`SloanPanel`), with the full `/sloan`
 * page one link away; the search box still offers "Ask Sloan" for what was typed.
 */
export function AskSloanButton() {
  const { t } = useI18n();
  const onSloan = useMatch(`${PORTAL_PATHS.sloan}/*`);
  const label = t("shell.askSloanButton");
  const hint = t("shell.askSloanHint");
  // v0.19 (§10.15 "Home"): opens Sloan's chat beside the screen; its link goes to /sloan.
  const panel = useSloanPanel();
  return (
    <button
      type="button"
      className="ui-topbar__ask"
      title={hint}
      aria-label={`${label}. ${hint}`}
      aria-haspopup="dialog"
      aria-current={onSloan ? "page" : undefined}
      data-testid="shell-ask-sloan"
      onClick={() => panel.open()}
    >
      <AgentBadge name="Sloan" size="sm" />
      <span className="ui-topbar__asklabel">{label}</span>
    </button>
  );
}

export function PortalApp() {
  return (
    <PortalLayout>
      <Routes>
        {portalRoutes}
        <Route path="*" element={<NotFoundPage home="/" />} />
      </Routes>
    </PortalLayout>
  );
}
