// The portal's route map (docs/ui-plan.md, "Client portal"), one line per route so each UI stream
// adds or replaces its own line. Every old address redirects to its new home (params, query and
// hash kept), so links in emails, texts and bookmarks keep working. Pages that left the sidebar
// keep their own address: they are reached from an agent, a run, Home, Settings or Sloan.
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.
import { lazy, type ReactNode, Suspense } from "react";
import { Navigate, Route, useLocation } from "react-router-dom";
import { PortalRecordScreen } from "../records/RecordScreens";
import { ConnectClaudeScreen } from "../session/ConnectClaude";
import { Redirect } from "../shell/Redirect";
import { Loading } from "../ui/primitives";
import { AgentScreen } from "./screens/Agent";
import { ContactsScreen } from "./screens/Contacts";
import { PortalDocumentScreen } from "./screens/Document";
import { GsheetsPickScreen } from "./screens/GsheetsPick";
import { HomeScreen } from "./screens/Home";
import { PortalInboxScreen } from "./screens/Inbox";
import { OAuthCallbackScreen } from "./screens/OAuthCallback";
import { PortalRecordsScreen } from "./screens/Records";
import { PortalReportsScreen } from "./screens/Reports";
import { PortalRunsScreen } from "./screens/Runs";
import { PortalRunScreen } from "./screens/RunTimeline";
import { PortalSettingsScreen } from "./screens/Settings";
import { PortalSloanScreen } from "./screens/Sloan";
import { PortalUploadScreen } from "./screens/UploadPage";
import { PortalWeeklyScreen } from "./screens/Weekly";
import { WhatsappMetaSignupScreen } from "./screens/WhatsappMetaSignup";

// §1.124: Requests and the requirements form load when opened, so the first load (its budget is in
// scripts/web-size.mjs) doesn't carry them.
const RequestsScreen = lazy(() =>
  import("../requests/RequestsScreen").then((m) => ({ default: m.RequestsScreen })),
);
const RequestDetailScreen = lazy(() =>
  import("../requests/RequestDetail").then((m) => ({ default: m.RequestDetailScreen })),
);
const RequirementsScreen = lazy(() =>
  import("../requests/RequirementsForm").then((m) => ({ default: m.RequirementsScreen })),
);
// §1.149: Getting started is the client's home only while an intake is open, so it loads when opened.
const GettingStartedScreen = lazy(() =>
  import("./screens/GettingStarted").then((m) => ({ default: m.GettingStartedScreen })),
);
// docs/setup-plan.md (§1.206): Getting started's chapters.
const ToolsChapterScreen = lazy(() =>
  import("./screens/setup/ToolsChapter").then((m) => ({ default: m.ToolsChapterScreen })),
);
const PeopleChapterScreen = lazy(() =>
  import("./screens/setup/PeopleChapter").then((m) => ({ default: m.PeopleChapterScreen })),
);
const SeeChapterScreen = lazy(() =>
  import("./screens/setup/SeeChapter").then((m) => ({ default: m.SeeChapterScreen })),
);
const LiveChapterScreen = lazy(() =>
  import("./screens/setup/LiveChapter").then((m) => ({ default: m.LiveChapterScreen })),
);
// Staging CI (2026-11-19): Knowledge (with the charter and policy tags, docs/builder-plan.md §8)
// loads when opened, so the first load stays in its budget (docs/plan.md §1.146).
const PortalKnowledgeScreen = lazy(() =>
  import("./screens/Knowledge").then((m) => ({ default: m.PortalKnowledgeScreen })),
);
// Connectors C5: the list and a connector's page load when opened, so the first load stays in its
// budget (scripts/web-size.mjs).
const ConnectorsScreen = lazy(() =>
  import("./screens/Connectors").then((m) => ({ default: m.ConnectorsScreen })),
);
const ConnectorPageScreen = lazy(() =>
  import("./screens/ConnectorPage").then((m) => ({ default: m.ConnectorPageScreen })),
);
// docs/sop-plan.md S2: Procedures, every agent's SOP in a row, loads when opened.
const ProceduresScreen = lazy(() =>
  import("./screens/Procedures").then((m) => ({ default: m.ProceduresScreen })),
);
/** `/access`, `/accounts/access`: the vault's old pages, now Connectors' website logins. */
function VaultRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: "/connectors", search, hash: "#vault" }} replace />;
}

