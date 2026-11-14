// Where each back-office page lives, for the sidebar and links (the routes: ./routes.tsx).
export const OPS_PATHS = {
  command: "/ops",
  escalations: "/ops/inbox",
  runs: "/ops/runs",
  clients: "/ops/clients",
  client: (id: string) => `/ops/clients/${id}`,
  /** docs/plan.md §1.101: Reggie; `askReggie` starts a conversation about one client. */
  reggie: "/ops/reggie",
  askReggie: (clientId: string) => `/ops/reggie?client=${clientId}`,
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
  // R8: the Library holds the banks the operator builds from (./library/paths.ts has each bank's).
  library: "/ops/library",
  skills: "/ops/library/skills",
  connectors: "/ops/library/connectors",
  packs: "/ops/packs",
  usage: "/ops/usage",
  billing: "/ops/billing",
  // Utilities: one sidebar entry, a tab each (./screens/UtilitiesTabs.tsx). The old addresses
  // (/ops/feedback, /ops/audit, /ops/requests, /ops/run-audit) redirect here.
  utilities: "/ops/utilities",
  feedback: "/ops/utilities/feedback",
  requests: "/ops/utilities/requests",
  audit: "/ops/utilities/audit",
  // Wave 6: the audit queue (runs picked for a person to check), a Utilities tab.
  runAudit: "/ops/utilities/run-audit",
  // R8: website logins are connectors, in the Library (/ops/browser-sites and
  // /ops/utilities/websites redirect here).
  browserSites: "/ops/library/browser-sites",
  // §1.73: the Marketing area's entry; a client's marketing pages are in packs/marketing/ops/paths.ts.
  marketing: "/ops/marketing",
} as const;
