// The back office (`/ops/*`, operator only). App.tsx loads this module lazily, behind the operator
// check, so client users never download it (plan §1.2 "Back office and portal in one app"). The
// workflow builder is a further lazy chunk inside it, loaded when an operator opens a workflow.
import { Route, Routes } from "react-router-dom";
import { Placeholder } from "../ui/primitives";
import { NewClientAgentScreen } from "./agents/NewClientAgentScreen";
import { NewTemplateScreen, TemplatePage, TemplatesScreen } from "./agents/TemplateScreens";
import { MergeScreen } from "./merge/MergeScreen";
import { OpsLayout } from "./OpsLayout";
import { AgentPage } from "./screens/AgentPage";
import { ClientDetailScreen } from "./screens/ClientDetail";
import { ClientsScreen } from "./screens/Clients";
import { OpsConnectionsScreen } from "./screens/Connections";
import { OpsFeedbackScreen } from "./screens/Feedback";
import { OpsInboxScreen } from "./screens/Inbox";
import { OpsRunsScreen } from "./screens/Runs";
import { OpsRunScreen } from "./screens/RunView";
import { NewSkillScreen, SkillPage, SkillsScreen } from "./skills/SkillScreens";

/** ARCHITECTURE §15's back-office screens not built yet, as placeholders. */
const PLACEHOLDERS: [path: string, title: string][] = [
  ["clients/new", "New client"],
  ["clients/:clientId/settings", "Client settings"],
  ["agents/:id/merge", "Merge"],
  ["skills", "Skills"],
  ["skills/:id", "Skill"],
  ["packs", "Packs"],
  ["requests", "Requests"],
  ["usage", "Usage and cost"],
  ["settings", "Settings"],
];

export default function OpsApp() {
  return (
    <OpsLayout>
      <Routes>
        <Route index element={<ClientsScreen overview />} />
        <Route path="clients" element={<ClientsScreen />} />
        {PLACEHOLDERS.map(([path, title]) => (
          <Route key={path} path={path} element={<Placeholder title={title} />} />
        ))}
        <Route path="agents/:id/merge" element={<MergeScreen />} />
        <Route path="clients/:clientId" element={<ClientDetailScreen />} />
        <Route path="clients/:clientId/connections" element={<OpsConnectionsScreen />} />
        <Route path="clients/:clientId/runs" element={<OpsRunsScreen />} />
        <Route path="runs" element={<OpsRunsScreen />} />
        <Route path="runs/:id" element={<OpsRunScreen />} />
        <Route path="inbox" element={<OpsInboxScreen />} />
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
