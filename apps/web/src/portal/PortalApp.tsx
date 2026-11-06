// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Every screen reads in the session's language (docs/plan.md §1.18).
import { type ReactNode, useEffect, useRef } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { useI18n } from "../i18n/i18n";
import { PortalRecordScreen } from "../records/RecordScreens";
import { usePoll } from "../runs/usePoll";
import { useSession } from "../session/session";
import { AppShell, SidebarLink } from "../shell/Shell";
import { Placeholder } from "../ui/primitives";
import { INBOX_COUNT_POLL_MS, InboxCountProvider } from "./inboxCount";
import { PortalAccessScreen } from "./screens/Access";
import { PortalBillingScreen } from "./screens/Billing";
import { PortalConnectionsScreen } from "./screens/Connections";
import {
  PortalContactsScreen,
  PortalDirectoryScreen,
  PortalPeopleScreen,
} from "./screens/Contacts";
// v0.14 capture
import { PortalConversationsScreen } from "./screens/Conversations";
import { PortalDocumentScreen } from "./screens/Document";
import { PortalInboxScreen } from "./screens/Inbox";
import { PortalKnowledgeScreen } from "./screens/Knowledge";
import { OAuthCallbackScreen } from "./screens/OAuthCallback";
import { OverviewScreen } from "./screens/Overview";
import { PortalRecordsScreen } from "./screens/Records";
import { PortalReportsScreen } from "./screens/Reports";
import { PortalRequestsScreen } from "./screens/Requests";
import { PortalRunsScreen } from "./screens/Runs";
import { PortalRunScreen } from "./screens/RunTimeline";
import { PortalServiceScreen } from "./screens/Service";
import { PortalSettingsScreen } from "./screens/Settings";

export function PortalLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const session = useSession();
  const client =
    session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  const isAdmin = client?.role === "client_admin";
  // The header's count; the overview screen reads the same route for its own panel.
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

  return (
    <>
      <AppShell
        surface="portal"
        home="/"
        place={client?.name ?? null}
        context={
          <span data-testid="portal-client-name" className="text-sm font-medium text-ink">
            {client?.name ?? t("shell.noClient")}
          </span>
        }
        inboxTo="/inbox"
        inboxCount={overview.data?.needsYou.inbox}
        sidebar={
          <nav className="flex flex-col gap-0.5">
            <SidebarLink to="/" label={t("nav.overview")} end testId="portal-nav-overview" />
            <SidebarLink to="/inbox" label={t("nav.inbox")} testId="portal-nav-inbox" />
            <SidebarLink to="/runs" label={t("nav.runs")} testId="portal-nav-runs" />
            <SidebarLink to="/reports" label={t("nav.reports")} testId="portal-nav-reports" />
            <SidebarLink to="/records" label={t("nav.records")} testId="portal-nav-records" />
            <SidebarLink
              to="/connections"
              label={t("nav.connections")}
              testId="portal-nav-connections"
            />
            <SidebarLink to="/access" label={t("nav.access")} testId="portal-nav-access" />
            <SidebarLink to="/requests" label={t("nav.requests")} testId="portal-nav-requests" />
            <SidebarLink to="/directory" label={t("nav.directory")} testId="portal-nav-directory" />
            {isAdmin ? (
              <>
                <SidebarLink
                  to="/knowledge"
                  label={t("nav.knowledge")}
                  testId="portal-nav-knowledge"
                />
                <SidebarLink
                  to="/contacts"
                  label={t("nav.contacts")}
                  testId="portal-nav-contacts"
                />
                {/* v0.14 capture */}
                <SidebarLink
                  to="/conversations"
                  label={t("nav.conversations")}
                  testId="portal-nav-conversations"
                />
                <SidebarLink to="/billing" label={t("nav.billing")} testId="portal-nav-billing" />
                <SidebarLink to="/people" label={t("nav.people")} testId="portal-nav-people" />
                <SidebarLink
                  to="/settings"
                  label={t("nav.settings")}
                  testId="portal-nav-settings"
                />
              </>
            ) : null}
          </nav>
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
        <Route index element={<OverviewScreen />} />
        <Route path="services/:id" element={<PortalServiceScreen />} />
        <Route path="inbox" element={<PortalInboxScreen />} />
        <Route path="runs" element={<PortalRunsScreen />} />
        <Route path="runs/:id" element={<PortalRunScreen />} />
        <Route path="reports/*" element={<PortalReportsScreen />} />
        <Route path="connections" element={<PortalConnectionsScreen />} />
        <Route path="connections/:connector/callback" element={<OAuthCallbackScreen />} />
        <Route path="access" element={<PortalAccessScreen />} />
        <Route path="documents/:id" element={<PortalDocumentScreen />} />
        <Route path="records" element={<PortalRecordsScreen />} />
        <Route path="records/:id" element={<PortalRecordScreen />} />
        <Route path="requests" element={<PortalRequestsScreen />} />
        <Route path="knowledge" element={<PortalKnowledgeScreen />} />
        <Route path="contacts" element={<PortalContactsScreen />} />
        {/* v0.14 capture */}
        <Route path="conversations" element={<PortalConversationsScreen />} />
        <Route path="directory" element={<PortalDirectoryScreen />} />
        <Route path="people" element={<PortalPeopleScreen />} />
        <Route path="billing" element={<PortalBillingScreen />} />
        <Route path="settings" element={<PortalSettingsScreen />} />
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
