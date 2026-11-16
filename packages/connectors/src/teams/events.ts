// What the Bot Connector posts to the bot's messaging endpoint from Microsoft Teams: `message`
// (in a channel, only when the bot is mentioned), `conversationUpdate` (the bot added to or
// removed from a team, channels and teams renamed or deleted) and `installationUpdate`; anything
// else is ignored. Read only after the bearer token is verified, size-limited, with the few fields
// binding needs. A message's text is looked at for a binding code and then forgotten: never
// stored, logged or passed on. Channel and team names are labels for the portal, never instructions.

import { z } from "zod";
import { TEAMS_CHANNEL_ID } from "./auth";

export const TEAMS_ACTIVITY_MAX_BYTES = 128 * 1024;

const Account = z.looseObject({
  id: z.string().max(400).optional(),
  name: z.string().max(400).optional(),
  aadObjectId: z.string().max(100).optional(),
});

const Named = z.looseObject({
  id: z.string().max(400),
  name: z.string().max(400).nullable().optional(),
});

const Activity = z.looseObject({
  type: z.string().max(60),
  id: z.string().max(400).optional(),
  serviceUrl: z.string().max(400),
  channelId: z.string().max(60),
  from: Account.optional(),
  recipient: Account.optional(),
  conversation: z.looseObject({
    id: z.string().max(400),
    conversationType: z.string().max(40).optional(),
    isGroup: z.boolean().optional(),
    tenantId: z.string().max(100).optional(),
    name: z.string().max(400).nullable().optional(),
  }),
  text: z
    .string()
    .max(64 * 1024)
    .optional(),
  action: z.string().max(40).optional(),
  membersAdded: z.array(Account).max(500).optional(),
  membersRemoved: z.array(Account).max(500).optional(),
  entities: z.array(z.unknown()).max(100).optional(),
  channelData: z
    .looseObject({
      eventType: z.string().max(60).optional(),
      tenant: z.looseObject({ id: z.string().max(100) }).optional(),
      team: Named.optional(),
      channel: Named.optional(),
    })
    .optional(),
});

export type TeamsActivityType =
  | "message"
  | "installed"
  | "removed"
  | "channel_deleted"
  | "channel_renamed"
  | "team_renamed"
  | "team_deleted"
  | "other";

export type TeamsConversationKind = "channel" | "group_chat" | "personal" | "other";

export interface TeamsActivity {
  type: TeamsActivityType;
  /** The activity's id: what a reply in its thread is addressed to. */
  id: string | null;
  /** Where the Bot Connector takes the bot's answers (checked against the token's claim). */
  serviceUrl: string;
  conversation: { id: string; kind: TeamsConversationKind };
  /** The client's Microsoft Entra tenant. */
  tenantId: string | null;
  team: { id: string; name: string | null } | null;
  /** The channel the activity is in (for a message: the channel of its thread). */
  channel: { id: string; name: string | null } | null;
  from: {
    id: string | null;
    aadObjectId: string | null;
    name: string | null;
    human: boolean;
  } | null;
  /** The bot's own id in Teams (`28:<app id>`), as the activity addresses it. */
  recipientId: string | null;
  /** A message's text (with its mention markup); only ever searched for a code. */
  text: string | null;
}

