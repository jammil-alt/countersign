// The back office's route map (docs/ui-plan.md, "Back office"), one line per route so each UI
// stream adds or replaces its own line. New routes point at today's screens until their stream
// rebuilds them; every old address redirects to its new home (params, query and hash kept).
//
// The agent page (UI-2b) serves everything under `agents/:slug/*` with its tabs: Overview,
// `workflow` (and `workflows/:workflow`, the builder), `triggers`, `runs`, `versions`, `tests` and
// `settings`. UI-2c: the Workflow tab is the O6 Workflow builder (ops/builder) and the Triggers tab
// the O7 Triggers screen (ops/triggers); the sidebar lists both under the open agent.
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.
import { Route } from "react-router-dom";
import { OpsRecordScreen } from "../records/RecordScreens";
import { Redirect } from "../shell/Redirect";
import { Placeholder } from "../ui/primitives";
import { NewClientAgentScreen } from "./agents/NewClientAgentScreen";
import { NewTemplateScreen, TemplatePage } from "./agents/TemplateScreens";
import { LabScreen } from "./lab/LabScreen";
import { MergeScreen } from "./merge/MergeScreen";
import { AgentPage } from "./screens/AgentPage";
import { OpsAgentRedirect } from "./screens/AgentRedirect";
import { OpsAuditScreen } from "./screens/AuditLog";
import { OpsBillingScreen } from "./screens/Billing";
import { OpsBrowserSitesScreen } from "./screens/BrowserSites";
import { ClientDetailScreen } from "./screens/ClientDetail";
import { ClientDirectoryRoute } from "./screens/ClientDirectory";
import { ClientKnowledgeRoute } from "./screens/ClientKnowledge";
import { ClientSettingsScreen } from "./screens/ClientSettings";
import { ClientsScreen } from "./screens/Clients";
import { OpsConnectionsScreen } from "./screens/Connections";
import { OpsConnectorsScreen } from "./screens/Connectors";
import { OpsDocumentScreen, OpsDocumentsScreen } from "./screens/Documents";
import { OpsFeedbackScreen } from "./screens/Feedback";
import { OpsInboxScreen } from "./screens/Inbox";
import { OpsMessagingScreen } from "./screens/Messaging";
import { NewClientScreen } from "./screens/NewClient";
import { OpsOAuthCallbackScreen } from "./screens/OAuthCallback";
import { OverviewScreen } from "./screens/Overview";
import { OpsRecordsScreen } from "./screens/Records";
import { OpsRequestsScreen } from "./screens/Requests";
import { OpsRunsScreen } from "./screens/Runs";
import { OpsRunScreen } from "./screens/RunView";
import { OpsUsageScreen } from "./screens/Usage";
import { NewSkillScreen, SkillPage, SkillsScreen } from "./skills/SkillScreens";

export const opsRoutes = (
  <>
    {/* O1 Command center (UI-2a) */}
    <Route index element={<OverviewScreen />} />
    {/* Escalations, O9 Runs, O10 Run detail (UI-2a) */}
    <Route path="inbox" element={<OpsInboxScreen />} />
    <Route path="runs" element={<OpsRunsScreen />} />
    <Route path="runs/:id" element={<OpsRunScreen />} />
    {/* O2 Agent lab, update merge (UI-2b) */}
    <Route path="lab" element={<LabScreen />} />
    <Route path="templates/:slug/*" element={<TemplatePage />} />
    <Route path="agents/:id" element={<OpsAgentRedirect />} />
    <Route path="agents/:id/merge" element={<MergeScreen />} />
    {/* O5 New agent, by conversation with the Builder (UI-2c) */}
    <Route path="templates/new" element={<NewTemplateScreen />} />
    <Route path="clients/:clientId/agents/new" element={<NewClientAgentScreen />} />
    {/* Back-office agent page (UI-2b), with O6 Workflow builder and O7 Triggers as tabs (UI-2c) */}
    <Route path="clients/:clientId/agents/:slug/*" element={<AgentPage />} />
    {/* O4 Skills and automations, O8 New skill, O3 Connectors (UI-2d) */}
    <Route path="skills" element={<SkillsScreen />} />
    <Route path="skills/new" element={<NewSkillScreen />} />
    <Route path="skills/:id" element={<SkillPage />} />
    <Route path="connectors" element={<OpsConnectorsScreen />} />

    {/* Clients: the client page and new client (UI-3) */}
    <Route path="clients" element={<ClientsScreen />} />
    <Route path="clients/new" element={<NewClientScreen />} />
    <Route path="clients/:clientId" element={<ClientDetailScreen />} />
    <Route path="clients/:clientId/settings" element={<ClientSettingsScreen />} />
    <Route path="clients/:clientId/connections" element={<OpsConnectionsScreen />} />
    <Route path="clients/:clientId/knowledge" element={<ClientKnowledgeRoute />} />
    <Route path="clients/:clientId/directory" element={<ClientDirectoryRoute />} />
    <Route path="clients/:clientId/runs" element={<OpsRunsScreen />} />
    <Route path="clients/:clientId/documents" element={<OpsDocumentsScreen />} />
    <Route path="clients/:clientId/documents/:documentId" element={<OpsDocumentScreen />} />
    <Route path="clients/:clientId/records" element={<OpsRecordsScreen />} />
    <Route path="clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
    <Route path="clients/:clientId/messaging" element={<OpsMessagingScreen />} />
    {/* Usage, billing, feedback, audit, website logins, requests (UI-3) */}
    <Route path="usage" element={<OpsUsageScreen />} />
    <Route path="billing" element={<OpsBillingScreen />} />
    <Route path="feedback" element={<OpsFeedbackScreen />} />
    <Route path="audit" element={<OpsAuditScreen />} />
    <Route path="browser-sites" element={<OpsBrowserSitesScreen />} />
    <Route path="requests" element={<OpsRequestsScreen />} />
    {/* ARCHITECTURE §15 screens not built yet */}
    <Route path="packs" element={<Placeholder title="Packs" />} />
    <Route path="settings" element={<Placeholder title="Settings" />} />

    {/* An address a provider sends the browser back to: it never moves. */}
    <Route path="connections/:connector/callback" element={<OpsOAuthCallbackScreen />} />

    {/* Old addresses → their new homes */}
    <Route path="templates" element={<Redirect to="/ops/lab" />} />
  </>
);
