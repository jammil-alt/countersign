// Where each portal page lives, for the sidebar and links (the routes: ./routes.tsx). The sidebar
// lists places (Home, Inbox, Runs, Accounts, Contacts); everything else is reached from the thing
// it belongs to: an agent, a run, Settings, or the search box (Sloan).
export const PORTAL_PATHS = {
  home: "/",
  inbox: "/inbox",
  runs: "/runs",
  // DECISION: the portal addresses an agent by its service id (`/agents/:id`), not a slug: every
  // portal route takes the service id, so no lookup is needed (the service route names the
  // template's slug only to pick the agent's own view).
  agent: (serviceId: string) => `/agents/${serviceId}`,
  agentRuns: (serviceId: string) => `/agents/${serviceId}/runs`,
  agentAccess: (serviceId: string) => `/agents/${serviceId}/access`,
  accounts: "/accounts",
  // The vault is the Accounts page's right rail.
  vault: "/accounts#vault",
  contacts: "/contacts",
  // Organizations are a filter of the Contacts list; import is an action on it.
  organizations: "/contacts?show=organizations",
  contactsImport: "/contacts?import=1",
  settings: "/settings",
  approvals: "/settings/approvals",
  team: "/settings/team",
  billing: "/settings/billing",
  exports: "/settings/exports",
  conversations: "/settings/conversations",
  voice: "/settings/voice",
  // Off the nav: reached from an agent, a run, Home or Sloan.
  reports: "/reports",
  records: "/records",
  requests: "/requests",
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
