// Where each portal page lives, for the sidebar and links (the routes: ./routes.tsx).
export const PORTAL_PATHS = {
  table: "/",
  desk: "/desk",
  runs: "/runs",
  // DECISION: the portal addresses an agent by its service id (`/agents/:id`), not a slug: every
  // portal route takes the service id and none returns a slug, so no lookup is needed.
  agent: (serviceId: string) => `/agents/${serviceId}`,
  accounts: "/accounts",
  // The vault is the Accounts page's right rail.
  vault: "/accounts#vault",
  people: "/people",
  organizations: "/people/organizations",
  contacts: "/people/contacts",
  reach: "/people/reach",
  voice: "/people/voice",
  peopleImport: "/people/import",
  settings: "/settings",
  billing: "/settings/billing",
  // Not in the sidebar (QA round 1): the agent page links its reports.
  reports: "/reports",
  records: "/records",
  // QA round 1: asking for a change is a mode of Sloan; `/requests` redirects here.
  requests: "/sloan?mode=change",
  knowledge: "/knowledge",
  conversations: "/conversations",
  // QA round 1: the Weekly Table is a view of The Table; `/weekly` redirects here.
  weekly: "/?view=weekly",
  sloan: "/sloan",
  // UI-3a. Upload's one entry is Records' "Upload documents" (QA round 1).
  upload: "/upload",
  team: "/settings/team",
  exports: "/settings/exports",
} as const;
