// The Security section's pages (docs/plan.md §1.100; the routes: ../routes.tsx).
export const SECURITY_PATHS = {
  overview: "/ops/security",
  controls: "/ops/security/controls",
  vendors: "/ops/security/vendors",
  policies: "/ops/security/policies",
  clients: "/ops/security/clients",
  client: (id: string) => `/ops/security/clients/${id}`,
  // Moved from Utilities: /ops/audit and /ops/utilities/audit redirect here.
  audit: "/ops/security/audit",
} as const;
