import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.12 bankfeed: bank and card feeds through Plaid (ARCHITECTURE §6.11, docs/plan.md §1.52). The
// client admin connects in Plaid Link through the portal's usual sign-in routes
// (`portalAuthorize` answers `link` instead of a redirect; `portalAuthorizeCallback` takes Link's
// public token with the state). Plaid notifies each client's items at the webhook below.

/** What the portal opens Plaid Link with. The token is short-lived and reads nothing by itself. */
export const LinkStartView = z.object({
  // v0.14 W4-A: `meta` is Meta's Embedded Signup (WhatsApp): `token` is its configuration's id,
  // with the app's id and the Graph version, all public values (docs/plan.md §1.57).
  provider: z.enum(["plaid", "meta"]),
  token: z.string(),
  expiresAt: z.string().nullable(),
  /** The signed state, posted back with Link's result to the callback route. */
  state: z.string(),
  // v0.14 W4-A
  appId: z.string().optional(),
  graphVersion: z.string().optional(),
});
export type LinkStartView = z.infer<typeof LinkStartView>;

export const BankfeedWebhookResponse = z.object({
  /** Whether the webhook named one of this client's connections (and what was done). */
  outcome: z.enum(["sync", "attention", "ignored"]),
});

export const bankfeedRoutes = {
  bankfeedWebhook: defineRoute({
    method: "POST",
    path: "/api/connections/bankfeed/webhook/:tenantId",
    auth: "public",
    roles: [],
    summary:
      "Plaid's webhook for one client's bank feed, signed (Plaid-Verification JWT): starts a sync, or marks the connection for reconnecting",
    params: z.object({ tenantId: z.string().refine((v) => isUuid(v), "not an id") }),
    response: BankfeedWebhookResponse,
  }),
} as const;
