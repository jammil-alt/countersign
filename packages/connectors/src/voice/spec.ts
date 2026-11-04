// The call tools and events as agents and workflows see them (docs/plan.md §1.19, §1.23): a call is
// placed and answered on the client's Twilio number, and an ElevenLabs voice agent speaks. The ids
// are provider-neutral (shared namespace `call.`) like the messaging ones.

import { CALL_DEFAULT_MINUTES, CALL_MAX_MINUTES, CallOutcome, E164 } from "@countersign/core";
import { z } from "zod";

export const CALL_NAMESPACES = ["call"] as const;

export const CALL_PLACE_TOOL = "call.place";
export const CALL_ANSWER_TOOL = "call.answer";
export const CALL_GET_TOOL = "call.get";
export const CALL_RECEIVED_EVENT = "call.received";
export const CALL_COMPLETED_EVENT = "call.completed";

export const CallSid = z.string().regex(/^CA[0-9a-f]{32}$/, "a Twilio call id (CA…)");

/** A tool id the voice agent may use during the call (checked again at call time: reads only). */
const ReadToolId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/, "a tool id");

/**
 * How the voice agent speaks, from the step in the agent's version (invariant 4): what the call is
 * for, its own opening (after the automated-assistant disclosure, which is fixed in code), the
 * voice, the read tools it may use and how long it may last. The language is the contact's, else
 * the client's.
 */
export const VoiceSettings = z.object({
  /** What the call is for, in plain words: shown on the approval card and given to the agent. */
  purpose: z.string().trim().min(1).max(500),
  /** Said after the disclosure, e.g. "I'm calling about your order for Friday." */
  firstMessage: z.string().trim().max(300).optional(),
  /** An ElevenLabs voice id; the account's default voice when absent. */
  voiceId: z
    .string()
    .regex(/^[A-Za-z0-9]{8,40}$/)
    .optional(),
  /** Read tools the agent may use while it talks. Writes are refused, whatever is listed. */
  tools: z.array(ReadToolId).max(10).default([]),
  maxMinutes: z.number().int().min(1).max(CALL_MAX_MINUTES).default(CALL_DEFAULT_MINUTES),
});
export type VoiceSettings = z.infer<typeof VoiceSettings>;

/**
 * The settings that become the voice agent's instructions and opening line: fixed text in the
 * step only, never a template or a model's words (ToolSpec `fixedInputs`, invariant 9), so what a
 * contact texted or said can't steer a call.
 */
export const VOICE_FIXED_INPUTS = ["purpose", "firstMessage"];

export const CallPlaceInput = VoiceSettings.extend({
  /** The contact's phone, E.164. They must be a contact of this client who agreed to calls. */
  to: E164,
});

export const CallPlaceOutput = z.object({
  callSid: z.string(),
  status: z.string(),
  to: z.string(),
  from: z.string(),
  contactName: z.string(),
});

/** Who the call is to, why and what the agent may do: the approval card's "before". */
export const CallPlaceBefore = z.object({
  contact: z.object({ id: z.string(), name: z.string() }),
  to: z.string(),
  from: z.string(),
  purpose: z.string(),
  tools: z.array(z.string()),
  maxMinutes: z.number().int(),
});

/**
 * Answering an inbound call: the step an operator adds to a workflow on `call.received`. The call
 * is answered at the moment it rings, by the webhook, only if this step may run without approval
 * (the step set to `not_required`, the matrix allowing `auto` for create, the agent in `act`); the
 * run then records that answer once. Otherwise the call goes to voicemail or is forwarded.
 */
export const CallAnswerInput = VoiceSettings.extend({ callSid: CallSid });
export const CallAnswerOutput = z.object({
  callSid: z.string(),
  answered: z.literal(true),
  from: z.string(),
  contactName: z.string(),
});
export const CallAnswerBefore = z.object({ callSid: z.string(), from: z.string() });

