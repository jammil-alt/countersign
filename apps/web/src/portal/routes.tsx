// The portal's route map (docs/ui-plan.md, "Client portal"), one line per route so each UI stream
// adds or replaces its own line. New routes point at today's screens until their stream rebuilds
// them; every old address redirects to its new home (params, query and hash kept), so links in
// emails, texts and bookmarks keep working.
//
// Not here yet, added with their screens: `/sloan` (UI-1d, C6 Sloan) and `/weekly` (UI-1d, C8
// Weekly Table).
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.
import { Route } from "react-router-dom";
import { PortalRecordScreen } from "../records/RecordScreens";
import { Redirect } from "../shell/Redirect";
import { PortalAccessScreen } from "./screens/Access";
import { PortalBillingScreen } from "./screens/Billing";
import { PortalConnectionsScreen } from "./screens/Connections";
import {
  PortalContactsScreen,
  PortalDirectoryScreen,
  PortalPeopleScreen,
} from "./screens/Contacts";
import { PortalConversationsScreen } from "./screens/Conversations";
import { PortalDeskScreen } from "./screens/Desk";
import { PortalDocumentScreen } from "./screens/Document";
import { GsheetsPickScreen } from "./screens/GsheetsPick";
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
import { WhatsappMetaSignupScreen } from "./screens/WhatsappMetaSignup";

export const portalRoutes = (
  <>
    {/* C1 The Table (UI-1a) */}
    <Route index element={<OverviewScreen />} />
    {/* C2 Agent (UI-1a) */}
    <Route path="agents/:id" element={<PortalServiceScreen />} />
    {/* C3 Your Desk (UI-1b) */}
    <Route path="desk" element={<PortalDeskScreen />} />
    {/* C4 Accounts and vault (UI-1c) */}
    <Route path="accounts" element={<PortalConnectionsScreen />} />
    <Route path="accounts/access" element={<PortalAccessScreen />} />
    {/* C5 People (UI-1c) */}
    <Route path="people" element={<PortalPeopleScreen />} />
    <Route path="people/directory" element={<PortalDirectoryScreen />} />
    <Route path="people/contacts" element={<PortalContactsScreen />} />
    {/* C7 Settings and billing (UI-1d) */}
    <Route path="settings" element={<PortalSettingsScreen />} />
    <Route path="settings/billing" element={<PortalBillingScreen />} />
    {/* C9, C10 Runs and run detail (UI-1d) */}
    <Route path="runs" element={<PortalRunsScreen />} />
    <Route path="runs/:id" element={<PortalRunScreen />} />

    {/* Pages the prototype doesn't show (UI-3) */}
    <Route path="reports/*" element={<PortalReportsScreen />} />
    <Route path="records" element={<PortalRecordsScreen />} />
    <Route path="records/:id" element={<PortalRecordScreen />} />
    <Route path="documents/:id" element={<PortalDocumentScreen />} />
    <Route path="requests" element={<PortalRequestsScreen />} />
    <Route path="knowledge" element={<PortalKnowledgeScreen />} />
    <Route path="conversations" element={<PortalConversationsScreen />} />

    {/* Addresses a provider sends the browser back to: they never move. */}
    <Route path="connections/:connector/callback" element={<OAuthCallbackScreen />} />
    <Route path="connections/gsheets/pick" element={<GsheetsPickScreen />} />
    <Route path="connections/whatsapp_meta/signup" element={<WhatsappMetaSignupScreen />} />

    {/* Old addresses → their new homes */}
    <Route path="services/:id" element={<Redirect to="/agents/:id" />} />
    <Route path="inbox" element={<Redirect to="/desk" />} />
    <Route path="connections" element={<Redirect to="/accounts" />} />
    <Route path="access" element={<Redirect to="/accounts/access" />} />
    <Route path="directory" element={<Redirect to="/people/directory" />} />
    <Route path="contacts" element={<Redirect to="/people/contacts" />} />
    <Route path="billing" element={<Redirect to="/settings/billing" />} />
  </>
);
