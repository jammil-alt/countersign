import { z } from "zod";
import { CALL_LANGUAGES, type CallLanguage, callLanguage } from "../calls/rules";
import { Duration, parseDuration } from "../duration";
import {
  type ContactConsent,
  DEFAULT_QUIET_HOURS,
  inQuietHours,
  type QuietHours,
} from "../messaging/rules";
import { evaluateRules } from "../rules/compile";
import { Rules } from "../schemas/rules";

// Reach out (docs/plan.md §1.25): an agent contacting the people it works with by email, text,
// WhatsApp or call, under conditions set per role binding. Everything here is checked in code
// before anything is sent, never left to a model: consent, opt-out, hours, caps, the "only if"
// rule, which channels and in what order, and when to escalate. Pure: the API, the runtime and the
// web app share it.

export const REACH_CHANNELS = ["email", "sms", "whatsapp", "voice"] as const;
export const ReachChannel = z.enum(REACH_CHANNELS);
export type ReachChannel = z.infer<typeof ReachChannel>;

export const URGENCIES = ["urgent", "normal", "fyi"] as const;
export const Urgency = z.enum(URGENCIES);
export type Urgency = z.infer<typeof Urgency>;

export const REACH_OUTCOMES = [
  "replied",
  "no_reply",
  "declined",
  "opted_out",
  "not_allowed",
] as const;
export const ReachOutcome = z.enum(REACH_OUTCOMES);
export type ReachOutcome = z.infer<typeof ReachOutcome>;

/** A role label: `purchaser`, `owner`, `vendor-rep`. */
export const RoleName = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:[-_ ][a-z0-9]+)*$/, "lowercase words, e.g. purchaser or vendor-rep")
  .max(40);

/**
 * A role a template or agent declares it reaches (`people` in the bundle). No contact data: who
 * fills the role is bound on the client agent, never in a version (invariant 11).
 */
export const PersonRole = z
  .object({
    role: RoleName,
    description: z.string().max(500).default(""),
    /** Activation refuses a required role with nobody bound. */
    required: z.boolean().default(false),
    /** The channels this role may be reached on (default: all). */
    channels: z.array(ReachChannel).optional(),
  })
  .meta({ id: "PersonRole" });
export type PersonRole = z.infer<typeof PersonRole>;

/** `normal` takes the contact's own order unless the binding names one. */
export const PREFERRED = "preferred" as const;

export const UrgencyChannels = z.object({
  urgent: z.array(ReachChannel).optional(),
  normal: z.union([z.literal(PREFERRED), z.array(ReachChannel)]).optional(),
  fyi: z.array(ReachChannel).optional(),
});
export type UrgencyChannels = z.infer<typeof UrgencyChannels>;

// DECISION: the defaults of §1.25: urgent → call, then text; normal → the contact's preferred
// order; FYI → email only. A normal reach-out to a contact with no preferences goes least
// intrusive first: email, text, WhatsApp, call.
export const DEFAULT_URGENCY_CHANNELS: Required<UrgencyChannels> = {
  urgent: ["voice", "sms"],
  normal: PREFERRED,
  fyi: ["email"],
};
export const DEFAULT_CHANNEL_ORDER: readonly ReachChannel[] = ["email", "sms", "whatsapp", "voice"];

export const REACH_MAX_PER_DAY = 20;
export const DEFAULT_MAX_PER_DAY = 3;
export const DEFAULT_ESCALATE_AFTER: Duration = "2 hours";
export const DEFAULT_REACH_TIMEOUT: Duration = "2 days";

/**
 * The conditions on one role binding (or a contact reached directly), set by the operator or the
 * client admin. Anything left out takes the default.
 */
export const ReachConditions = z
  .strictObject({
    /** The channels this binding may use (default: all). */
    channels: z.array(ReachChannel).optional(),
    urgency: UrgencyChannels.optional(),
    /** Urgent reach-outs may go outside the contact's hours. Off unless set. */
    urgentOutsideHours: z.boolean().optional(),
    /** Reach-outs to one contact per day (UTC), from this client's agents. */
    maxPerDay: z.number().int().min(1).max(REACH_MAX_PER_DAY).optional(),
    /** Only reach out when this rule holds over the step's facts (the fork rules). */
    onlyIf: Rules.optional(),
    /** No reply after this long → the next channel. */
    escalateAfter: Duration.optional(),
  })
  .meta({ id: "ReachConditions" });
export type ReachConditions = z.infer<typeof ReachConditions>;
export type ReachConditionsInput = z.input<typeof ReachConditions>;

/** What the evaluator needs of a contact. */
export interface ReachContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  language: string | null;
  preferredChannels: readonly ReachChannel[];
  timezone: string | null;
  quietHours: QuietHours | null;
  consent: ContactConsent;
  optedOutAt: string | Date | null;
}

