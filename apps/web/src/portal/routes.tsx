// The portal's route map (docs/ui-plan.md, "Client portal"), one line per route so each UI stream
// adds or replaces its own line. Every old address redirects to its new home (params, query and
// hash kept), so links in emails, texts and bookmarks keep working. Pages that left the sidebar
// keep their own address: they are reached from an agent, a run, Home, Settings or Sloan.
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.
import { Route } from "react-router-dom";
import { PortalRecordScreen } from "../records/RecordScreens";
import { Redirect } from "../shell/Redirect";
import { AccountsScreen, VaultRedirect } from "./screens/Accounts";
import { AgentScreen } from "./screens/Agent";
import { ContactsScreen } from "./screens/Contacts";
import { PortalDocumentScreen } from "./screens/Document";
import { GsheetsPickScreen } from "./screens/GsheetsPick";
import { HomeScreen } from "./screens/Home";
import { PortalInboxScreen } from "./screens/Inbox";
import { PortalKnowledgeScreen } from "./screens/Knowledge";
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

export const portalRoutes = (
  <>
    {/* The sidebar: Home, Inbox, Runs, Accounts, Contacts */}
    <Route index element={<HomeScreen />} />
    <Route path="inbox" element={<PortalInboxScreen />} />
    <Route path="runs" element={<PortalRunsScreen />} />
    <Route path="runs/:id" element={<PortalRunScreen />} />
    <Route path="accounts" element={<AccountsScreen />} />
    <Route path="accounts/access" element={<VaultRedirect />} />
    <Route path="contacts" element={<ContactsScreen />} />

    {/* An agent: Overview, Runs, Access */}
    <Route path="agents/:id" element={<AgentScreen tab="overview" />} />
    <Route path="agents/:id/runs" element={<AgentScreen tab="runs" />} />
    <Route path="agents/:id/access" element={<AgentScreen tab="access" />} />

    {/* Settings (the avatar menu and the sidebar's foot), one section at a time */}
    <Route path="settings" element={<PortalSettingsScreen section="general" />} />
    <Route path="settings/approvals" element={<PortalSettingsScreen section="approvals" />} />
    <Route path="settings/team" element={<PortalSettingsScreen section="team" />} />
    <Route path="settings/billing" element={<PortalSettingsScreen section="billing" />} />
    <Route path="settings/exports" element={<PortalSettingsScreen section="exports" />} />
    <Route
      path="settings/conversations"
      element={<PortalSettingsScreen section="conversations" />}
    />
    <Route path="settings/voice" element={<PortalSettingsScreen section="voice" />} />

    {/* Off the nav, reached from an agent, a run, Home or Sloan */}
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
    <Route path="knowledge" element={<PortalKnowledgeScreen />} />

    {/* Addresses a provider sends the browser back to: they never move. */}
    <Route path="connections/:connector/callback" element={<OAuthCallbackScreen />} />
    <Route path="connections/gsheets/pick" element={<GsheetsPickScreen />} />
    <Route path="connections/whatsapp_meta/signup" element={<WhatsappMetaSignupScreen />} />

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
    <Route path="connections" element={<Redirect to="/accounts" />} />
    <Route path="access" element={<VaultRedirect />} />
    <Route path="access/*" element={<VaultRedirect />} />
    <Route path="directory" element={<Redirect to="/contacts" />} />
    <Route path="billing" element={<Redirect to="/settings/billing" />} />
    {/* Asking us for a change is a mode of Sloan ("Ask us"). */}
    <Route path="requests" element={<Redirect to="/sloan?mode=change" />} />
  </>
);
