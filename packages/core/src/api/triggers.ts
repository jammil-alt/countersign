import { z } from "zod";
import { isUuid } from "../ids";
import { INBOUND_NAME_MAX, isInboundName } from "../threads/command";
import { defineRoute } from "./contract";

// v0.12 W2-E: the triggers list (ARCHITECTURE §10.8, §14; docs/plan.md §1.48). The operator's view
// of how a client agent starts: each trigger of its live (else latest) version, with its workflow,
// guards and when it last fired (from `run.trigger`, no new table).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const CLIENT = ["client_admin", "client_user"] as const;

export const TriggerListItem = z.object({
  workflow: z.string(),
  workflowName: z.string(),
  enabled: z.boolean(),
  triggerId: z.string(),
  type: z.string(),
  /** True for the workflow's first trigger, false for one of `moreTriggers`. */
  first: z.boolean(),
  /** One line in plain words: "Weekdays at 0 7 * * 1-5, skips holidays". */
  summary: z.string(),
  /** The trigger's guards as written: filter, dedupe key, rate limit, People, channels, holidays. */
  guards: z.record(z.string(), z.unknown()),
  lastFired: z
    .object({ at: z.string(), runId: z.string(), status: z.string(), mode: z.string() })
    .nullable(),
});
export type TriggerListItem = z.infer<typeof TriggerListItem>;

export const AgentTriggers = z.object({
  agentId: z.string(),
  versionId: z.string().nullable(),
  /** Whether the version listed is the live one (else the latest). */
  live: z.boolean(),
  /** `/name` in client threads; null while the agent isn't active. */
  commandName: z.string().nullable(),
  /** The agent's own email address; null without EMAIL_FORWARDING_DOMAIN or a command name. */
  address: z.string().nullable(),
  /** The name the operator gave the address's first part; null: it reads as computed. */
  inboundName: z.string().nullable(),
  /** The agent is in the Sandbox client: its address can be named and test messages sent. */
  sandbox: z.boolean(),
  triggers: z.array(TriggerListItem),
});
export type AgentTriggers = z.infer<typeof AgentTriggers>;

/** The first part of an agent's address as an operator writes it: `ap-inbox`. */
export const InboundName = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => isInboundName(v), {
    message: `2 to ${INBOUND_NAME_MAX} lower-case letters, digits and dashes, not starting or ending with a dash`,
  });

export const AgentAddressBody = z.strictObject({
  /** The new first part; null goes back to the name read from the agent's name. */
  name: InboundName.nullable(),
});
export type AgentAddressBody = z.infer<typeof AgentAddressBody>;

export const AgentAddressAnswer = z.object({
  inboundName: z.string().nullable(),
  /** `/name` in the client's threads, which follows the address; null while not active. */
  commandName: z.string().nullable(),
  /** The full address; null without EMAIL_FORWARDING_DOMAIN or while the agent isn't active. */
  address: z.string().nullable(),
});
export type AgentAddressAnswer = z.infer<typeof AgentAddressAnswer>;

/** The channels a test message can come in on. */
export const TestMessageChannel = z.enum(["email", "sms", "whatsapp"]);
export type TestMessageChannel = z.infer<typeof TestMessageChannel>;

/** Most files a test message carries, as an email to an agent keeps. */
export const TEST_MESSAGE_MAX_DOCUMENTS = 20;

/**
 * A message to a Sandbox agent as if it came in on a channel from one of the Sandbox's contacts,
 * past the carrier: no email is received and no text is sent.
 */
export const TestMessageBody = z.strictObject({
  agentId: Id,
  channel: TestMessageChannel,
  fromContactId: Id,
  /** Email only. */
  subject: z.string().trim().max(300).optional(),
  text: z.string().max(20_000),
  /** The Sandbox's own documents (uploaded with `?for=try`), as the message's attachments. */
  documentIds: z.array(Id).max(TEST_MESSAGE_MAX_DOCUMENTS).optional(),
});
export type TestMessageBody = z.infer<typeof TestMessageBody>;

