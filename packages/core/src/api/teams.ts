import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

// §1.97: Microsoft Teams (ARCHITECTURE §6.11 row 11, docs/plan.md §1.97). The Bot Connector posts
// the bot's activities to one public endpoint for every client, with a bearer token it signs; the
// client admin gets a one-time code in the portal, sees the channels bound to the client and
// disconnects one. No response carries a stored secret: the code is shown once, when it is made.

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** A Teams channel id: `19:…@thread.tacv2` (URL-encoded in a path). */
const ChannelId = z
  .string()
  .min(8)
  .max(200)
  .refine((v) => {
    if (!v.startsWith("19:") || !v.includes("@thread.")) return false;
    for (const ch of v) {
      const ok =
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === ":" ||
        ch === "@" ||
        ch === "." ||
        ch === "-" ||
        ch === "_";
      if (!ok) return false;
    }
    return true;
  }, "not a Teams channel id");

/** The Teams connection as its client admin sees it. */
export const PortalTeamsSetup = z.object({
  channels: z.array(
    z.object({
      channelId: z.string(),
      teamName: z.string().nullable(),
      channelName: z.string().nullable(),
      /** "Team › Channel", or what is known. */
      label: z.string(),
      boundAt: z.string(),
      boundBy: z.string().nullable(),
    }),
  ),
  /** A code made and not yet used: when it stops working (the code itself isn't kept). */
  pendingCodeExpiresAt: z.string().nullable(),
  /** The code, only in the answer that made it. */
  newCode: z.string().nullable(),
});
export type PortalTeamsSetup = z.infer<typeof PortalTeamsSetup>;

export const teamsRoutes = {
  teamsEvents: defineRoute({
    method: "POST",
    path: "/api/hooks/teams",
    auth: "public",
    roles: [],
    summary:
      "The Bot Connector's activities to the Mezonas Teams bot (signed bearer token): a code binds a channel, removal unbinds it",
    response: z.object({}),
  }),
  portalTeams: defineRoute({
    method: "GET",
    path: "/api/connections/:id/teams",
    auth: "session",
    roles: ["client_admin"],
    summary: "The Teams channels bound to this client, and whether a code is waiting",
    params: z.object({ id: Id }),
    response: PortalTeamsSetup,
  }),
  portalTeamsCode: defineRoute({
    method: "POST",
    path: "/api/connections/:id/teams/code",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "A one-time code (15 minutes) to mention the bot with in a channel; replaces any code not yet used",
    params: z.object({ id: Id }),
    body: z.strictObject({}),
    response: PortalTeamsSetup,
  }),
  portalTeamsUnbind: defineRoute({
    method: "DELETE",
    path: "/api/connections/:id/teams/channels/:channelId",
    auth: "session",
    roles: ["client_admin"],
    summary: "Disconnect a channel: agents can no longer post there",
    params: z.object({ id: Id, channelId: ChannelId }),
    response: PortalTeamsSetup,
  }),
} as const;
