import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { ExportFile } from "./exports";

// Packs (ARCHITECTURE §12.1, §14; docs/plan.md §1.13): the back office lists the deployment's packs
// and enables one for a client, which installs the pack's templates once; pack reports
// (`/api/reports/:pack/:report`, and `<report>.csv`) for the portal and, per client, the back
// office; and the pack's review card for an inbox item (e.g. the Materials match review). The
// platform names no pack: a report's and a review's shape is the pack's own, typed here as an
// object, and the contract tests check no portal response carries forbidden fields.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/);
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

/** `prices` or `prices.csv`: a report name, optionally as CSV. */
// P-1: a report's CSV is its own route (`…/csv`, served by mountFile), so a name has no extension.
export const ReportName = z.string().regex(/^[a-z][a-z0-9_-]*$/, "a report name");

export const PackTemplateInfo = z.object({
  slug: z.string(),
  name: z.string(),
  /** The template row once installed, else null. */
  templateId: z.string().nullable(),
});

export const PackInfo = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  templates: z.array(PackTemplateInfo),
  /** Client report screens it adds to the portal. */
  screens: z.array(z.object({ route: z.string(), title: z.string() })),
  clients: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      enabledAt: z.string().nullable(),
    }),
  ),
});
export type PackInfo = z.infer<typeof PackInfo>;

export const ClientPack = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  screens: z.array(z.object({ route: z.string(), title: z.string() })),
});
export type ClientPack = z.infer<typeof ClientPack>;

export const EnablePackResponse = z.object({
  pack: ClientPack,
  /** Templates installed by this call (empty when they were installed before). */
  installed: z.array(z.object({ slug: z.string(), templateId: z.string() })),
});

/**
 * §1.73: a pack report's query parameters (e.g. `?site=…&from=…&to=…`), passed through as strings;
 * the pack's report handler validates them with its own schema (a bad one is a 400). `client`
 * is the session's active client and is never passed to the pack.
 */
export const PackReportQuery = z.record(
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "a query parameter name"),
  z.string().max(500),
);
export type PackReportQuery = z.infer<typeof PackReportQuery>;

/** A pack report: the pack's own shape (see the pack's screens in apps/web). */
export const PackReport = z.object({ report: z.record(z.string(), z.unknown()) });

export const PackReviewDecision = z.union([
  z.strictObject({
    docLineId: Id,
    action: z.enum(["match", "new_item", "skip"]),
    /** The catalog item, for `match`. */
    catalogItemId: Id.optional(),
  }),
  // P-9: any other card's decision, which the pack's own handler checks (docs/plan.md §1.71).
  z.strictObject({
    action: z.string().regex(/^[a-z][a-z_]{0,39}$/),
    input: z.record(z.string(), z.unknown()),
  }),
]);
export type PackReviewDecision = z.infer<typeof PackReviewDecision>;

export const PackReview = z.object({
  /** Which pack card renders it (e.g. `materials.match`). */
  review: z.string(),
  status: z.string(),
  /** Whether this person may decide it. */
  canDecide: z.boolean(),
  data: z.record(z.string(), z.unknown()),
});

const ClientParams = z.object({ id: Id });
const ReportParams = z.object({ pack: Slug, report: ReportName });

