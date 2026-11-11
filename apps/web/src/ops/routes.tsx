// The back office's route map (docs/ui-plan.md, "Back office"), one line per route so each UI
// stream adds or replaces its own line. New routes point at today's screens until their stream
// rebuilds them; every old address redirects to its new home (params, query and hash kept).
//
// The agent page serves everything under `agents/:slug/*` with its tabs (UI cleanup): Overview,
// Workflow (`workflows/:workflow`, the builder, with the agent's triggers at its top), Runs,
// Versions (with the test bench) and Settings (`settings/access`, `settings/definition`); the old
// `triggers` and `tests` addresses redirect. The sidebar lists places only, no client or agent pages.
//
// The route sweep (#141, apps/web/e2e/route-sweep.mjs) reads the `path="…"` lines of this file.

import { Route } from "react-router-dom";
// §1.73: the Marketing area, one file per screen (packs/marketing/ops).
import { MarketingAudienceScreen } from "../packs/marketing/ops/Audience";
import { MarketingClaimsScreen } from "../packs/marketing/ops/Claims";
import { MarketingContentScreen } from "../packs/marketing/ops/Content";
import { MarketingContentPageScreen } from "../packs/marketing/ops/ContentPage";
import { MarketingEntryScreen } from "../packs/marketing/ops/Entry";
import { MarketingForumScreen } from "../packs/marketing/ops/Forum";
import { MarketingJourneysScreen } from "../packs/marketing/ops/Journeys";
import { MarketingOverviewScreen } from "../packs/marketing/ops/Overview";
import { MarketingPageDetailScreen } from "../packs/marketing/ops/PageDetail";
import { MarketingPagesScreen } from "../packs/marketing/ops/Pages";
import { MarketingReportScreen } from "../packs/marketing/ops/Report";
import { MarketingReportsScreen } from "../packs/marketing/ops/Reports";
import { MarketingSearchScreen } from "../packs/marketing/ops/Search";
import { MarketingSitesScreen } from "../packs/marketing/ops/Sites";
import { MarketingSourcesScreen } from "../packs/marketing/ops/Sources";
import { MarketingVisitScreen } from "../packs/marketing/ops/Visit";
import { MarketingVisitsScreen } from "../packs/marketing/ops/Visits";
import {
  // B-6
  OpsClientBankTransactionsScreen,
  OpsClientCatalogScreen,
  OpsClientPacksScreen,
  OpsClientPriceWatchScreen,
  OpsClientReconciliationsScreen,
  // P-9
  OpsClientRequestScreen,
  OpsClientRequestsScreen,
  OpsClientVendorCatalogScreen,
  OpsPacksScreen,
} from "../packs/screens";
import { OpsRecordScreen } from "../records/RecordScreens";
import { Redirect } from "../shell/Redirect";
import { Placeholder } from "../ui/primitives";
import { NewClientAgentScreen } from "./agents/NewClientAgentScreen";
import { NewTemplateScreen, TemplatePage } from "./agents/TemplateScreens";
import { ClientAgentsScreen } from "./client/ClientAgents";
import { OpsClientLedgerScreen } from "./client/ClientLedger";
import { ClientOverviewScreen } from "./client/ClientOverview";
import { CommandCenterScreen } from "./command/CommandCenter";
import { LabScreen } from "./lab/LabScreen";
// R8: the Library (docs/plan.md §1.86)
import { ConditionsBank } from "./library/ConditionsBank";
import { LibraryIndexScreen } from "./library/LibraryIndex";
import { LibraryBrowserSites, LibraryConnectors, LibrarySkills } from "./library/LibraryScreens";
import { ProcessesBank } from "./library/ProcessesBank";
import { RecordTypesBank } from "./library/RecordTypesBank";
import { ToolsBank } from "./library/ToolsBank";
import { TriggersBank } from "./library/TriggersBank";
import { MergeScreen } from "./merge/MergeScreen";
import { AgentPage } from "./screens/AgentPage";
import { OpsAgentRedirect } from "./screens/AgentRedirect";
import { OpsAuditScreen } from "./screens/AuditLog";
import { OpsBillingScreen } from "./screens/Billing";
import { ClientDirectoryRoute } from "./screens/ClientDirectory";
import { ClientKnowledgeRoute } from "./screens/ClientKnowledge";
import { ClientSettingsScreen } from "./screens/ClientSettings";
import { ClientsScreen } from "./screens/Clients";
import { OpsConnectionsScreen } from "./screens/Connections";
import { OpsDocumentScreen, OpsDocumentsScreen } from "./screens/Documents";
import { OpsFeedbackScreen } from "./screens/Feedback";
import { OpsInboxScreen } from "./screens/Inbox";
import { OpsMessagingScreen } from "./screens/Messaging";
import { NewClientScreen } from "./screens/NewClient";
import { OpsOAuthCallbackScreen } from "./screens/OAuthCallback";
import { OpsRecordsScreen } from "./screens/Records";
import { OpsRequestsScreen } from "./screens/Requests";
import { OpsRunAuditScreen } from "./screens/RunAuditQueue";
import { OpsRunsScreen } from "./screens/Runs";
import { OpsRunScreen } from "./screens/RunView";
import { OpsUsageScreen } from "./screens/Usage";
import { AutomationPage } from "./skills/AutomationPage";
import { NewSkillScreen } from "./skills/NewSkill";
import { SkillPage } from "./skills/SkillPage";

