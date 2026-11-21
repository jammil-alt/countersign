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
  /**
   * docs/plan.md §1.108: builds, from intake to go-live. The board is the Agent lab's Drafts tab
   * (owner, 2026-11-17); `/ops/builds` redirects there. New starts a build from the lab.
   */
  builds: "/ops/builds",
  labDrafts: "/ops/lab?tab=drafts",
  labNew: (kind: "template" | "client" | "skill" = "template") => `/ops/lab?tab=drafts&new=${kind}`,
  build: (id: string) => `/ops/builds/${id}`,
  /** docs/plan.md §1.170: a new agent build's Check the steps, after Describe it. */
  buildCheck: (id: string) => `/ops/lab/check/${id}`,
  // O5 New agent, O6 Workflow builder, O7 Triggers (UI-2c), under the agent page (UI-2b).
  newTemplate: "/ops/templates/new",
  newAgent: (clientId: string) => `/ops/clients/${clientId}/agents/new`,
  agent: (clientId: string, slug: string) => `/ops/clients/${clientId}/agents/${slug}`,
  /** Opens the builder on the agent's first workflow. */
  agentWorkflow: (clientId: string, slug: string) =>
    `/ops/clients/${clientId}/agents/${slug}/workflow`,
  agentTriggers: (clientId: string, slug: string) =>
    `/ops/clients/${clientId}/agents/${slug}/triggers`,
  /** §1.163: what the client sees for the agent in their portal, read only. */
  agentClientView: (clientId: string, slug: string) =>
    `/ops/clients/${clientId}/agents/${slug}/client-view`,
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
  // §1.124: requests are issues and asks in Build now; the old addresses redirect to its Issues.
  requests: "/ops/build/issues",
  // §1.102: the audit log is a tab of Security and compliance (./security/paths.ts).
  audit: "/ops/security/audit",
  security: "/ops/security",
  // §1.122: Mezonas's own people (operators): invite, give clients, remove.
  users: "/ops/users",
  // Wave 6: the audit queue (runs picked for a person to check), a Utilities tab.
  runAudit: "/ops/utilities/run-audit",
  // R8: website logins are connectors, in the Library (/ops/browser-sites and
  // /ops/utilities/websites redirect here).
  browserSites: "/ops/library/browser-sites",
  // §1.73: the Marketing area's entry; a client's marketing pages are in packs/marketing/ops/paths.ts.
  marketing: "/ops/marketing",
  // §1.124 back office work: Build (issues, agent builds, enhancements) and its records.
  buildWork: "/ops/build",
  buildTab: (tab: "all" | "issues" | "builds" | "enh") =>
    tab === "all" ? "/ops/build" : `/ops/build/${tab}`,
  issue: (id: string) => `/ops/issues/${id}`,
  newIssue: "/ops/issues/new",
  enhancement: (id: string) => `/ops/enhancements/${id}`,
  // §1.124 back office work: Sales (All deals, New accounts, Expansion) and a deal.
  sales: "/ops/sales",
  salesTab: (tab: "all" | "new" | "grow") => `/ops/sales/${tab}`,
  deal: (id: string) => `/ops/deals/${id}`,
  // §1.124.3: Your call, the one list of what needs a person.
  call: "/ops/call",
  // §1.124.4 back office work: Autopilot (what Reggie does in each stage, and how far).
  autopilot: "/ops/autopilot",
  autopilotFlow: (flow: string) => `/ops/autopilot/${flow}`,
} as const;
