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
  feedback: "/ops/feedback",
  requests: "/ops/requests",
  audit: "/ops/audit",
  browserSites: "/ops/browser-sites",
} as const;