/** Why one channel can't be used for this contact now. */
export type ChannelBlock =
  | "opted_out"
  | "no_address"
  | "no_consent"
  | "not_bound"
  | "not_allowed_by_binding"
  | "not_allowed_for_role"
  | "quiet_hours";

/** The contact's address on a channel (calls and texts go to `phone`). */
export function channelAddress(c: ReachContact, channel: ReachChannel): string | null {
  switch (channel) {
    case "email":
      return c.email;
    case "sms":
    case "voice":
      return c.phone;
    case "whatsapp":
      return c.whatsapp;
  }
}

/** Opt-out, address and consent: whether this contact may ever be reached on this channel. */
export function consentBlockFor(c: ReachContact, channel: ReachChannel): ChannelBlock | null {
  if (c.optedOutAt) return "opted_out";
  if (!channelAddress(c, channel)) return "no_address";
  if (!c.consent[channel]) return "no_consent";
  return null;
}

export interface ReachHours {
  timezone: string;
  quietHours: QuietHours;
}

/** The contact's hours: their own timezone and quiet hours, else the client's. */
export function contactHours(c: ReachContact, client: Partial<ReachHours>): ReachHours {
  return {
    timezone: c.timezone ?? client.timezone ?? "UTC",
    quietHours: c.quietHours ?? client.quietHours ?? DEFAULT_QUIET_HOURS,
  };
}

// DECISION: email waits for nobody: it goes at any hour, since it is read when the person chooses.
// Quiet hours hold texts, WhatsApp and calls in the contact's timezone; an urgent reach-out goes
// through them only when its binding allows it. The client's own quiet hours (§1.22) still hold at
// Twilio's sends, whatever the binding says.
export function hoursBlock(
  channel: ReachChannel,
  urgency: Urgency,
  hours: ReachHours,
  conditions: ReachConditions,
  now: Date,
): ChannelBlock | null {
  if (channel === "email") return null;
  if (urgency === "urgent" && conditions.urgentOutsideHours) return null;
  return inQuietHours(now, hours.timezone, hours.quietHours) ? "quiet_hours" : null;
}

/** The channels urgency asks for, in order, before any filter. */
export function urgencyOrder(
  c: ReachContact,
  urgency: Urgency,
  conditions: ReachConditions,
): ReachChannel[] {
  const configured = conditions.urgency?.[urgency] ?? DEFAULT_URGENCY_CHANNELS[urgency];
  if (configured !== PREFERRED) return [...new Set(configured)];
  const preferred = c.preferredChannels.length ? c.preferredChannels : DEFAULT_CHANNEL_ORDER;
  return [...new Set(preferred)];
}

export interface PlanInput {
  contact: ReachContact;
  conditions: ReachConditions;
  /** The role's channels from the bundle's `people`, when reached by role. */
  roleChannels?: readonly ReachChannel[] | undefined;
  urgency: Urgency;
  /** The channels the agent has bound to a connection. */
  boundChannels: ReadonlySet<ReachChannel>;
  client: Partial<ReachHours>;
  /** The step's facts for the "only if" rule (the run context: trigger, steps). */
  facts: unknown;
  /** Whether a reach-out to this contact about this subject is already open. */
  openForSubject: boolean;
  /** Reach-outs to this contact today (UTC), any agent of the client. */
  sentToday: number;
  now: Date;
}

export interface ChannelCheck {
  channel: ReachChannel;
  block: ChannelBlock | null;
}

export type ReachPlan =
  | {
      ok: true;
      /** In order; the first is tried now, each next one after `escalateAfter` without a reply. */
      channels: ReachChannel[];
      escalateAfter: Duration;
      checks: ChannelCheck[];
    }
  | { ok: false; outcome: "not_allowed" | "opted_out"; reason: string; checks: ChannelCheck[] };

const BLOCK_WORDS: Record<ChannelBlock, string> = {
  opted_out: "opted out",
  no_address: "no address",
  no_consent: "no consent",
  not_bound: "the agent has no channel",
  not_allowed_by_binding: "not allowed for this person",
  not_allowed_for_role: "not allowed for this role",
  quiet_hours: "quiet hours",
};

/** "sms: no consent; voice: quiet hours". */
export function describeChecks(checks: readonly ChannelCheck[]): string {
  return checks
    .filter((c) => c.block)
    .map((c) => `${c.channel}: ${BLOCK_WORDS[c.block as ChannelBlock]}`)
    .join("; ");
}

/**
 * Every condition, in order: opt-out, the "only if" rule, one open reach-out per subject, the
 * daily cap, then each channel urgency asks for, filtered by the binding, the role, the agent's
 * bound channels, consent and hours. The channels that pass, in order, are the plan; none passing
 * is `not_allowed` with the reasons.
 */
