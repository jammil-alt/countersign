// The back office (`/ops/*`, operator only). App.tsx loads this module lazily, behind the operator
// check, so client users never download it (plan §1.2 "Back office and portal in one app"). The
// workflow builder is a further lazy chunk inside it, loaded when an operator opens a workflow.
import { Route, Routes } from "react-router-dom";
import { I18nProvider } from "../i18n/i18n";
import { OpsRecordScreen } from "../records/RecordScreens";
import { Placeholder } from "../ui/primitives";
import { NewClientAgentScreen } from "./agents/NewClientAgentScreen";
import { NewTemplateScreen, TemplatePage, TemplatesScreen } from "./agents/TemplateScreens";
import { MergeScreen } from "./merge/MergeScreen";
import { OpsLayout } from "./OpsLayout";
import { AgentPage } from "./screens/AgentPage";
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

/** ARCHITECTURE §15's back-office screens not built yet, as placeholders. */
const PLACEHOLDERS: [path: string, title: string][] = [
  ["agents/:id/merge", "Merge"],
  ["skills", "Skills"],
  ["skills/:id", "Skill"],
  ["packs", "Packs"],
  ["settings", "Settings"],
];

export default function OpsApp() {
  // The back office stays in English (plan §1.18), whatever the browser or a client reads; the
  // components it shares with the portal render English here.
  return (
    <I18nProvider locale="en">
      <OpsBackOffice />
    </I18nProvider>
  );
}

function OpsBackOffice() {
  return (
    <OpsLayout>
      <Routes>
        <Route index element={<OverviewScreen />} />
        <Route path="clients" element={<ClientsScreen />} />
        {PLACEHOLDERS.map(([path, title]) => (
          <Route key={path} path={path} element={<Placeholder title={title} />} />
        ))}
        <Route path="agents/:id/merge" element={<MergeScreen />} />
        <Route path="clients/new" element={<NewClientScreen />} />
        <Route path="clients/:clientId" element={<ClientDetailScreen />} />
        <Route path="clients/:clientId/settings" element={<ClientSettingsScreen />} />
        <Route path="clients/:clientId/connections" element={<OpsConnectionsScreen />} />
        <Route path="connections/:connector/callback" element={<OpsOAuthCallbackScreen />} />
        <Route path="clients/:clientId/knowledge" element={<ClientKnowledgeRoute />} />
        <Route path="clients/:clientId/directory" element={<ClientDirectoryRoute />} />
        <Route path="clients/:clientId/runs" element={<OpsRunsScreen />} />
        <Route path="clients/:clientId/documents" element={<OpsDocumentsScreen />} />
        <Route path="clients/:clientId/documents/:documentId" element={<OpsDocumentScreen />} />
        <Route path="clients/:clientId/records" element={<OpsRecordsScreen />} />
        <Route path="clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
        <Route path="clients/:clientId/messaging" element={<OpsMessagingScreen />} />
        <Route path="runs" element={<OpsRunsScreen />} />
        <Route path="runs/:id" element={<OpsRunScreen />} />
        <Route path="inbox" element={<OpsInboxScreen />} />
        <Route path="usage" element={<OpsUsageScreen />} />
        <Route path="requests" element={<OpsRequestsScreen />} />
        <Route path="billing" element={<OpsBillingScreen />} />
        <Route path="browser-sites" element={<OpsBrowserSitesScreen />} />
        {/* v0.12 W2-A: the connectors catalog */}
        <Route path="connectors" element={<OpsConnectorsScreen />} />
        <Route path="feedback" element={<OpsFeedbackScreen />} />
        <Route path="audit" element={<OpsAuditScreen />} />
        <Route path="clients/:clientId/agents/new" element={<NewClientAgentScreen />} />
        <Route path="clients/:clientId/agents/:slug/*" element={<AgentPage />} />
        <Route path="skills" element={<SkillsScreen />} />
        <Route path="skills/new" element={<NewSkillScreen />} />
        <Route path="skills/:id" element={<SkillPage />} />
        <Route path="templates" element={<TemplatesScreen />} />
        <Route path="templates/new" element={<NewTemplateScreen />} />
        <Route path="templates/:slug/*" element={<TemplatePage />} />
        <Route path="*" element={<Placeholder title="Not found">No page here.</Placeholder>} />
      </Routes>
    </OpsLayout>
  );
}