export const opsRoutes = (
  <>
    {/* O1 Command center (UI-2a) */}
    <Route index element={<CommandCenterScreen />} />
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
    {/* R8 The Library (docs/plan.md §1.86): the banks the operator builds from. Skills (O4),
        Connectors (O3) and Website logins keep their screens inside it.
        DECISION (library): their old addresses redirect here (below); a skill's and an
        automation's own pages keep theirs. */}
    <Route path="library" element={<LibraryIndexScreen />} />
    <Route path="library/processes" element={<ProcessesBank />} />
    <Route path="library/skills" element={<LibrarySkills />} />
    <Route path="library/tools" element={<ToolsBank />} />
    <Route path="library/connectors" element={<LibraryConnectors />} />
    <Route path="library/browser-sites" element={<LibraryBrowserSites />} />
    <Route path="library/triggers" element={<TriggersBank />} />
    <Route path="library/record-types" element={<RecordTypesBank />} />
    <Route path="library/conditions" element={<ConditionsBank />} />
    {/* O8 New skill, a skill's page and an automation's page (UI-2d) */}
    <Route path="skills/new" element={<NewSkillScreen />} />
    <Route path="skills/:id" element={<SkillPage />} />
    <Route path="skills/automations/:id" element={<AutomationPage />} />

    {/* Clients: the client page with its five tabs (client/ClientFrame.tsx) and new client. Each
        page of the Data and Setup tabs keeps its own address. */}
    <Route path="clients" element={<ClientsScreen />} />
    <Route path="clients/new" element={<NewClientScreen />} />
    <Route path="clients/:clientId" element={<ClientOverviewScreen />} />
    <Route path="clients/:clientId/agents" element={<ClientAgentsScreen />} />
    {/* Data: Documents and Records */}
    <Route path="clients/:clientId/documents" element={<OpsDocumentsScreen />} />
    <Route path="clients/:clientId/documents/:documentId" element={<OpsDocumentScreen />} />
    <Route path="clients/:clientId/records" element={<OpsRecordsScreen />} />
    {/* The client's chart of accounts, classes and locations, changed only with a signature */}
    <Route path="clients/:clientId/ledger" element={<OpsClientLedgerScreen />} />
    <Route path="clients/:clientId/records/:recordId" element={<OpsRecordScreen />} />
    {/* Setup: Connections, Messaging, Directory and Knowledge */}
    <Route path="clients/:clientId/connections" element={<OpsConnectionsScreen />} />
    <Route path="clients/:clientId/messaging" element={<OpsMessagingScreen />} />
    <Route path="clients/:clientId/directory" element={<ClientDirectoryRoute />} />
    <Route path="clients/:clientId/knowledge" element={<ClientKnowledgeRoute />} />
    {/* Settings, one section at a time (General, Approvals, People, Billing, …) */}
    <Route path="clients/:clientId/settings" element={<ClientSettingsScreen />} />
    <Route path="clients/:clientId/settings/:section" element={<ClientSettingsScreen />} />
    {/* The client's runs: the Runs page, filtered to it (linked from the Overview) */}
    <Route path="clients/:clientId/runs" element={<OpsRunsScreen />} />
    {/* Usage, billing, feedback, audit, website logins, requests (UI-3) */}
    <Route path="usage" element={<OpsUsageScreen />} />
    <Route path="billing" element={<OpsBillingScreen />} />
    {/* Utilities: feedback, the audit queue, the audit log and requests, a tab each. Website
        logins are in the Library (R8): main's Websites tab redirects there. */}
    <Route path="utilities" element={<Redirect to="/ops/utilities/feedback" />} />
    <Route path="utilities/feedback" element={<OpsFeedbackScreen />} />
    {/* Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): runs picked for a person to check */}
    <Route path="utilities/run-audit" element={<OpsRunAuditScreen />} />
    <Route path="utilities/audit" element={<OpsAuditScreen />} />
    <Route path="utilities/requests" element={<OpsRequestsScreen />} />
    <Route path="utilities/websites" element={<Redirect to="/ops/library/browser-sites" />} />
    <Route path="feedback" element={<Redirect to="/ops/utilities/feedback" />} />
    <Route path="run-audit" element={<Redirect to="/ops/utilities/run-audit" />} />
    <Route path="audit" element={<Redirect to="/ops/utilities/audit" />} />
    <Route path="requests" element={<Redirect to="/ops/utilities/requests" />} />
    {/* Packs (P-1): switch a business area on per client, and a client's pack reports */}
    <Route path="packs" element={<OpsPacksScreen />} />
    <Route path="clients/:clientId/packs" element={<OpsClientPacksScreen />} />
    <Route
      path="clients/:clientId/reports/materials/prices"
      element={<OpsClientPriceWatchScreen />}
    />
    <Route
      path="clients/:clientId/reports/materials/catalog"
      element={<OpsClientCatalogScreen />}
    />
    {/* §1.88: a master item's page, its vendors side by side */}
    <Route
      path="clients/:clientId/reports/materials/catalog/:id"
      element={<OpsClientCatalogScreen />}
    />
    {/* §1.88: a client's vendor catalog, and one vendor's */}
    <Route
      path="clients/:clientId/reports/materials/vendor-catalog"
      element={<OpsClientVendorCatalogScreen />}
    />
    <Route
      path="clients/:clientId/reports/materials/vendor-catalog/:id"
      element={<OpsClientVendorCatalogScreen />}
    />
    {/* P-9: a client's purchase requests and one request's page */}
    <Route
      path="clients/:clientId/reports/materials/requests"
      element={<OpsClientRequestsScreen />}
    />
    <Route
      path="clients/:clientId/reports/materials/requests/:id"
      element={<OpsClientRequestScreen />}
    />
    {/* B-6 (docs/plan.md §1.79): a client's bank transactions, account links, rules and chart */}
    <Route
      path="clients/:clientId/reports/bookkeeping/transactions"
      element={<OpsClientBankTransactionsScreen />}
    />
    {/* R-1 (docs/plan.md §1.80): a client's reconciliations */}
    <Route
      path="clients/:clientId/reports/bookkeeping/reconciliations"
      element={<OpsClientReconciliationsScreen />}
    />
    {/* §1.73: the Marketing area (docs/marketing-plan.md §4.7, §11): the entry opens our own
        client with the pack on; each of a client's marketing pages is one line. */}
    <Route path="marketing" element={<MarketingEntryScreen />} />
    <Route
      path="clients/:clientId/marketing"
      element={<Redirect to="/ops/clients/:clientId/marketing/overview" />}
    />
    <Route path="clients/:clientId/marketing/overview" element={<MarketingOverviewScreen />} />
    <Route path="clients/:clientId/marketing/pages" element={<MarketingPagesScreen />} />
    <Route
      path="clients/:clientId/marketing/pages/detail"
      element={<MarketingPageDetailScreen />}
    />
    <Route path="clients/:clientId/marketing/sources" element={<MarketingSourcesScreen />} />
    <Route path="clients/:clientId/marketing/journeys" element={<MarketingJourneysScreen />} />
    <Route path="clients/:clientId/marketing/audience" element={<MarketingAudienceScreen />} />
    <Route path="clients/:clientId/marketing/visits" element={<MarketingVisitsScreen />} />
    <Route path="clients/:clientId/marketing/visits/:visit" element={<MarketingVisitScreen />} />
    <Route path="clients/:clientId/marketing/search" element={<MarketingSearchScreen />} />
    <Route path="clients/:clientId/marketing/content" element={<MarketingContentScreen />} />
    <Route
      path="clients/:clientId/marketing/content/:pageId"
      element={<MarketingContentPageScreen />}
    />
    <Route path="clients/:clientId/marketing/claims" element={<MarketingClaimsScreen />} />
    <Route path="clients/:clientId/marketing/reports" element={<MarketingReportsScreen />} />
    <Route path="clients/:clientId/marketing/reports/:id" element={<MarketingReportScreen />} />
    <Route path="clients/:clientId/marketing/forum" element={<MarketingForumScreen />} />
    <Route path="clients/:clientId/marketing/sites" element={<MarketingSitesScreen />} />
    {/* M50: the client page's pack links name the portal's reports; each opens its page here. */}
    <Route
      path="clients/:clientId/reports/marketing/overview"
      element={<Redirect to="/ops/clients/:clientId/marketing/overview" />}
    />
    <Route
      path="clients/:clientId/reports/marketing/search"
      element={<Redirect to="/ops/clients/:clientId/marketing/search" />}
    />
    <Route
      path="clients/:clientId/reports/marketing/weekly-report"
      element={<Redirect to="/ops/clients/:clientId/marketing/reports" />}
    />
    {/* ARCHITECTURE §15 screens not built yet */}
    <Route path="settings" element={<Placeholder title="Settings" />} />

    {/* An address a provider sends the browser back to: it never moves. */}
    <Route path="connections/:connector/callback" element={<OpsOAuthCallbackScreen />} />

    {/* Old addresses → their new homes */}
    <Route path="templates" element={<Redirect to="/ops/lab" />} />
    <Route path="skills" element={<Redirect to="/ops/library/skills" />} />
    <Route path="connectors" element={<Redirect to="/ops/library/connectors" />} />
    <Route path="browser-sites" element={<Redirect to="/ops/library/browser-sites" />} />
    <Route
      path="clients/:clientId/data"
      element={<Redirect to="/ops/clients/:clientId/documents" />}
    />
    <Route
      path="clients/:clientId/setup"
      element={<Redirect to="/ops/clients/:clientId/connections" />}
    />
    <Route
      path="clients/:clientId/exports"
      element={<Redirect to="/ops/clients/:clientId/settings/exports" />}
    />
  </>
);