const OnDemand = ({ children }: { children: ReactNode }) => (
  <Suspense fallback={<Loading />}>{children}</Suspense>
);

export const portalRoutes = (
  <>
    {/* The sidebar: Home, Inbox, Runs, Connectors, Contacts */}
    <Route index element={<HomeScreen />} />
    <Route path="inbox" element={<PortalInboxScreen />} />
    <Route path="runs" element={<PortalRunsScreen />} />
    <Route path="runs/:id" element={<PortalRunScreen />} />
    {/* Connectors C5 (docs/connectors-plan.md §3): the client's tools, and each one's page */}
    <Route
      path="connectors"
      element={
        <OnDemand>
          <ConnectorsScreen />
        </OnDemand>
      }
    />
    <Route
      path="connectors/:connector"
      element={
        <OnDemand>
          <ConnectorPageScreen />
        </OnDemand>
      }
    />
    <Route path="contacts" element={<ContactsScreen />} />

    {/* An agent: Overview, Runs, Access */}
    <Route path="agents/:id" element={<AgentScreen tab="overview" />} />
    <Route path="agents/:id/runs" element={<AgentScreen tab="runs" />} />
    {/* docs/sop-plan.md S1: the agent's SOP, read only, in the manual's place */}
    <Route path="agents/:id/flow" element={<AgentScreen tab="workflow" />} />
    <Route path="agents/:id/sop" element={<AgentScreen tab="sop" />} />
    {/* R4 (docs/plan.md §1.214): the agent's report */}
    <Route path="agents/:id/report" element={<AgentScreen tab="report" />} />
    <Route path="agents/:id/manual" element={<Redirect to="/agents/:id/sop" />} />
    <Route path="agents/:id/settings" element={<AgentScreen tab="settings" />} />
    <Route path="agents/:id/access" element={<Redirect to="/agents/:id/settings" />} />

    {/* docs/sop-plan.md S2: every agent's SOP in a row */}
    <Route
      path="procedures"
      element={
        <OnDemand>
          <ProceduresScreen />
        </OnDemand>
      }
    />

    {/* Settings (the avatar menu and the sidebar's foot), one section at a time */}
    <Route path="settings" element={<PortalSettingsScreen section="general" />} />
    <Route path="settings/approvals" element={<PortalSettingsScreen section="approvals" />} />
    <Route path="settings/team" element={<PortalSettingsScreen section="team" />} />
    {/* R8 (docs/plan.md §1.86): business hours and channels */}
    <Route path="settings/hours" element={<PortalSettingsScreen section="hours" />} />
    <Route path="settings/channels" element={<PortalSettingsScreen section="channels" />} />
    <Route path="settings/billing" element={<PortalSettingsScreen section="billing" />} />
    <Route path="settings/exports" element={<PortalSettingsScreen section="exports" />} />
    <Route
      path="settings/conversations"
      element={<PortalSettingsScreen section="conversations" />}
    />
    <Route path="settings/voice" element={<PortalSettingsScreen section="voice" />} />
    <Route path="settings/charter" element={<PortalSettingsScreen section="charter" />} />
    {/* P-8: US texting registration */}
    <Route path="settings/texting" element={<PortalSettingsScreen section="texting" />} />

    {/* Off the nav, reached from an agent, a run, Home or Sloan */}
    {/* §1.149.2: Getting started, the client's home while an intake is open and no agent is live */}
    <Route
      path="start"
      element={
        <OnDemand>
          <GettingStartedScreen />
        </OnDemand>
      }
    />
    {/* docs/setup-plan.md (§1.206): its chapters */}
    <Route
      path="getting-started/tools"
      element={
        <OnDemand>
          <ToolsChapterScreen />
        </OnDemand>
      }
    />
    <Route
      path="getting-started/people"
      element={
        <OnDemand>
          <PeopleChapterScreen />
        </OnDemand>
      }
    />
    <Route
      path="getting-started/see"
      element={
        <OnDemand>
          <SeeChapterScreen />
        </OnDemand>
      }
    />
    <Route
      path="getting-started/see/:agentId"
      element={
        <OnDemand>
          <SeeChapterScreen />
        </OnDemand>
      }
    />
    <Route
      path="getting-started/live"
      element={
        <OnDemand>
          <LiveChapterScreen />
        </OnDemand>
      }
    />
    <Route
      path="getting-started/live/:agentId"
      element={
        <OnDemand>
          <LiveChapterScreen />
        </OnDemand>
      }
    />
    <Route path="weekly" element={<PortalWeeklyScreen />} />
    <Route path="sloan" element={<PortalSloanScreen />} />
    <Route path="sloan/:id" element={<PortalSloanScreen />} />
    <Route path="reports/*" element={<PortalReportsScreen />} />
    <Route path="records" element={<PortalRecordsScreen />} />
    <Route path="records/:id" element={<PortalRecordScreen />} />
    <Route path="documents/:id" element={<PortalDocumentScreen />} />
    <Route path="upload" element={<PortalUploadScreen />} />
    {/* DECISION: knowledge belongs to the back office (the client page's Knowledge tab); the
        page keeps its address for old links, and nothing in the portal links to it. */}
    <Route
      path="knowledge"
      element={
        <OnDemand>
          <PortalKnowledgeScreen />
        </OnDemand>
      }
    />

    {/* Addresses a provider sends the browser back to: they never move. */}
    <Route path="connections/:connector/callback" element={<OAuthCallbackScreen />} />
    <Route path="connections/gsheets/pick" element={<GsheetsPickScreen />} />
    <Route path="connections/whatsapp_meta/signup" element={<WhatsappMetaSignupScreen />} />
    {/* §1.120: the link Claude gives a client's person to approve its connection; it never moves. */}
    <Route path="connect-claude/:code" element={<ConnectClaudeScreen />} />

    {/* Old addresses → their new homes */}
    <Route path="desk" element={<Redirect to="/inbox" />} />
    <Route path="people" element={<Redirect to="/contacts" />} />
    <Route path="people/directory" element={<Redirect to="/contacts" />} />
    <Route path="people/contacts" element={<Redirect to="/contacts" />} />
    <Route path="people/organizations" element={<Redirect to="/contacts?show=organizations" />} />
    <Route path="people/import" element={<Redirect to="/contacts?import=1" />} />
    {/* DECISION: who agents reach is on each agent's Access tab; Home lists the agents. */}
    <Route path="people/reach" element={<Redirect to="/" />} />
    <Route path="people/voice" element={<Redirect to="/settings/voice" />} />
    <Route path="people/*" element={<Redirect to="/contacts" />} />
    <Route path="conversations" element={<Redirect to="/settings/conversations" />} />
    <Route path="services/:id" element={<Redirect to="/agents/:id" />} />
    {/* Accounts and its vault rail retired (C5): the vault's logins are under Built for you. */}
    <Route path="accounts" element={<Redirect to="/connectors" />} />
    <Route path="accounts/access" element={<VaultRedirect />} />
    <Route path="connections" element={<Redirect to="/connectors" />} />
    <Route path="access" element={<VaultRedirect />} />
    <Route path="access/*" element={<VaultRedirect />} />
    <Route path="directory" element={<Redirect to="/contacts" />} />
    <Route path="billing" element={<Redirect to="/settings/billing" />} />
    {/* §1.124: Requests, the client's issues and asks; Sloan's change mode stays. */}
    <Route
      path="requests"
      element={
        <OnDemand>
          <RequestsScreen />
        </OnDemand>
      }
    />
    <Route
      path="requests/:id"
      element={
        <OnDemand>
          <RequestDetailScreen />
        </OnDemand>
      }
    />
    <Route
      path="requirements/:itemId"
      element={
        <OnDemand>
          <RequirementsScreen />
        </OnDemand>
      }
    />
  </>
);
