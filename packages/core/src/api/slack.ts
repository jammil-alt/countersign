import { z } from "zod";
import { defineRoute } from "./contract";

// v0.14 W4-C: the client admin's channel picker for a Slack connection (docs/plan.md §1.56). The
// list comes live from Slack (public channels, not archived) with whether our bot is in each; the
// picks are the channels agents may post to, kept in the connection's config. Client admins only:
// the operator never connects or picks for a client.

/** One public channel of the workspace, as the picker shows it. */
export const SlackChannelOption = z.object({
  id: z.string(),
  name: z.string(),
  /** Our bot is in the channel (Slack lets it post only where it is). */
  isMember: z.boolean(),
  picked: z.boolean(),
});
export type SlackChannelOption = z.infer<typeof SlackChannelOption>;

export const SlackChannelsView = z.object({
  connectionId: z.string(),
  workspace: z.string(),
  channels: z.array(SlackChannelOption),
  /** The picks, also those no longer listed (renamed, archived, made private). */
  picked: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type SlackChannelsView = z.infer<typeof SlackChannelsView>;

/** The picks, by Slack channel id; names come from Slack, never from the request. */
export const SlackPickBody = z.strictObject({
  channels: z.array(z.string().min(2).max(24)).max(50),
});

export const slackRoutes = {
  portalSlackChannels: defineRoute({
    method: "GET",
    path: "/api/connections/slack/channels",
    auth: "session",
    roles: ["client_admin"],
    summary: "The Slack workspace's public channels, with the ones agents may post to",
    response: SlackChannelsView,
  }),
  portalSlackPick: defineRoute({
    method: "PUT",
    path: "/api/connections/slack/channels",
    auth: "session",
    roles: ["client_admin"],
    summary: "Pick the Slack channels agents may post to (replaces the picks)",
    body: SlackPickBody,
    response: SlackChannelsView,
  }),
} as const;
