import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// v0.14 W4-E: Google Chat (ARCHITECTURE §6.11 row 8, docs/plan.md §1.60). Google Chat posts the
// app's events to one public endpoint for every client, with a Google-signed bearer token; the
// client admin gets a one-time code in the portal, sees the spaces bound to the client and
// disconnects one. No response carries a stored secret: the code is shown once, when it is made.

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** A space's id: what follows `spaces/` in its resource name. */
const SpaceId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => {
    for (const ch of v) {
      const ok =
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "-" ||
        ch === "_";
      if (!ok) return false;
    }
    return true;
  }, "not a space id");

/** What the app answers Google Chat: one line in the space, or nothing (`{}`). */
export const GchatEventResponse = z.object({ text: z.string().optional() });

/** The Google Chat connection as its client admin sees it. */
export const PortalGchatSetup = z.object({
  spaces: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().nullable(),
      kind: z.enum(["space", "group_chat"]),
      boundAt: z.string(),
      boundBy: z.string().nullable(),
    }),
  ),
  /** A code made and not yet used: when it stops working (the code itself isn't kept). */
  pendingCodeExpiresAt: z.string().nullable(),
  /** The code, only in the answer that made it. */
  newCode: z.string().nullable(),
});

export const gchatRoutes = {
  gchatEvents: defineRoute({
    method: "POST",
    path: "/api/hooks/gchat",
    auth: "public",
    roles: [],
    summary:
      "Google Chat's events to the Mezonas app (Google-signed bearer token): a code binds a space, removal unbinds it",
    response: GchatEventResponse,
  }),
  portalGchat: defineRoute({
    method: "GET",
    path: "/api/connections/:id/gchat",
    auth: "session",
    roles: ["client_admin"],
    summary: "The Google Chat spaces bound to this client, and whether a code is waiting",
    params: z.object({ id: Id }),
    response: PortalGchatSetup,
  }),
  portalGchatCode: defineRoute({
    method: "POST",
    path: "/api/connections/:id/gchat/code",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "A one-time code (15 minutes) to mention the app with in a space; replaces any code not yet used",
    params: z.object({ id: Id }),
    body: z.strictObject({}),
    response: PortalGchatSetup,
  }),
  portalGchatUnbind: defineRoute({
    method: "DELETE",
    path: "/api/connections/:id/gchat/spaces/:spaceId",
    auth: "session",
    roles: ["client_admin"],
    summary: "Disconnect a space: agents can no longer post there",
    params: z.object({ id: Id, spaceId: SpaceId }),
    response: PortalGchatSetup,
  }),
} as const;
