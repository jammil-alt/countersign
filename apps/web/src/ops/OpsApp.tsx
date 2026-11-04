// The back office (`/ops/*`, operator only). App.tsx loads this module lazily, behind the operator
// check, so client users never download it (plan §1.2 "Back office and portal in one app"). The
// workflow builder is a further lazy chunk inside it, loaded when an operator opens a workflow.
import { Route, Routes } from "react-router-dom";
import { OpsRecordScreen } from "../records/RecordScreens";
import { Placeholder } from "../ui/primitives";
import { NewClientAgentScreen } from "./agents/NewClientAgentScreen";
import { NewTemplateScreen, TemplatePage, TemplatesScreen } from "./agents/TemplateScreens";
import { MergeScreen } from "./merge/MergeScreen";
import { OpsLayout } from "./OpsLayout";
import { AgentPage } from "./screens/AgentPage";
import { OpsBillingScreen } from "./screens/Billing";
import { ClientDetailScreen } from "./screens/ClientDetail";
import { ClientSettingsScreen } from "./screens/ClientSettings";
import { ClientsScreen } from "./screens/Clients";
import { OpsConnectionsScreen } from "./screens/Connections";
import { OpsDocumentScreen, OpsDocumentsScreen } from "./screens/Documents";
import { OpsFeedbackScreen } from "./screens/Feedback";
import { OpsInboxScreen } from "./screens/Inbox";
import { NewClientScreen } from "./screens/NewClient";
import { OverviewScreen } from "./screens/Overview";
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
        <Route path="clients/:clientId/runs" element={<OpsRunsScreen />} />
        <Route path="clients/:clientId/documents" element={<OpsDocumentsScreen />} />
        <Route path="clients/:clientId/documents/:documentId" element={<OpsDocumentScreen />} />
        <Route path="clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
        <Route path="runs" element={<OpsRunsScreen />} />
        <Route path="runs/:id" element={<OpsRunScreen />} />
        <Route path="inbox" element={<OpsInboxScreen />} />
        <Route path="usage" element={<OpsUsageScreen />} />
        <Route path="requests" element={<OpsRequestsScreen />} />
        <Route path="billing" element={<OpsBillingScreen />} />
        <Route path="feedback" element={<OpsFeedbackScreen />} />
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
