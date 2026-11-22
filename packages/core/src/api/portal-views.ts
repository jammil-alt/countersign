import { z } from "zod";
import { isUuid } from "../ids";
import { PortalReportFilter } from "./agent-report";
import { defineRoute } from "./contract";

// R6: the portal's saved views (docs/reporting-plan.md §3 R6, docs/plan.md §1.236). A client
// person names the runs list's filter and opens it again later; a client admin may share one with
// the client's team. A view is its client's (`portal_view`, migration 0098): a shared one never
// reaches another client. Its filter is the portal's RunFilter, so it can't carry the back office's
// keys (cost, errors, test runs, other clients).
//
// Its routes stay out of the web's first-load registry (all-routes.ts): the views strip loads
// lazily on the runs list, and its schemas with it.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const CLIENT = ["client_admin", "client_user"] as const;

// DECISION: a person keeps up to 50 views of their own in a client; shared views count against
// their owner's 50.
export const PORTAL_VIEWS_MAX = 50;

export const PortalViewName = z.string().trim().min(1).max(80);

export const PortalView = z.object({
  id: z.string(),
  name: z.string(),
  filters: PortalReportFilter,
  /** Shared with the client's team (only a client admin shares). */
  shared: z.boolean(),
  /** The view is the reader's own: they may rename or delete it. */
  mine: z.boolean(),
  /** Who made a shared view that isn't the reader's; null for their own. */
  ownerName: z.string().nullable(),
  updatedAt: z.string(),
});
export type PortalView = z.infer<typeof PortalView>;

export const PortalViewBody = z.strictObject({
  name: PortalViewName,
  filters: PortalReportFilter,
  shared: z.boolean().default(false),
});
export type PortalViewBody = z.infer<typeof PortalViewBody>;

export const PortalViewPatch = z
  .strictObject({ name: PortalViewName.optional(), shared: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.shared !== undefined, "nothing to change");

export const portalViewRoutes = {
  portalViews: defineRoute({
    method: "GET",
    path: "/api/views",
    auth: "session",
    roles: CLIENT,
    summary: "Your saved views of the runs list, and those your team shares",
    response: z.object({ views: z.array(PortalView) }),
  }),
  portalCreateView: defineRoute({
    method: "POST",
    path: "/api/views",
    auth: "session",
    roles: CLIENT,
    summary:
      "Save the runs list's filter under a name; an admin may share it with the team (409 name_taken, too_many; 403 not_admin)",
    body: PortalViewBody,
    response: z.object({ view: PortalView }),
  }),
  portalUpdateView: defineRoute({
    method: "PATCH",
    path: "/api/views/:id",
    auth: "session",
    roles: CLIENT,
    summary: "Rename one of your views, or (an admin) share it or stop sharing it",
    params: z.object({ id: Id }),
    body: PortalViewPatch,
    response: z.object({ view: PortalView }),
  }),
  portalDeleteView: defineRoute({
    method: "DELETE",
    path: "/api/views/:id",
    auth: "session",
    roles: CLIENT,
    summary: "Delete one of your views; an admin may also delete a view the team shares",
    params: z.object({ id: Id }),
    response: z.object({ deleted: z.boolean() }),
  }),
} as const;
