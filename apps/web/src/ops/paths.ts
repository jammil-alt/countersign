// Where each back-office page lives, for the sidebar and links (the routes: ./routes.tsx).
export const OPS_PATHS = {
  command: "/ops",
  escalations: "/ops/inbox",
  runs: "/ops/runs",
  clients: "/ops/clients",
  client: (id: string) => `/ops/clients/${id}`,
  lab: "/ops/lab",
  // O5 New agent, O6 Workflow builder, O7 Triggers (UI-2c), under the agent page (UI-2b).
  newTemplate: "/ops/templates/new",
  newAgent: (clientId: string) => `/ops/clients/${clientId}/agents/new`,
  agent: (clientId: string, slug: string) => `/ops/clients/${clientId}/agents/${slug}`,
  /** Opens the builder on the agent's first workflow. */
  agentWorkflow: (clientId: string, slug: string) =>
    `/ops/clients/${clientId}/agents/${slug}/workflow`,
  agentTriggers: (clientId: string, slug: string) =>
    `/ops/clients/${clientId}/agents/${slug}/triggers`,
  skills: "/ops/skills",
  connectors: "/ops/connectors",
  packs: "/ops/packs",
  usage: "/ops/usage",
  billing: "/ops/billing",
  // Utilities: one sidebar entry, a tab each (./screens/UtilitiesTabs.tsx). The old addresses
  // (/ops/feedback, /ops/audit, /ops/requests, /ops/browser-sites) redirect here.
  utilities: "/ops/utilities",
  feedback: "/ops/utilities/feedback",
  requests: "/ops/utilities/requests",
  audit: "/ops/utilities/audit",
  browserSites: "/ops/utilities/websites",
  // §1.73: the Marketing area's entry; a client's marketing pages are in packs/marketing/ops/paths.ts.
  marketing: "/ops/marketing",
} as const;