export function planReachOut(input: PlanInput): ReachPlan {
  const { contact, conditions } = input;
  if (contact.optedOutAt) {
    return { ok: false, outcome: "opted_out", reason: "the contact opted out", checks: [] };
  }
  if (conditions.onlyIf && !evaluateRules(conditions.onlyIf, input.facts)) {
    return {
      ok: false,
      outcome: "not_allowed",
      reason: "the binding's only-if rule doesn't hold",
      checks: [],
    };
  }
  if (input.openForSubject) {
    return {
      ok: false,
      outcome: "not_allowed",
      reason: "a reach-out to this contact about this is already open",
      checks: [],
    };
  }
  const cap = conditions.maxPerDay ?? DEFAULT_MAX_PER_DAY;
  if (input.sentToday >= cap) {
    return {
      ok: false,
      outcome: "not_allowed",
      reason: `already reached ${input.sentToday} times today (the limit is ${cap})`,
      checks: [],
    };
  }
  const hours = contactHours(contact, input.client);
  const checks: ChannelCheck[] = urgencyOrder(contact, input.urgency, conditions).map((channel) => {
    let block: ChannelBlock | null = null;
    if (conditions.channels && !conditions.channels.includes(channel)) {
      block = "not_allowed_by_binding";
    } else if (input.roleChannels && !input.roleChannels.includes(channel)) {
      block = "not_allowed_for_role";
    } else if (!input.boundChannels.has(channel)) {
      block = "not_bound";
    } else {
      block =
        consentBlockFor(contact, channel) ??
        hoursBlock(channel, input.urgency, hours, conditions, input.now);
    }
    return { channel, block };
  });
  // Hours only hold back the start: a channel in quiet hours stays in the plan when an earlier one
  // goes now, since escalation comes later (and is checked again then).
  const first = checks.findIndex((c) => c.block === null);
  if (first < 0) {
    const why = describeChecks(checks);
    return {
      ok: false,
      outcome: "not_allowed",
      reason: why ? `no channel can be used: ${why}` : "no channel can be used",
      checks,
    };
  }
  const channels = checks
    .filter((c, i) => c.block === null || (i > first && c.block === "quiet_hours"))
    .map((c) => c.channel);
  return {
    ok: true,
    channels,
    escalateAfter: conditions.escalateAfter ?? DEFAULT_ESCALATE_AFTER,
    checks,
  };
}

// ── Escalation ───────────────────────────────────────────────────────────────────────────────────

export interface EscalationState {
  channels: readonly ReachChannel[];
  /** Attempts made so far (sent or failed), in order. */
  attempts: number;
  lastAttemptAt: Date | null;
  escalateAfter: Duration;
  replied: boolean;
  optedOut: boolean;
}

export type EscalationStep =
  | { kind: "stop"; why: "replied" | "opted_out" | "last_channel" }
  | { kind: "wait"; until: Date }
  | { kind: "attempt"; channel: ReachChannel; index: number };

/**
 * What the cron does next for an open reach-out: stop at a reply, an opt-out or the last channel;
 * otherwise try the next channel once `escalateAfter` has passed since the last attempt.
 */
export function nextEscalation(s: EscalationState, now: Date): EscalationStep {
  if (s.replied) return { kind: "stop", why: "replied" };
  if (s.optedOut) return { kind: "stop", why: "opted_out" };
  if (s.attempts >= s.channels.length) return { kind: "stop", why: "last_channel" };
  const channel = s.channels[s.attempts] as ReachChannel;
  if (s.attempts === 0 || !s.lastAttemptAt) return { kind: "attempt", channel, index: 0 };
  const due = new Date(s.lastAttemptAt.getTime() + parseDuration(s.escalateAfter));
  if (now < due) return { kind: "wait", until: due };
  return { kind: "attempt", channel, index: s.attempts };
}

/** When the quiet hours holding a channel back end (the next minute outside them), within a day. */
export function quietHoursEnd(hours: ReachHours, now: Date): Date {
  let t = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 24 * 60 && inQuietHours(t, hours.timezone, hours.quietHours); i++) {
    t = new Date(t.getTime() + 60_000);
  }
  return t;
}

// ── Language, subject and message ───────────────────────────────────────────────────────────────

export const REACH_LANGUAGES = CALL_LANGUAGES;
export type ReachLanguage = CallLanguage;

/** The contact's language, else the client's, else English (§1.18). */
export function reachLanguage(
  contactLanguage: string | null | undefined,
  clientLanguage: string | null | undefined,
): ReachLanguage {
  return callLanguage(contactLanguage, clientLanguage);
}

