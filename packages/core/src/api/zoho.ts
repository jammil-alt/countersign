import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.14 W4-B: Zoho CRM's notifications (docs/plan.md §1.9 "Sync (W4-B)"). Zoho posts to the address
// it was given when the watch was made, one per connection; the token it echoes is the credential,
// checked in constant time. A notification only asks for a sync: nothing is processed inline.

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const ZohoNotifyResponse = z.object({
  /** The notification was this connection's: a sync starts after the response. */
  accepted: z.literal(true),
});

export const zohoRoutes = {
  zohoNotify: defineRoute({
    method: "POST",
    path: "/api/hooks/zoho_crm/:tenantId/:connectionId",
    auth: "public",
    roles: [],
    summary:
      "Zoho CRM's notification for one connection, with the token we gave it: syncs the changes",
    params: z.object({ tenantId: Id, connectionId: Id }),
    response: ZohoNotifyResponse,
  }),
} as const;