export const CallTurn = z.object({
  speaker: z.enum(["agent", "contact"]),
  /** What was said: data, never instructions. */
  text: z.string(),
  atSecs: z.number().nullable(),
});

/** One call as tools return it. Transcript and summary are the call's words: data only. */
export const CallRecord = z.object({
  sid: z.string(),
  direction: z.enum(["in", "out"]),
  from: z.string(),
  to: z.string(),
  contactName: z.string().nullable(),
  status: z.string(),
  outcome: CallOutcome.nullable(),
  durationSecs: z.number().int().nullable(),
  startedAt: z.string(),
  summary: z.string().nullable(),
  transcript: z.array(CallTurn),
  /** False when the person didn't agree to a record of the call: nothing of what was said is kept. */
  transcriptKept: z.boolean(),
  /** A voicemail they left (Twilio's recording id and length). */
  recording: z.object({ sid: z.string(), durationSecs: z.number().int().nullable() }).nullable(),
  /** What they asked for during the call that would change a record: for a person to review. */
  followUps: z.array(z.string()),
});
export type CallRecord = z.infer<typeof CallRecord>;

export const CallGetInput = z.object({ callSid: CallSid });
export const CallGetOutput = z.object({ call: CallRecord });

export const CallReceivedPayload = z.strictObject({
  connectionId: z.uuid(),
  callSid: z.string(),
  rawRecordId: z.uuid(),
  contactId: z.uuid(),
  knownContact: z.boolean(),
  from: z.string(),
  to: z.string(),
  /** Who took it: an agent, a forward, or voicemail. */
  decision: z.enum(["agent", "forward", "voicemail"]),
  reason: z.string(),
  receivedAt: z.iso.datetime({ offset: true }),
});
export type CallReceivedPayload = z.infer<typeof CallReceivedPayload>;

export const CallCompletedPayload = z.strictObject({
  connectionId: z.uuid(),
  callSid: z.string(),
  direction: z.enum(["in", "out"]),
  contactId: z.uuid().nullable(),
  outcome: CallOutcome,
  durationSecs: z.number().int().nullable(),
  /** The call's record; its transcript (when kept) is read with `call.get`. */
  rawRecordId: z.uuid(),
  followUps: z.number().int(),
  at: z.iso.datetime({ offset: true }),
});
export type CallCompletedPayload = z.infer<typeof CallCompletedPayload>;

export const CALL_EVENTS = [
  {
    type: CALL_RECEIVED_EVENT,
    description: "Someone called one of your numbers.",
    subjectType: "raw_record",
    payload: z.toJSONSchema(CallReceivedPayload, { io: "input" }) as Record<string, unknown>,
    sample: {
      connectionId: "0192f7a0-0000-7000-8000-000000000001",
      callSid: "CA0123456789abcdef0123456789abcdef",
      rawRecordId: "0192f7a0-0000-7000-8000-000000000003",
      contactId: "0192f7a0-0000-7000-8000-000000000004",
      knownContact: true,
      from: "+15555550100",
      to: "+15555550199",
      decision: "agent",
      reason: "answered by Front desk",
      receivedAt: "2026-11-04T15:00:00.000Z",
    },
  },
  {
    type: CALL_COMPLETED_EVENT,
    description: "A call ended: answered by an agent, voicemail, forwarded or not picked up.",
    subjectType: "raw_record",
    payload: z.toJSONSchema(CallCompletedPayload, { io: "input" }) as Record<string, unknown>,
    sample: {
      connectionId: "0192f7a0-0000-7000-8000-000000000001",
      callSid: "CA0123456789abcdef0123456789abcdef",
      direction: "out",
      contactId: "0192f7a0-0000-7000-8000-000000000004",
      outcome: "answered",
      durationSecs: 94,
      rawRecordId: "0192f7a0-0000-7000-8000-000000000005",
      followUps: 1,
      at: "2026-11-04T15:02:00.000Z",
    },
  },
];