/** One open reach-out per contact and subject: its sources, else its purpose. */
export function reachSubject(about: readonly string[], purpose: string): string {
  const ids = [...new Set(about)].sort();
  return ids.length ? `about:${ids.join(",")}`.slice(0, 500) : `purpose:${purpose}`.slice(0, 500);
}

/** A fixed message: one text per language; the contact's language, else English. */
export const MessageTemplate = z
  .partialRecord(z.enum(CALL_LANGUAGES), z.string().trim().min(1).max(1600))
  .refine((t) => typeof t.en === "string", { message: "give the English text", path: ["en"] });
export type MessageTemplate = z.infer<typeof MessageTemplate>;

export function pickMessage(template: MessageTemplate, language: ReachLanguage): string {
  return (template[language] ?? template.en) as string;
}

// ── Channels and the connectors that carry them ─────────────────────────────────────────────────

/**
 * Which connector's tool sends on a channel. An agent's channel is bound to one connection; the
 * reach-out sends through that connection's tool for the channel. Gmail (`gmail.send`, an agent's
 * own mailbox or a person's) and Meta's WhatsApp plug in here when they are built.
 */
// DECISION: email goes through Mezonas' sending service (Resend) until the Gmail connector (M10)
// exists; Gmail's send is listed so a binding to it is refused today with a plain reason.
export const CHANNEL_TOOLS: Record<string, Partial<Record<ReachChannel, string>>> = {
  resend: { email: "email.send" },
  twilio: { sms: "sms.send", whatsapp: "whatsapp.send", voice: "call.place" },
};
export const PLANNED_CHANNEL_CONNECTORS: Record<string, ReachChannel[]> = {
  gmail: ["email"],
  whatsapp_meta: ["whatsapp"],
};

/** The channels a connector can carry for an agent. */
export function connectorChannels(connector: string): ReachChannel[] {
  return Object.keys(CHANNEL_TOOLS[connector] ?? {}) as ReachChannel[];
}

/** The tool that sends on `channel` through a `connector` connection, if any. */
export function channelTool(connector: string, channel: ReachChannel): string | null {
  return CHANNEL_TOOLS[connector]?.[channel] ?? null;
}

// ── The skill's input and output ────────────────────────────────────────────────────────────────

export const REACH_OUT_SKILL = "comms.reach-out";
export const REACH_PURPOSE_MAX = 500;

export const ReachTo = z.union([
  z.strictObject({ role: RoleName }),
  z.strictObject({ contactId: z.uuid() }),
]);
export type ReachTo = z.infer<typeof ReachTo>;

export const ReachOutInput = z
  .object({
    to: ReachTo,
    /** The records it concerns (ids): the evidence, and its subject. */
    about: z.array(z.string().min(1).max(100)).max(20).default([]),
    /** Why, in plain words: fixed text written in the step (it becomes instructions). */
    purpose: z.string().trim().min(1).max(REACH_PURPOSE_MAX),
    message: z.union([
      z.strictObject({ template: MessageTemplate }),
      z.strictObject({ compose: z.literal(true) }),
    ]),
    /** The email subject line; the purpose when absent. */
    subject: z.string().trim().min(1).max(200).optional(),
    urgency: Urgency.default("normal"),
    expectReply: z.boolean().default(true),
    timeout: Duration.default(DEFAULT_REACH_TIMEOUT),
  })
  .meta({ id: "ReachOutInput" });
export type ReachOutInput = z.infer<typeof ReachOutInput>;
export type ReachOutInputIn = z.input<typeof ReachOutInput>;

/** The fields of the step that must be its own fixed text (§1.23's rule). */
export const REACH_OUT_FIXED_INPUTS = ["purpose"] as const;

export const ReachReply = z.object({
  channel: ReachChannel,
  /** What they wrote or said: untrusted data, never instructions (invariant 9). */
  text: z.string(),
  untrusted: z.literal(true),
  rawRecordId: z.string().nullable(),
  at: z.string(),
});
export type ReachReply = z.infer<typeof ReachReply>;

export const ReachOutOutput = z
  .object({
    outcome: ReachOutcome,
    channel: ReachChannel.nullable(),
    reply: ReachReply.nullable(),
    contact: z.object({ id: z.string(), name: z.string() }).nullable(),
    reason: z.string().nullable(),
    attempts: z.number().int(),
    sources: z.array(z.string()),
    reachOutId: z.string().nullable(),
    /** A test run: what would have been sent; nothing was. */
    testRun: z.boolean().optional(),
    plan: z.array(ReachChannel).optional(),
  })
  .meta({ id: "ReachOutOutput" });
export type ReachOutOutput = z.infer<typeof ReachOutOutput>;
