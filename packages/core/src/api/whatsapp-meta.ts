import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.14 W4-A: WhatsApp through Meta (docs/plan.md §1.57). One public webhook for every client: Meta
// checks it with a GET handshake (the challenge echoed as text/plain when the verify token is
// ours) and posts every delivery signed with our app secret (`X-Hub-Signature-256` over the raw
// body). A delivery is routed by the number it came to (`phone_number_id`), never by its sender.
// Embedded Signup goes through the portal's usual sign-in routes (`portalAuthorize` answers a
// `link` with provider `meta`; `portalAuthorizeCallback` takes the code with the state). Groups are
// a client setting the operator turns on (off by default).

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const MetaWebhookResponse = z.object({ ok: z.literal(true) });

export const WhatsappGroupsBody = z.strictObject({
  enabled: z.boolean(),
  /** Why (kept in the client's change log). */
  reason: z.string().trim().min(1).max(500),
});
export const WhatsappGroupsResponse = z.object({ enabled: z.boolean() });

export const whatsappMetaRoutes = {
  metaWebhookVerify: defineRoute({
    method: "GET",
    path: "/api/hooks/whatsapp_meta",
    auth: "public",
    roles: [],
    summary:
      "Meta's webhook handshake: echoes hub.challenge (text/plain) when the verify token is ours",
    response: z.string(),
  }),
  metaWebhook: defineRoute({
    method: "POST",
    path: "/api/hooks/whatsapp_meta",
    auth: "public",
    roles: [],
    summary:
      "Meta's WhatsApp deliveries (X-Hub-Signature-256 over the raw body): messages and statuses, routed by the receiving number",
    response: MetaWebhookResponse,
  }),
  opsWhatsappGroups: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/messaging/whatsapp-groups",
    auth: "session",
    roles: ["operator"],
    summary: "Turn WhatsApp group messages (Meta) on or off for a client, with a reason",
    params: z.object({ id: Id }),
    body: WhatsappGroupsBody,
    response: WhatsappGroupsResponse,
  }),
} as const;
