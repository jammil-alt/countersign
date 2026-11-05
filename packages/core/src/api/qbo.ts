import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// QuickBooks Online (plan M9, ARCHITECTURE §6.2, §14). Intuit's sign-in comes back to a fixed API
// path registered with the Intuit app, which hands the client on to the portal's callback page
// (the same POST /api/connections/:connector/callback as every OAuth tool then finishes it).
// Intuit's webhook is one public, signed endpoint for every client. The operator can start a sync.

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const QboWebhookResponse = z.object({
  /** Syncs started for the companies the notification named (one per connection). */
  syncs: z.number().int().nonnegative(),
});

export const qboRoutes = {
  qboCallback: defineRoute({
    method: "GET",
    path: "/api/connections/qbo/callback",
    auth: "public",
    roles: [],
    summary:
      "Where Intuit sends the client after signing in: forwards its parameters to the portal's callback page",
    response: z.object({}),
  }),
  qboWebhook: defineRoute({
    method: "POST",
    path: "/api/connections/qbo/webhook",
    auth: "public",
    roles: [],
    summary:
      "Intuit's webhook, signed (intuit-signature): starts a sync for each connected company it names",
    response: QboWebhookResponse,
  }),
  opsConnectionSync: defineRoute({
    method: "POST",
    path: "/api/ops/connections/:id/sync",
    auth: "session",
    roles: ["operator"],
    summary: "Sync a connection now (QuickBooks): reads what changed since the last sync",
    params: z.object({ id: Id }),
    response: z.object({ started: z.boolean(), instanceId: z.string().nullable() }),
  }),
} as const;
