// What Google Chat posts to the app's endpoint (interaction events of a Chat API app, not a
// Workspace add-on): ADDED_TO_SPACE, MESSAGE, REMOVED_FROM_SPACE, and others we ignore. Read only
// after the bearer token is verified, size-limited, with the few fields binding needs. A message's
// text is looked at for a binding code and then forgotten: it is never stored, logged or passed on.
// The app answers synchronously with one of the fixed lines below, or nothing.

import { z } from "zod";

export const CHAT_EVENT_MAX_BYTES = 64 * 1024;

const Space = z.looseObject({
  name: z.string().max(200),
  /** Older field: ROOM or DM. */
  type: z.string().max(40).optional(),
  /** SPACE, GROUP_CHAT or DIRECT_MESSAGE. */
  spaceType: z.string().max(40).optional(),
  singleUserBotDm: z.boolean().optional(),
  displayName: z.string().max(400).optional(),
});

const ChatEvent = z.looseObject({
  type: z.string().max(60),
  space: Space.optional(),
  message: z
    .looseObject({
      text: z.string().max(CHAT_EVENT_MAX_BYTES).optional(),
      /** The text after the app's mention. */
      argumentText: z.string().max(CHAT_EVENT_MAX_BYTES).optional(),
      space: Space.optional(),
    })
    .optional(),
  user: z
    .looseObject({
      name: z.string().max(200).optional(),
      displayName: z.string().max(400).optional(),
      type: z.string().max(40).optional(),
    })
    .optional(),
});

export type SpaceKind = "space" | "group_chat" | "dm";

export interface ParsedChatEvent {
  type: "ADDED_TO_SPACE" | "MESSAGE" | "REMOVED_FROM_SPACE" | "OTHER";
  space: { name: string; displayName: string | null; kind: SpaceKind } | null;
  /** The text after the mention (else the whole text); only ever searched for a code. */
  text: string | null;
  user: { name: string | null; displayName: string | null; human: boolean } | null;
}

/** `spaces/AAAA…`: the prefix and 1–128 letters, digits, `-` or `_`. */
export function isSpaceName(value: string): boolean {
  const prefix = "spaces/";
  if (!value.startsWith(prefix)) return false;
  const id = value.slice(prefix.length);
  if (id.length < 1 || id.length > 128) return false;
  for (const ch of id) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_";
    if (!ok) return false;
  }
  return true;
}

function kindOf(s: z.infer<typeof Space>): SpaceKind {
  if (s.spaceType === "DIRECT_MESSAGE" || s.type === "DM" || s.singleUserBotDm === true) {
    return "dm";
  }
  if (s.spaceType === "GROUP_CHAT") return "group_chat";
  return "space";
}

/** The event, or null when it isn't one we can read (the route answers 400). */
export function parseChatEvent(json: unknown): ParsedChatEvent | null {
  const r = ChatEvent.safeParse(json);
  if (!r.success) return null;
  const e = r.data;
  const raw = e.space ?? e.message?.space;
  const space =
    raw && isSpaceName(raw.name)
      ? {
          name: raw.name,
          displayName: raw.displayName?.trim() ? raw.displayName.trim().slice(0, 200) : null,
          kind: kindOf(raw),
        }
      : null;
  const type =
    e.type === "ADDED_TO_SPACE" || e.type === "MESSAGE" || e.type === "REMOVED_FROM_SPACE"
      ? e.type
      : "OTHER";
  return {
    type,
    space,
    text: e.message ? (e.message.argumentText ?? e.message.text ?? null) : null,
    user: e.user
      ? {
          name: e.user.name ?? null,
          displayName: e.user.displayName?.trim() ? e.user.displayName.trim().slice(0, 200) : null,
          human: e.user.type !== "BOT",
        }
      : null,
  };
}

// DECISION: the app's own words in a space are fixed English lines (Chat events carry no reliable
// language for the space), and it answers every mention: a message that isn't a binding code
// gets `onlyPosts` (spaces deliver messages to an app only when it is mentioned, so this is not
// noise), and the message itself is neither stored nor read beyond looking for a code.
export const CHAT_REPLIES = {
  welcome:
    "Thanks for adding Mezonas. To connect this space, mention me with the code from Connections in your Mezonas portal.",
  connected: "Connected. Your Mezonas agents can post updates in this space once you approve them.",
  alreadyConnected: "This space is already connected to your Mezonas account.",
  takenByAnother:
    "This space is already connected to another Mezonas account, so it can't be connected again.",
  badCode:
    "That code didn't work. It may have expired or been used. Get a new one from Connections in your Mezonas portal.",
  tooManyTries: "Too many codes were tried here. Wait 15 minutes, then try again.",
  dmRefused:
    "I can only be connected in a space or group chat. Add me there and mention me with your code.",
  onlyPosts: "I only post updates from Mezonas here. I can't read or answer messages.",
  tooManySpaces:
    "Your Mezonas account has as many connected spaces as it can have. Disconnect one first.",
} as const;
export type ChatReplyKey = keyof typeof CHAT_REPLIES;
