// Where a client's people email and text Sloan (docs/plan.md §1.124): its own address on the
// forwarding domain and the account's number. The portal shows it on Sloan's page; the back office
// on the client's, to pass on.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const SloanReachView = z.object({
  /** Sloan's address; null when email isn't set up here or Sloan is off. */
  email: z.string().nullable(),
  /** The account's number for texts (E.164); null when it has none that can text yet. */
  phone: z.string().nullable(),
});
export type SloanReachView = z.infer<typeof SloanReachView>;

export const sloanReachRoutes = {
  portalSloanReach: defineRoute({
    method: "GET",
    path: "/api/sloan/reach",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary: "Where you can email and text Sloan",
    response: SloanReachView,
  }),
  opsSloanReach: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/sloan/reach",
    auth: "session",
    roles: ["operator"],
    summary: "Where the client's people can email and text Sloan",
    params: z.object({ id: Id }),
    response: SloanReachView,
  }),
} as const;
