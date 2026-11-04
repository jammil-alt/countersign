// The client portal (`/`, client roles): the client's own frame, with no switcher and no building
// (ARCHITECTURE §15). Overview, Inbox, Runs, Connections and Requests are wired; the rest are
// placeholders.
import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { apiRoutes } from "../api/routes";
import { useApi } from "../api/useApi";
import { FeedbackButton } from "../feedback/Feedback";
import { PortalRecordScreen } from "../records/RecordScreens";
import { useSession } from "../session/session";
import { AppShell, SidebarLink } from "../shell/Shell";
import { Placeholder } from "../ui/primitives";
import { PortalBillingScreen } from "./screens/Billing";
import { PortalConnectionsScreen } from "./screens/Connections";
import { PortalContactsScreen, PortalPeopleScreen } from "./screens/Contacts";
import { PortalDocumentScreen } from "./screens/Document";
import { PortalInboxScreen } from "./screens/Inbox";
import { PortalKnowledgeScreen } from "./screens/Knowledge";
import { OAuthCallbackScreen } from "./screens/OAuthCallback";
import { OverviewScreen } from "./screens/Overview";
import { PortalReportsScreen } from "./screens/Reports";
import { PortalRequestsScreen } from "./screens/Requests";
import { PortalRunsScreen } from "./screens/Runs";
import { PortalRunScreen } from "./screens/RunTimeline";
import { PortalServiceScreen } from "./screens/Service";
import { PortalSettingsScreen } from "./screens/Settings";

export function PortalLayout({ children }: { children: ReactNode }) {
  const session = useSession();
  const client =
    session.tenants.find((t) => t.id === session.activeTenantId) ?? session.tenants[0] ?? null;
  const isAdmin = client?.role === "client_admin";
  // The header's count; the overview screen reads the same route for its own panel.
  const overview = useApi(apiRoutes.portalOverview);
  // The operator switches the Feedback button on per client; off, there is no button.
  const feedback = useApi(apiRoutes.portalFeedbackStatus);

  return (
    <>
      <AppShell
        surface="portal"
        home="/"
        context={
          <span data-testid="portal-client-name" className="text-sm font-medium text-ink">
            {client?.name ?? "No client"}
          </span>
        }
        inboxTo="/inbox"
        inboxCount={overview.data?.needsYou.inbox}
        sidebar={
          <nav className="flex flex-col gap-0.5">
            <SidebarLink to="/" label="Overview" end testId="portal-nav-overview" />
            <SidebarLink to="/inbox" label="Inbox" testId="portal-nav-inbox" />
            <SidebarLink to="/runs" label="Runs" testId="portal-nav-runs" />
            <SidebarLink to="/reports" label="Reports" testId="portal-nav-reports" />
            <SidebarLink to="/connections" label="Connections" testId="portal-nav-connections" />
            <SidebarLink to="/requests" label="Requests" testId="portal-nav-requests" />
            {isAdmin ? (
              <>
                <SidebarLink to="/knowledge" label="Knowledge" testId="portal-nav-knowledge" />
                <SidebarLink to="/contacts" label="Contacts" testId="portal-nav-contacts" />
                <SidebarLink to="/billing" label="Billing" testId="portal-nav-billing" />
              </>
            ) : null}
            {isAdmin ? (
              <SidebarLink to="/people" label="People" testId="portal-nav-people" />
            ) : null}
            {isAdmin ? (
              <SidebarLink to="/settings" label="Settings" testId="portal-nav-settings" />
            ) : null}
          </nav>
        }
      >
        {children}
      </AppShell>
      {feedback.data?.enabled ? <FeedbackButton surface="portal" /> : null}
    </>
  );
}

export function PortalApp() {
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
        <Route path="documents/:id" element={<PortalDocumentScreen />} />
        <Route path="records/:id" element={<PortalRecordScreen />} />
        <Route path="requests" element={<PortalRequestsScreen />} />
        <Route path="knowledge" element={<PortalKnowledgeScreen />} />
        <Route path="contacts" element={<PortalContactsScreen />} />
        <Route path="people" element={<PortalPeopleScreen />} />
        <Route path="billing" element={<PortalBillingScreen />} />
        <Route path="settings" element={<PortalSettingsScreen />} />
        <Route path="*" element={<Placeholder title="Not found">No page here.</Placeholder>} />
      </Routes>
    </PortalLayout>
  );
}
