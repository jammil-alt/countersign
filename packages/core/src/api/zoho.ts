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

// docs/plan.md §1.164 step 3 ("Zoho's fields"): a connection's fields per module, as the
// connector reads them from Zoho (packages/connectors zoho_crm/fields.ts `ZohoField`), and the
// fields its sync reads. Which extra fields to sync is the connection's setup (`config.syncFields`),
// changed through the connection's settings like any setup: tighter applies, looser goes to the
// client admin (Connectors C4).

/** One field of a Zoho module. */
export const ZohoFieldView = z.object({
  apiName: z.string(),
  label: z.string(),
  dataType: z.string(),
  custom: z.boolean(),
  readOnly: z.boolean(),
  mandatory: z.boolean(),
  picklist: z.array(z.string()).nullable(),
  maxLength: z.number().int().nullable(),
});
export type ZohoFieldView = z.infer<typeof ZohoFieldView>;

export const ZohoFieldsView = z.object({
  /**
   * `ok`: read; `needs_sign_in`: the sign-in can't read fields (made before the scope was added);
   * `not_read`: not read yet (the connection isn't connected).
   */
  status: z.enum(["ok", "needs_sign_in", "not_read"]),
  readAt: z.string().nullable(),
  modules: z.array(
    z.object({
      module: z.string(),
      fields: z.array(ZohoFieldView),
      /** The fields the sync reads anyway. */
      standard: z.array(z.string()),
      /** How many more the sync can read in one call (v8's 50 less the standard ones). */
      room: z.number().int().nonnegative(),
    }),
  ),
  /** The extra fields the sync reads now, by module (`config.syncFields`). */
  syncFields: z.record(z.string(), z.array(z.string())),
});
export type ZohoFieldsView = z.infer<typeof ZohoFieldsView>;

export const zohoRoutes = {
  opsZohoFields: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/connections/:connectionId/zoho-fields",
    auth: "session",
    roles: ["operator"],
    summary:
      "A Zoho CRM connection's fields per module and the extra fields its sync reads; read from Zoho again with ?refresh=true, or when a day old",
    params: z.object({ id: Id, connectionId: Id }),
    query: z.object({ refresh: z.enum(["true", "false"]).optional() }),
    response: ZohoFieldsView,
  }),
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
