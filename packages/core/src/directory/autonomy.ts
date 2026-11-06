import { z } from "zod";
import { REACH_CHANNELS, ReachChannel } from "../reach/rules";
import { PermissionLevel } from "../schemas/permissions";

// Per-person autonomy (ARCHITECTURE v0.12 §1 "People", §6.1; docs/plan.md §1.42; migration 0025):
// for each channel a person can be reached on, whether agents may message them on their own
// (`auto`), only with a person's sign (`approval`) or not at all (`off`). It is one more ceiling on
// the permission decision for a message to that person: the strictest of the connection's matrix,
// the agent's grant, the step's approval, the agent's mode (and stage) and this setting wins.
// Pure: the gate, reach out, the API and the web app share it.

/** `contact.autonomy`: a level per channel; a channel left out narrows nothing. */
// DECISION: a channel missing from `contact.autonomy` (the column defaults to `{}`) narrows
// nothing, so contacts made before v0.12 behave exactly as before; every other input (matrix,
// grant, step, mode) still decides, and every step that writes starts with approval on.
export const ContactAutonomy = z
  .strictObject({
    email: PermissionLevel.optional(),
    sms: PermissionLevel.optional(),
    whatsapp: PermissionLevel.optional(),
    voice: PermissionLevel.optional(),
  })
  .meta({ id: "ContactAutonomy" });
export type ContactAutonomy = z.infer<typeof ContactAutonomy>;

const STRICTNESS: Record<PermissionLevel, number> = { auto: 0, approval: 1, off: 2 };

/** The strictest of any number of levels (`off` > `approval` > `auto`); none given is `auto`. */
export function strictestLevel(
  ...levels: readonly (PermissionLevel | null | undefined)[]
): PermissionLevel {
  let out: PermissionLevel = "auto";
  for (const l of levels) if (l && STRICTNESS[l] > STRICTNESS[out]) out = l;
  return out;
}

/** A stored value read leniently: anything unreadable narrows nothing for that channel. */
export function readAutonomy(value: unknown): ContactAutonomy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ContactAutonomy = {};
  for (const ch of REACH_CHANNELS) {
    const level = PermissionLevel.safeParse((value as Record<string, unknown>)[ch]);
    if (level.success) out[ch] = level.data;
  }
  return out;
}

/** This person's level for one channel; null when it isn't set (no narrowing). */
export function autonomyFor(
  autonomy: ContactAutonomy | null | undefined,
  channel: ReachChannel,
): PermissionLevel | null {
  return autonomy?.[channel] ?? null;
}

/**
 * Why a change to a person's autonomy is not the client's to make (docs/plan.md §1.42, invariant
 * 8): the client admin sets `off` or `approval` and may only tighten; only the operator sets
 * `auto` or loosens. Null when the client may make it.
 */
// DECISION: clearing a channel (back to "not set") counts as loosening unless it was `auto`
// already, since "not set" lets the other settings decide alone.
export function clientAutonomyProblem(
  before: ContactAutonomy | null | undefined,
  after: ContactAutonomy,
): string | null {
  for (const ch of REACH_CHANNELS) {
    const next = after[ch];
    const prev = before?.[ch];
    if (next === "auto" && prev !== "auto") {
      return `only Mezonas can let agents ${CHANNEL_VERBS[ch]} this person on their own`;
    }
    const was = prev ? STRICTNESS[prev] : 0;
    const now = next ? STRICTNESS[next] : 0;
    if (now < was) return `you can only make ${CHANNEL_WORDS[ch]} to this person stricter`;
  }
  return null;
}

/**
 * Where a send tool names the person it messages (`ToolSpec.recipient`, docs/plan.md §1.42): the
 * input field with their address and the channel it goes on. The gate looks the contact up by it
 * and adds their autonomy for the channel as one more ceiling.
 */
export const ToolRecipient = z
  .strictObject({
    /** E.g. `to`: an email address or an E.164 number. */
    path: z.string().min(1),
    channel: ReachChannel,
  })
  .meta({ id: "ToolRecipient" });
export type ToolRecipient = z.infer<typeof ToolRecipient>;

/** The channel and address a send tool's call goes to; null when it declares none or has none. */
export function recipientOf(
  spec: { recipient?: ToolRecipient | undefined },
  input: unknown,
): { channel: ReachChannel; to: string } | null {
  const where = spec.recipient;
  if (!where) return null;
  let node: unknown = input;
  for (const key of where.path.split(".")) {
    node = node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
  }
  if (typeof node !== "string" || !node.trim()) return null;
  const to = node.trim();
  return {
    channel: where.channel,
    // Email addresses are stored in lower case; numbers in E.164 (a `whatsapp:` prefix dropped).
    to: where.channel === "email" ? to.toLowerCase() : to.replace(/^whatsapp:/i, ""),
  };
}

const CHANNEL_WORDS: Record<ReachChannel, string> = {
  email: "emails",
  sms: "texts",
  whatsapp: "WhatsApp messages",
  voice: "calls",
};
const CHANNEL_VERBS: Record<ReachChannel, string> = {
  email: "email",
  sms: "text",
  whatsapp: "message on WhatsApp",
  voice: "call",
};

/** Plain words for a refusal or a wait caused by a person's autonomy. */
export function autonomyMessage(channel: ReachChannel, level: PermissionLevel): string {
  return level === "off"
    ? `agents' ${CHANNEL_WORDS[channel]} to this person are turned off`
    : `agents' ${CHANNEL_WORDS[channel]} to this person need a person's sign`;
}