/** A Teams channel or team id: `19:…@thread.tacv2` (or `@thread.skype`), with no spaces or `/`. */
export function isTeamsThreadId(value: string): boolean {
  if (value.length < 8 || value.length > 200 || !value.startsWith("19:")) return false;
  if (!value.includes("@thread.")) return false;
  for (const ch of value) {
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
}

function kindOf(type: string | undefined): TeamsConversationKind {
  if (type === "channel") return "channel";
  if (type === "groupChat") return "group_chat";
  if (type === "personal") return "personal";
  return "other";
}

/** A label from Teams, trimmed and short; null when empty. */
function label(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  let out = "";
  for (const ch of t.slice(0, 200)) {
    const c = ch.charCodeAt(0);
    if (c >= 0x20 && c !== 0x7f) out += ch;
  }
  return out || null;
}

/** The channel a conversation id names: `19:…@thread.tacv2;messageid=…` → `19:…@thread.tacv2`. */
function threadChannel(conversationId: string): string | null {
  const semi = conversationId.indexOf(";");
  const id = semi < 0 ? conversationId : conversationId.slice(0, semi);
  return isTeamsThreadId(id) ? id : null;
}

/** Just enough of a body to check the token against (before anything else is read). */
export function activityRouting(json: unknown): { serviceUrl: string; channelId: string } | null {
  const o = json as { serviceUrl?: unknown; channelId?: unknown } | null;
  if (!o || typeof o !== "object") return null;
  if (typeof o.serviceUrl !== "string" || typeof o.channelId !== "string") return null;
  if (o.serviceUrl.length > 400 || o.channelId.length > 60) return null;
  return { serviceUrl: o.serviceUrl, channelId: o.channelId };
}

/** The activity, or null when it isn't one from Teams we can read (the route answers 400). */
export function parseTeamsActivity(json: unknown): TeamsActivity | null {
  const r = Activity.safeParse(json);
  if (!r.success || r.data.channelId !== TEAMS_CHANNEL_ID) return null;
  const a = r.data;
  const cd = a.channelData;
  const recipientId = a.recipient?.id ?? null;
  const kind = kindOf(a.conversation.conversationType);
  const team =
    cd?.team && isTeamsThreadId(cd.team.id) ? { id: cd.team.id, name: label(cd.team.name) } : null;
  let channel: TeamsActivity["channel"] = null;
  if (cd?.channel && isTeamsThreadId(cd.channel.id)) {
    channel = { id: cd.channel.id, name: label(cd.channel.name) };
  } else if (kind === "channel") {
    const id = threadChannel(a.conversation.id);
    if (id) channel = { id, name: null };
  }
  const isBot = (m: { id?: string | undefined }) => recipientId !== null && m.id === recipientId;
  const event = cd?.eventType ?? "";

  let type: TeamsActivityType = "other";
  if (a.type === "message") type = "message";
  else if (a.type === "conversationUpdate") {
    if (a.membersRemoved?.some(isBot)) type = "removed";
    else if (a.membersAdded?.some(isBot)) type = "installed";
    else if (event === "channelDeleted") type = "channel_deleted";
    else if (event === "channelRenamed") type = "channel_renamed";
    else if (event === "teamRenamed") type = "team_renamed";
    else if (event === "teamDeleted") type = "team_deleted";
  } else if (a.type === "installationUpdate") {
    if (a.action === "remove") type = "removed";
    else if (a.action === "add") type = "installed";
  }

  return {
    type,
    id: a.id ?? null,
    serviceUrl: a.serviceUrl,
    conversation: { id: a.conversation.id, kind },
    tenantId: cd?.tenant?.id ?? a.conversation.tenantId ?? null,
    team,
    channel,
    from: a.from
      ? {
          id: a.from.id ?? null,
          aadObjectId: a.from.aadObjectId ?? null,
          name: label(a.from.name),
          // Teams users are `29:…`, bots `28:…` (Teams doesn't deliver other bots' messages anyway).
          human: !(a.from.id ?? "").startsWith("28:"),
        }
      : null,
    recipientId,
    text: type === "message" ? (a.text ?? null) : null,
  };
}

// DECISION: the bot's own words in a channel are fixed English lines, posted as a reply in the
// thread of the mention that asked; it answers every mention (channels deliver messages to a bot
// only when it is mentioned), and says nothing when it is added to a team (Microsoft's guidance
// is not to greet a whole team; the portal tells the admin what to do).
export const TEAMS_REPLIES = {
  connected:
    "Connected. Your Mezonas agents can post updates in this channel once you approve them.",
  alreadyConnected: "This channel is already connected to your Mezonas account.",
  takenByAnother:
    "This channel is already connected to another Mezonas account, so it can't be connected again.",
  badCode:
    "That code didn't work. It may have expired or been used. Get a new one from Connections in your Mezonas portal.",
  tooManyTries: "Too many codes were tried here. Wait 15 minutes, then try again.",
  channelOnly:
    "I can only be connected in a team channel. Add me to the team and mention me there with your code.",
  onlyPosts: "I only post updates from Mezonas here. I can't read or answer messages.",
  tooManyChannels:
    "Your Mezonas account has as many connected channels as it can have. Disconnect one first.",
} as const;
export type TeamsReplyKey = keyof typeof TEAMS_REPLIES;