export const packRoutes = {
  opsPacks: defineRoute({
    method: "GET",
    path: "/api/ops/packs",
    auth: "session",
    roles: OPS,
    summary: "The deployment's packs: their templates and which of your clients have each on",
    response: z.object({ packs: z.array(PackInfo) }),
  }),
  opsClientPacks: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/packs",
    auth: "session",
    roles: OPS,
    summary: "The packs a client can have, and which are on",
    params: ClientParams,
    response: z.object({ packs: z.array(ClientPack) }),
  }),
  opsEnableClientPack: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/packs/:pack/enable",
    auth: "session",
    roles: OPS,
    summary: "Switch a pack on for a client; installs its templates the first time (once)",
    params: z.object({ id: Id, pack: Slug }),
    response: EnablePackResponse,
  }),
  opsClientPackReport: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/reports/:pack/:report",
    auth: "session",
    roles: OPS,
    summary: "A client's pack report, as the client sees it",
    params: z.object({ id: Id, pack: Slug, report: ReportName }),
    query: PackReportQuery,
    response: PackReport,
  }),
  opsClientPackReportCsv: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/reports/:pack/:report/csv",
    auth: "session",
    roles: OPS,
    summary: "A client's pack report as a CSV file",
    params: z.object({ id: Id, pack: Slug, report: ReportName }),
    query: PackReportQuery,
    response: ExportFile,
  }),
  opsClientPackAction: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/packs/:pack/actions/:action",
    auth: "session",
    roles: OPS,
    summary: "A person's action on a client's pack data (e.g. merge two catalog items)",
    params: z.object({ id: Id, pack: Slug, action: Slug }),
    body: z.record(z.string(), z.unknown()),
    response: z.object({ result: z.record(z.string(), z.unknown()) }),
  }),
  // M46 (docs/plan.md §1.76): a short-lived link to a page a pack renders for a person to read
  // before it is public (a guide's draft): signed, noindex, and only for a report item the pack
  // declares a preview.
  opsClientPackPreview: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/packs/:pack/previews",
    auth: "session",
    roles: OPS,
    summary: "A preview link for one of a pack's pages, before it is public (a guide's draft)",
    params: z.object({ id: Id, pack: Slug }),
    body: z.object({ report: ReportName, itemId: Id }),
    response: z.object({ url: z.string(), expiresAt: z.string() }),
  }),
  packPreview: defineRoute({
    method: "GET",
    path: "/api/preview/:token",
    auth: "public",
    roles: [],
    summary: "A preview link's page (HTML, noindex); 404 once it has expired",
    params: z.object({ token: z.string() }),
    response: z.string(),
  }),
  // M43 (docs/plan.md §1.72): what a pack takes from outside, with no session (a measured site's
  // beacon, for the Marketing pack). The platform checks the client has the pack on and caps the
  // body; the pack decides. Always 204 with no body, so a sender learns nothing about which
  // clients, packs or targets exist.
  packInbound: defineRoute({
    method: "POST",
    path: "/api/in/:pack/:tenantId/:target",
    auth: "public",
    roles: [],
    summary: "Something a pack takes from outside, e.g. a measured website's beacon (always 204)",
    params: z.object({ pack: Slug, tenantId: z.string(), target: z.string() }),
    response: z.literal(""),
  }),
  portalPacks: defineRoute({
    method: "GET",
    path: "/api/packs",
    auth: "session",
    roles: CLIENT,
    summary: "The packs on for this client, with their report screens",
    response: z.object({ packs: z.array(ClientPack) }),
  }),
  // P-9: one row of a pack report in full (e.g. a purchase request), docs/plan.md §1.71.
  portalPackReportItem: defineRoute({
    method: "GET",
    path: "/api/reports/:pack/:report/items/:itemId",
    auth: "session",
    roles: CLIENT,
    summary: "One row of a pack report in full (e.g. materials/requests: one request)",
    params: ReportParams.extend({ itemId: Id }),
    query: PackReportQuery,
    response: PackReport,
  }),
  opsClientPackReportItem: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/reports/:pack/:report/items/:itemId",
    auth: "session",
    roles: OPS,
    summary: "One row of a client's pack report in full, as the client sees it",
    params: z.object({ id: Id, pack: Slug, report: ReportName, itemId: Id }),
    query: PackReportQuery,
    response: PackReport,
  }),
  portalPackReport: defineRoute({
    method: "GET",
    path: "/api/reports/:pack/:report",
    auth: "session",
    roles: CLIENT,
    summary: "A pack report (e.g. materials/prices)",
    params: ReportParams,
    query: PackReportQuery,
    response: PackReport,
  }),
  portalPackReportCsv: defineRoute({
    method: "GET",
    path: "/api/reports/:pack/:report/csv",
    auth: "session",
    roles: CLIENT,
    summary: "A pack report as a CSV file",
    params: ReportParams,
    query: PackReportQuery,
    response: ExportFile,
  }),
  portalPackReview: defineRoute({
    method: "GET",
    path: "/api/inbox/:id/pack-review",
    auth: "session",
    roles: CLIENT,
    summary: "What a pack's review item asks (e.g. invoice lines to match)",
    params: z.object({ id: Id }),
    response: PackReview,
  }),
  portalPackReviewDecide: defineRoute({
    method: "POST",
    path: "/api/inbox/:id/pack-review",
    auth: "session",
    roles: CLIENT,
    summary: "Decide one line of a pack's review item (match, new item or skip)",
    params: z.object({ id: Id }),
    body: PackReviewDecision,
    response: PackReview,
  }),
  opsPackReview: defineRoute({
    method: "GET",
    path: "/api/ops/inbox/:id/pack-review",
    auth: "session",
    roles: OPS,
    summary: "What a pack's review item asks, for any client you serve",
    params: z.object({ id: Id }),
    response: PackReview,
  }),
  opsPackReviewDecide: defineRoute({
    method: "POST",
    path: "/api/ops/inbox/:id/pack-review",
    auth: "session",
    roles: OPS,
    summary: "Decide one line of a pack's review item assigned to the operator",
    params: z.object({ id: Id }),
    body: PackReviewDecision,
    response: PackReview,
  }),
} as const;
