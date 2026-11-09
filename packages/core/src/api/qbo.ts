import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// QuickBooks Online (plan M9, ARCHITECTURE §6.2, §14). Intuit's sign-in comes back to
// `GET /api/connections/qbo/callback`, the generic forwarder Gmail also uses, and finishes through
// POST /api/connections/:connector/callback like every OAuth tool. Intuit's webhook is one public, signed endpoint for every client. The operator can start a sync.

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const QboWebhookResponse = z.object({
  /** Syncs started for the companies the notification named (one per connection). */
  syncs: z.number().int().nonnegative(),
  /** Record changes kept (docs/plan.md §1.81); a change Intuit sent before isn't kept again. */
  stored: z.number().int().nonnegative(),
});

export const qboRoutes = {
  qboWebhook: defineRoute({
    method: "POST",
    path: "/api/connections/qbo/webhook",
    auth: "public",
    roles: [],
    summary:
      "Intuit's webhook, signed (intuit-signature): keeps each record change it names and starts a sync for each connected company",
    response: QboWebhookResponse,
  }),
  opsConnectionSync: defineRoute({
    method: "POST",
    path: "/api/ops/connections/:id/sync",
    auth: "session",
    roles: ["operator"],
    summary:
      "Sync a connection now (QuickBooks): reads what changed since the last sync; while one runs, queues one more (202)",
    params: z.object({ id: Id }),
    response: z.object({
      started: z.boolean(),
      // v0.12 W1-H: a sync was running; one more runs when it ends (ARCHITECTURE §6.2).
      queued: z.boolean(),
      instanceId: z.string().nullable(),
    }),
  }),
} as const;
