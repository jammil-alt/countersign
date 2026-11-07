// The portal's route map (docs/ui-plan.md, "Client portal"), one line per route so each UI stream
// adds or replaces its own line. New routes point at today's screens until their stream rebuilds
// them; every old address redirects to its new home (params, query and hash kept), so links in
// emails, texts and bookmarks keep working.
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.
import { Route } from "react-router-dom";
import { PortalRecordScreen } from "../records/RecordScreens";
import { Redirect } from "../shell/Redirect";
import { AccountsScreen, VaultRedirect } from "./screens/Accounts";
import { AgentScreen } from "./screens/Agent";
import { PortalBillingScreen } from "./screens/Billing";
import { PortalConversationsScreen } from "./screens/Conversations";
import { PortalDeskScreen } from "./screens/Desk";
import { PortalDocumentScreen } from "./screens/Document";
import { PortalExportsScreen } from "./screens/Exports";
import { GsheetsPickScreen } from "./screens/GsheetsPick";
import { PortalKnowledgeScreen } from "./screens/Knowledge";
import { OAuthCallbackScreen } from "./screens/OAuthCallback";
import { PeopleScreen } from "./screens/People";
import { PortalRecordsScreen } from "./screens/Records";
import { PortalReportsScreen } from "./screens/Reports";
import { PortalRunsScreen } from "./screens/Runs";
import { PortalRunScreen } from "./screens/RunTimeline";
import { PortalSettingsScreen } from "./screens/Settings";
import { PortalSloanScreen } from "./screens/Sloan";
import { TableScreen } from "./screens/Table";
import { PortalTeamScreen } from "./screens/Team";
import { PortalUploadScreen } from "./screens/UploadPage";
import { WhatsappMetaSignupScreen } from "./screens/WhatsappMetaSignup";

export const portalRoutes = (
  <>
    {/* C1 The Table (UI-1a), with C8 the Weekly Table as its `?view=weekly` (QA round 1) */}
    <Route index element={<TableScreen />} />
    {/* C2 Agent (UI-1a) */}
    <Route path="agents/:id" element={<AgentScreen />} />
    {/* C3 Your Desk (UI-1b) */}
    <Route path="desk" element={<PortalDeskScreen />} />
    {/* C4 Accounts and vault (UI-1c) */}
    <Route path="accounts" element={<AccountsScreen />} />
    <Route path="accounts/access" element={<VaultRedirect />} />
    {/* C5 People (UI-1c) */}
    <Route path="people" element={<PeopleScreen tab="people" />} />
    <Route path="people/organizations" element={<PeopleScreen tab="organizations" />} />
    <Route path="people/contacts" element={<PeopleScreen tab="consent" />} />
    <Route path="people/reach" element={<PeopleScreen tab="reach" />} />
    <Route path="people/voice" element={<PeopleScreen tab="voice" />} />
    <Route path="people/import" element={<PeopleScreen tab="import" />} />
    <Route path="people/directory" element={<Redirect to="/people" />} />
    {/* C7 Settings and billing (UI-1d) */}
    <Route path="settings" element={<PortalSettingsScreen />} />
    <Route path="settings/billing" element={<PortalBillingScreen />} />
    {/* C9, C10 Runs and run detail (UI-1d) */}
    <Route path="runs" element={<PortalRunsScreen />} />
    <Route path="runs/:id" element={<PortalRunScreen />} />
    {/* C6 Sloan (UI-1d) */}
    <Route path="sloan" element={<PortalSloanScreen />} />
    <Route path="sloan/:id" element={<PortalSloanScreen />} />

    {/* Pages the prototype doesn't show (UI-3) */}
    <Route path="reports/*" element={<PortalReportsScreen />} />
    <Route path="records" element={<PortalRecordsScreen />} />
    <Route path="records/:id" element={<PortalRecordScreen />} />
    <Route path="documents/:id" element={<PortalDocumentScreen />} />
    <Route path="knowledge" element={<PortalKnowledgeScreen />} />
    <Route path="conversations" element={<PortalConversationsScreen />} />
    <Route path="upload" element={<PortalUploadScreen />} />
    <Route path="settings/team" element={<PortalTeamScreen />} />
    <Route path="settings/exports" element={<PortalExportsScreen />} />

    {/* Addresses a provider sends the browser back to: they never move. */}
    <Route path="connections/:connector/callback" element={<OAuthCallbackScreen />} />
    <Route path="connections/gsheets/pick" element={<GsheetsPickScreen />} />
    <Route path="connections/whatsapp_meta/signup" element={<WhatsappMetaSignupScreen />} />

    {/* Old addresses → their new homes */}
    <Route path="services/:id" element={<Redirect to="/agents/:id" />} />
    <Route path="inbox" element={<Redirect to="/desk" />} />
    <Route path="connections" element={<Redirect to="/accounts" />} />
    <Route path="access" element={<VaultRedirect />} />
    <Route path="access/*" element={<VaultRedirect />} />
    <Route path="directory" element={<Redirect to="/people" />} />
    <Route path="contacts" element={<Redirect to="/people/contacts" />} />
    <Route path="billing" element={<Redirect to="/settings/billing" />} />
    {/* QA round 1: fewer places. Sloan takes requests; the Table, the Weekly Table. */}
    <Route path="requests" element={<Redirect to="/sloan?mode=change" />} />
    <Route path="weekly" element={<Redirect to="/?view=weekly" />} />
  </>
);