/** What a test message did, as the real one would have. */
export const TestMessageAnswer = z.discriminatedUnion("status", [
  z.object({
    /** A trigger took it and its run started. */
    status: z.literal("started"),
    runId: Id,
    rawRecordId: Id,
    /** The confirmation the sender would have been sent; null when the trigger has none. */
    reply: z.string().nullable(),
  }),
  z.object({
    /** A trigger took it and `inbound.message` was emitted, but no run started from it. */
    status: z.literal("accepted"),
    rawRecordId: Id,
    eventId: z.string().nullable(),
    reply: z.string().nullable(),
  }),
  z.object({
    status: z.literal("refused"),
    /** A code: `sender_not_allowed`, `no_trigger`, `agent_not_active`, `waiting_on_reply`. */
    reason: z.string(),
    /** The reason in plain words: "the sender isn't one of the people it takes messages from". */
    message: z.string(),
    /** The polite reply the sender would have been sent; null when none would go. */
    reply: z.string().nullable(),
  }),
]);
export type TestMessageAnswer = z.infer<typeof TestMessageAnswer>;

/**
 * How one of the client's agents starts, as the portal's Agent settings tab says it: what kind of
 * trigger, the facts its words need and when it last started a run. Never its guards, filters,
 * hooks or anything else of the bundle (invariant 11); event types are mapped to words by the
 * portal, which shows a generic line for any it has none for.
 */
export const PortalTrigger = z.object({
  /** The job (workflow) it starts, by its name. */
  job: z.string(),
  type: z.enum(["event", "schedule", "manual", "command", "webhook", "message", "handoff"]),
  /** For an event trigger: the event type ("document.extracted"). */
  event: z.string().nullable(),
  /** For a schedule: its cron and zone (null: the client's own), and whether it skips holidays. */
  cron: z.string().nullable(),
  tz: z.string().nullable(),
  skipsHolidays: z.boolean(),
  /** For a manual trigger: the client may start it with Run now. */
  clientCanRun: z.boolean(),
  /** For a message trigger: the channels it listens on (email, sms, whatsapp, command, sloan). */
  channels: z.array(z.string()),
  /** When it last started a live run; null when it never has. */
  lastStartedAt: z.string().nullable(),
});
export type PortalTrigger = z.infer<typeof PortalTrigger>;

export const PortalAgentTriggers = z.object({
  /** `/name` in the client's threads; null while the agent isn't active. */
  commandName: z.string().nullable(),
  /** The triggers of its enabled jobs, in the order its jobs are listed. */
  triggers: z.array(PortalTrigger),
});
export type PortalAgentTriggers = z.infer<typeof PortalAgentTriggers>;

export const triggerRoutes = {
  portalAgentTriggers: defineRoute({
    method: "GET",
    path: "/api/services/:id/triggers",
    auth: "session",
    roles: CLIENT,
    summary:
      "How one of your services starts: each trigger of its jobs in plain facts, never its rules",
    params: z.object({ id: Id }),
    response: PortalAgentTriggers,
  }),
  opsAgentTriggers: defineRoute({
    method: "GET",
    path: "/api/ops/agents/:id/triggers",
    auth: "session",
    roles: OPS,
    summary: "A client agent's triggers: each with its workflow, guards and when it last fired",
    params: z.object({ id: Id }),
    response: AgentTriggers,
  }),
  opsAgentAddress: defineRoute({
    method: "PUT",
    path: "/api/ops/agents/:id/address",
    auth: "session",
    roles: OPS,
    summary:
      "Name the first part of a Sandbox agent's email address (its /command follows it); 409 name_taken when another of the client's agents has it or would lose its own; 422 not_sandbox in any other client",
    params: z.object({ id: Id }),
    body: AgentAddressBody,
    response: AgentAddressAnswer,
  }),
  opsSandboxTestMessage: defineRoute({
    method: "POST",
    path: "/api/ops/sandbox/test-messages",
    auth: "session",
    roles: OPS,
    summary:
      "Send a Sandbox agent a test message by email, text or WhatsApp from one of the Sandbox's contacts: it goes in as a received one would, past the carrier, and starts the same live run (every write signed in its trial); refused in plain words when no trigger takes it; 422 not_sandbox in any other client",
    body: TestMessageBody,
    response: TestMessageAnswer,
  }),
} as const;
