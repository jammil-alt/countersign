import { z } from "zod";
import { CallOutcome, InboundDecision } from "../calls/rules";
import { isUuid } from "../ids";
import { E164 } from "../messaging/rules";
import { defineRoute } from "./contract";

// Phone calls by agents (docs/plan.md §1.19, §1.23): the operator turns calls on for a client and
// for each of its Twilio numbers, and sets where unanswered calls are forwarded; the public routes
// Twilio and ElevenLabs call during and after a call. Calls themselves show in each contact's
// thread (the messaging routes).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;

export const CallNumber = z.object({
  sid: z.string(),
  phoneNumber: E164,
  /** Twilio says the number takes calls. */
  voice: z.boolean(),
  /** Its incoming calls come to us (VoiceUrl set to our webhook). */
  answering: z.boolean(),
});
export type CallNumber = z.infer<typeof CallNumber>;

/** Who answers an inbound call now, and why: the same check the webhook makes. */
export const InboundPreview = z.object({
  decision: InboundDecision,
  /** The agent that answers, or whose answering step was found. */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  /** Plain words: why this decision. */
  reason: z.string(),
});
export type InboundPreview = z.infer<typeof InboundPreview>;

export const CallsSetup = z.object({
  /** Whether this deployment has Mezonas' ElevenLabs account (key and webhook secret). */
  available: z.boolean(),
  /** Whether the client has a Twilio subaccount (texts and WhatsApp setup). */
  twilio: z.boolean(),
  /** Calls are on for this client: agents may place calls and its numbers may answer. */
  enabled: z.boolean(),
  /** Unanswered inbound calls are forwarded here; else voicemail. */
  forwardTo: E164.nullable(),
  numbers: z.array(CallNumber),
  inbound: InboundPreview.nullable(),
  webhooks: z.object({
    voice: z.string(),
    answer: z.string(),
    status: z.string(),
    tools: z.string(),
    postCall: z.string(),
  }),
});
export type CallsSetup = z.infer<typeof CallsSetup>;

export const CallSummary = z.object({
  /** Twilio's call id (CA…). */
  sid: z.string(),
  direction: z.enum(["in", "out"]),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  from: z.string(),
  to: z.string(),
  outcome: CallOutcome.nullable(),
  durationSecs: z.number().int().nullable(),
  /** The call's summary (model-written from what was said: data, not instructions). */
  summary: z.string().nullable(),
  agentName: z.string().nullable(),
  startedAt: z.string(),
});
export type CallSummary = z.infer<typeof CallSummary>;

const ClientParams = z.object({ id: Id });
const SetupResponse = z.object({ setup: CallsSetup, calls: z.array(CallSummary) });

export const callRoutes = {
  opsCalls: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/calls",
    auth: "session",
    roles: OPS,
    summary: "A client's calls setup (numbers, forwarding, who answers) and recent calls",
    params: ClientParams,
    response: SetupResponse,
  }),
  opsCallsSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/calls",
    auth: "session",
    roles: OPS,
    summary: "Turn calls on or off for a client and set where unanswered calls go",
    params: ClientParams,
    body: z.strictObject({ enabled: z.boolean(), forwardTo: E164.nullable() }),
    response: SetupResponse,
  }),
  opsCallsNumber: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/calls/numbers/:sid",
    auth: "session",
    roles: OPS,
    summary: "Send a number's incoming calls to us (or stop)",
    params: z.object({ id: Id, sid: z.string().regex(/^PN[0-9a-fA-F]{32}$/) }),
    body: z.strictObject({ answering: z.boolean() }),
    response: SetupResponse,
  }),
  // Twilio's voice webhooks: no session; X-Twilio-Signature is the credential. They answer TwiML.
  twilioVoiceInbound: defineRoute({
    method: "POST",
    path: "/api/twilio/:tenantId/voice",
    auth: "public",
    roles: [],
    summary: "Twilio: someone is calling one of the client's numbers (signed)",
    params: z.object({ tenantId: Id }),
    response: z.string(),
  }),
  twilioVoiceAnswer: defineRoute({
    method: "POST",
    path: "/api/twilio/:tenantId/voice/answer",
    auth: "public",
    roles: [],
    summary: "Twilio: a call an agent placed was picked up (signed)",
    params: z.object({ tenantId: Id }),
    query: z.object({ call: Id }),
    response: z.string(),
  }),
  twilioVoiceStatus: defineRoute({
    method: "POST",
    path: "/api/twilio/:tenantId/voice/status",
    auth: "public",
    roles: [],
    summary: "Twilio: a call ended, or a voicemail was recorded (signed)",
    params: z.object({ tenantId: Id }),
    response: z.string(),
  }),
  // ElevenLabs, during and after a call.
  voiceTool: defineRoute({
    method: "POST",
    path: "/api/voice/:tenantId/tools/:tool",
    auth: "public",
    roles: [],
    summary: "ElevenLabs: the voice agent uses a read tool during a call (the call's token)",
    params: z.object({ tenantId: Id, tool: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }),
    response: z.object({ result: z.unknown() }),
  }),
  elevenlabsPostCall: defineRoute({
    method: "POST",
    path: "/api/elevenlabs/post-call",
    auth: "public",
    roles: [],
    summary: "ElevenLabs: a call's transcript and summary, after it ended (signed)",
    response: z.object({ ok: z.literal(true) }),
  }),
} as const;
