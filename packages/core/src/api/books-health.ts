// Books health (docs/plan.md §1.216): the one-page report on a client's QuickBooks, for its owner
// in the portal and for us in the back office. Read only: the checks run on what we synced.

import { z } from "zod";
import { BooksHealthReport } from "../books-health/schemas";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const BooksHealthView = z.object({
  /** The QuickBooks company read, or null when none is connected. */
  company: z.object({ name: z.string().nullable(), lastSyncAt: z.string().nullable() }).nullable(),
  /** Null before the first sync. */
  report: BooksHealthReport.nullable(),
  /** The packs the client has switched on, so a finding can say whether its fix is on. */
  packs: z.array(z.string()),
});
export type BooksHealthView = z.infer<typeof BooksHealthView>;

export const booksHealthRoutes = {
  portalBooksHealth: defineRoute({
    method: "GET",
    path: "/api/books-health",
    auth: "session",
    roles: ["client_admin"],
    summary: "The client's books health: what the checks find in its QuickBooks, by dollars",
    response: BooksHealthView,
  }),
  opsClientBooksHealth: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/books-health",
    auth: "session",
    roles: ["operator"],
    summary: "A client's books health: what the checks find in its QuickBooks, by dollars",
    params: z.object({ id: Id }),
    response: BooksHealthView,
  }),
};
