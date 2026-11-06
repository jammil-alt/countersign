// Where each portal page lives, for the sidebar and links (the routes: ./routes.tsx).
export const PORTAL_PATHS = {
  table: "/",
  desk: "/desk",
  runs: "/runs",
  // DECISION: the portal addresses an agent by its service id (`/agents/:id`), not a slug: every
  // portal route takes the service id and none returns a slug, so no lookup is needed.
  agent: (serviceId: string) => `/agents/${serviceId}`,
  accounts: "/accounts",
  vault: "/accounts/access",
  people: "/people",
  directory: "/people/directory",
  contacts: "/people/contacts",
  settings: "/settings",
  billing: "/settings/billing",
  reports: "/reports",
  records: "/records",
  requests: "/requests",
  knowledge: "/knowledge",
  conversations: "/conversations",
  // UI-1d
  weekly: "/weekly",
  sloan: "/sloan",
} as const;
