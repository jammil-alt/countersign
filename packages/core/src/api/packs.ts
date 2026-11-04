import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

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
export const ReportName = z.string().regex(/^[a-z][a-z0-9_-]*(\.csv)?$/, "a report name");

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

/** A pack report: the pack's own shape (see the pack's screens in apps/web). */
export const PackReport = z.object({ report: z.record(z.string(), z.unknown()) });

export const PackReviewDecision = z.strictObject({
  docLineId: Id,
  action: z.enum(["match", "new_item", "skip"]),
  /** The catalog item, for `match`. */
  catalogItemId: Id.optional(),
});
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
    summary: "A client's pack report, as the client sees it; `<report>.csv` for the CSV file",
    params: z.object({ id: Id, pack: Slug, report: ReportName }),
    response: PackReport,
  }),
  portalPacks: defineRoute({
    method: "GET",
    path: "/api/packs",
    auth: "session",
    roles: CLIENT,
    summary: "The packs on for this client, with their report screens",
    response: z.object({ packs: z.array(ClientPack) }),
  }),
  portalPackReport: defineRoute({
    method: "GET",
    path: "/api/reports/:pack/:report",
    auth: "session",
    roles: CLIENT,
    summary: "A pack report (e.g. materials/prices); `<report>.csv` for the CSV file",
    params: ReportParams,
    response: PackReport,
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
