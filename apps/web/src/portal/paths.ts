// Where each portal page lives, for the sidebar and links (the routes: ./routes.tsx). The sidebar
// lists places (Home, Inbox, Runs, Connectors, Contacts); everything else is reached from the thing
// it belongs to: an agent, a run, Settings, or the search box (Sloan).
export const PORTAL_PATHS = {
  home: "/",
  // §1.149.2: Getting started (the welcome page goes on here after sign-in).
  start: "/start",
  // docs/setup-plan.md (§1.206): Getting started's chapters; See it work and Go live per agent.
  // DECISION: under `/getting-started`, not `/start`: `/start/:token` is the invite's welcome page.
  startTools: "/getting-started/tools",
  startPeople: "/getting-started/people",
  startSee: (agentId?: string | null) =>
    agentId ? `/getting-started/see/${agentId}` : "/getting-started/see",
  startLive: (agentId?: string | null) =>
    agentId ? `/getting-started/live/${agentId}` : "/getting-started/live",
  inbox: "/inbox",
  runs: "/runs",
  // DECISION: the portal addresses an agent by its service id (`/agents/:id`), not a slug: every
  // portal route takes the service id, so no lookup is needed (the service route names the
  // template's slug only to pick the agent's own view).
  agent: (serviceId: string) => `/agents/${serviceId}`,
  agentRuns: (serviceId: string) => `/agents/${serviceId}/runs`,
  // docs/sop-plan.md S1: the agent's SOP, in the manual's place (its old address goes there).
  agentSop: (serviceId: string) => `/agents/${serviceId}/sop`,
  // R4 (docs/plan.md §1.214)
  agentReport: (serviceId: string) => `/agents/${serviceId}/report`,
  // docs/sop-plan.md §6a: the process as the builder's chart, read only (the Workflow tab). Its
  // address says "flow": no portal path names a workflow, which is the operator's to set up.
  agentFlow: (serviceId: string) => `/agents/${serviceId}/flow`,
  // The Access tab became Agent settings (2026-11-11); `/agents/:id/access` lands here.
  agentSettings: (serviceId: string) => `/agents/${serviceId}/settings`,
  // Connectors C5 (docs/connectors-plan.md §3): the client's one place for their tools. Accounts
  // and its vault rail retired; `/accounts` and `/accounts#vault` land here.
  connectors: "/connectors",
  // Website logins (the vault's rows) are under Built for you.
  vault: "/connectors#vault",
  // A connector's page; `?for=` picks the agent whose needs it marks.
  connector: (connector: string, forAgent?: string | null) =>
    `/connectors/${encodeURIComponent(connector)}${forAgent ? `?for=${encodeURIComponent(forAgent)}` : ""}`,
  contacts: "/contacts",
  // Organizations are a filter of the Contacts list; import is an action on it.
  organizations: "/contacts?show=organizations",
  contactsImport: "/contacts?import=1",
  settings: "/settings",
  approvals: "/settings/approvals",
  team: "/settings/team",
  // R8 (docs/plan.md §1.86): the client's week, zone and closed dates; numbers and addresses.
  businessHours: "/settings/hours",
  channels: "/settings/channels",
  billing: "/settings/billing",
  exports: "/settings/exports",
  conversations: "/settings/conversations",
  // docs/builder-plan.md §8: the client's charter and policies, for the client admin.
  charter: "/settings/charter",
  voice: "/settings/voice",
  // P-8: US texting registration (docs/plan.md §1.70)
  texting: "/settings/texting",
  // Off the nav: reached from an agent, a run, Home or Sloan.
  reports: "/reports",
  records: "/records",
  // §1.124: the client's Requests (its issues and asks), each a conversation with the lead.
  requests: "/requests",
  request: (id: string) => `/requests/${id}`,
  requirements: (itemId: string) => `/requirements/${itemId}`,
  // QA round 1: asking for a change is a mode of Sloan, which stays.
  sloanChange: "/sloan?mode=change",
  knowledge: "/knowledge",
  weekly: "/weekly",
  sloan: "/sloan",
  upload: "/upload",
  // Old names, kept so screens other streams own still build: the Desk is the Inbox now.
  desk: "/inbox",
  table: "/",
} as const;

/** Sloan with a question ready to send: `/sloan?ask=…` (the search box's "Ask Sloan"). */
export function askSloan(text: string): string {
  return `${PORTAL_PATHS.sloan}?ask=${encodeURIComponent(text)}`;
}
