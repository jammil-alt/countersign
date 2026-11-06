// Where each back-office page lives, for the sidebar and links (the routes: ./routes.tsx).
export const OPS_PATHS = {
  command: "/ops",
  escalations: "/ops/inbox",
  runs: "/ops/runs",
  clients: "/ops/clients",
  client: (id: string) => `/ops/clients/${id}`,
  lab: "/ops/lab",
  skills: "/ops/skills",
  connectors: "/ops/connectors",
  usage: "/ops/usage",
  billing: "/ops/billing",
  feedback: "/ops/feedback",
  requests: "/ops/requests",
  audit: "/ops/audit",
  browserSites: "/ops/browser-sites",
} as const;
