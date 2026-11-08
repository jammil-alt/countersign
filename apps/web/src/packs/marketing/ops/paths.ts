// Where each of a client's Marketing pages lives in the back office (docs/marketing-plan.md §11,
// the wave contract). The routes are in ../../../ops/routes.tsx, one line each; every screen is
// its own file in this folder and renders inside MarketingLayout (./layout.tsx).

const base = (clientId: string) => `/ops/clients/${clientId}/marketing`;

export const MARKETING_PATHS = {
  /** The entry in the sidebar: our own client with the pack on, or a picker. */
  entry: "/ops/marketing",
  base,
  overview: (clientId: string) => `${base(clientId)}/overview`,
  pages: (clientId: string) => `${base(clientId)}/pages`,
  /** One page in depth; the path is a query parameter (`?path=/pricing`). */
  page: (clientId: string, path: string) =>
    `${base(clientId)}/pages/detail?path=${encodeURIComponent(path)}`,
  sources: (clientId: string) => `${base(clientId)}/sources`,
  journeys: (clientId: string) => `${base(clientId)}/journeys`,
  audience: (clientId: string) => `${base(clientId)}/audience`,
  visits: (clientId: string) => `${base(clientId)}/visits`,
  visit: (clientId: string, visit: string) =>
    `${base(clientId)}/visits/${encodeURIComponent(visit)}`,
  search: (clientId: string) => `${base(clientId)}/search`,
  content: (clientId: string) => `${base(clientId)}/content`,
  contentPage: (clientId: string, pageId: string) => `${base(clientId)}/content/${pageId}`,
  claims: (clientId: string) => `${base(clientId)}/claims`,
  reports: (clientId: string) => `${base(clientId)}/reports`,
  report: (clientId: string, id: string) => `${base(clientId)}/reports/${id}`,
  forum: (clientId: string) => `${base(clientId)}/forum`,
  sites: (clientId: string) => `${base(clientId)}/sites`,
} as const;

export type MarketingSection =
  | "overview"
  | "pages"
  | "sources"
  | "journeys"
  | "audience"
  | "visits"
  | "search"
  | "content"
  | "claims"
  | "reports"
  | "forum"
  | "sites";

/** The area's sub-navigation, in order. A page in depth belongs to its list's section. */
export const MARKETING_NAV: readonly { id: MarketingSection; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pages", label: "Pages" },
  { id: "sources", label: "Sources" },
  { id: "journeys", label: "Journeys" },
  { id: "audience", label: "Audience" },
  { id: "visits", label: "Visits" },
  { id: "search", label: "Search" },
  { id: "content", label: "Content" },
  { id: "claims", label: "Claims" },
  { id: "reports", label: "Weekly report" },
  { id: "forum", label: "Forum" },
  { id: "sites", label: "Sites" },
];

/** The section an address under the client's marketing pages is in. */
export function sectionOf(pathname: string, clientId: string): MarketingSection {
  const rest = pathname.startsWith(base(clientId))
    ? pathname.slice(base(clientId).length).replace(/^\//, "")
    : "";
  const first = rest.split("/")[0] ?? "";
  return MARKETING_NAV.find((s) => s.id === first)?.id ?? "overview";
}
