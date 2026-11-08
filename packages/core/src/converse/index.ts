// P-4: conversations with people (ARCHITECTURE §10.12; docs/plan.md §1.66).
//
// The built-in skill `comms.converse`: one step in which the agent talks with one person on one
// channel until a typed goal is met (and confirmed, when asked), within limits on messages, time and
// cost. Each message to a contact is a reach-out of its own, so every check reach out makes holds
// per message; a limit hands the conversation to a person. Pure: schemas, limits and validation.

import { z } from "zod";
import { Duration, parseDuration } from "../duration";
import { isPlainObject } from "../json";
import { DecimalString } from "../money";
import { JsonSchema } from "../schemas/common";
import { hasTemplate } from "../template/template";
// P-7
import { OpsTranslationView, TranslationView } from "../translate/settings";

export const CONVERSE_SKILL = "comms.converse";

/** Contacts talk on the first three; a client user in the portal (the agent's thread). */
export const CONVERSE_CHANNELS = ["whatsapp", "sms", "email", "portal"] as const;
export const ConverseChannel = z.enum(CONVERSE_CHANNELS);
export type ConverseChannel = z.infer<typeof ConverseChannel>;

// DECISION: caps keep a conversation bounded whatever the operator types (docs/plan.md §1.66).
export const CONVERSE_DEFAULTS = {
  maxMessages: 6,
  waitPerReply: "1 day" as Duration,
  deadline: "3 days" as Duration,
  maxCostUsd: "0.50",
} as const;
export const CONVERSE_CAPS = {
  maxMessages: 12,
  waitPerReplyMs: 7 * 24 * 3600_000,
  deadlineMs: 14 * 24 * 3600_000,
  maxCostUsd: 5,
  /** Properties in the goal's result. */
  resultFields: 30,
} as const;

/** Text a step writes for the model: a goal, a brief. */
const Brief = z.string().trim().min(1).max(2000);

export const ConverseTo = z.union([
  z.strictObject({ role: z.string().trim().min(1).max(60) }),
  /** A directory contact: a uuid, or a template that resolves to one (`{{trigger.contactId}}`). */
  z.strictObject({ contactId: z.string().min(1).max(200) }),
  /** A client user, in the portal. */
  z.strictObject({ userId: z.string().min(1).max(200) }),
]);
export type ConverseTo = z.infer<typeof ConverseTo>;

export const ConverseLimits = z.strictObject({
  /** Messages we send (the closing thank-you not counted). */
  maxMessages: z
    .number()
    .int()
    .min(1)
    .max(CONVERSE_CAPS.maxMessages)
    .default(CONVERSE_DEFAULTS.maxMessages),
  /** How long each reply may take. */
  waitPerReply: Duration.default(CONVERSE_DEFAULTS.waitPerReply),
  /** How long the whole conversation may take. */
  deadline: Duration.default(CONVERSE_DEFAULTS.deadline),
  /** What its model calls may cost, in USD. */
  maxCostUsd: DecimalString.default(CONVERSE_DEFAULTS.maxCostUsd),
});
export type ConverseLimits = z.infer<typeof ConverseLimits>;

export const WhatsAppTemplate = z.strictObject({
  id: z.string().trim().min(1).max(100),
  variables: z.record(z.string(), z.string().max(500)).default({}),
});

export const ConverseInput = z
  .strictObject({
    to: ConverseTo,
    channel: ConverseChannel,
    /** What to find out or settle: fixed text, it becomes instructions. */
    goal: Brief,
    /** The result's shape: a JSON Schema object, fixed. Later steps read it typed. */
    result: JsonSchema,
    /** Ask the person to confirm the result before it counts. */
    confirm: z.boolean().default(true),
    /** What the first message says: fixed text, the model writes the message from it. */
    opening: Brief,
    /** WhatsApp only: an approved template for an opening outside the 24-hour window. */
    whatsappTemplate: WhatsAppTemplate.optional(),
    /** The records it concerns (ids): its sources. */
    about: z.array(z.string().min(1).max(100)).max(20).default([]),
    /** The records' data the model may use: data, never instructions (invariant 9). */
    data: z.unknown().optional(),
    limits: ConverseLimits.default({
      maxMessages: CONVERSE_DEFAULTS.maxMessages,
      waitPerReply: CONVERSE_DEFAULTS.waitPerReply,
      deadline: CONVERSE_DEFAULTS.deadline,
      maxCostUsd: CONVERSE_DEFAULTS.maxCostUsd,
    }),
  })
  .meta({ id: "ConverseInput" });
export type ConverseInput = z.infer<typeof ConverseInput>;
export type ConverseInputIn = z.input<typeof ConverseInput>;

/** The fields the step must write itself (§1.23's rule): they become instructions. */
export const CONVERSE_FIXED_INPUTS = ["goal", "result", "opening"] as const;

export const CONVERSE_OUTCOMES = [
  "completed",
  "handed_over",
  "opted_out",
  "declined",
  "not_allowed",
  "not_sent",
] as const;
export const ConverseOutcome = z.enum(CONVERSE_OUTCOMES);
export type ConverseOutcome = z.infer<typeof ConverseOutcome>;

export const ConverseLine = z.object({
  direction: z.enum(["out", "in"]),
  /** Ours: what we sent. Theirs: their words, untrusted data (invariant 9). */
  text: z.string(),
  at: z.string().nullable(),
  /** The reach-out of our message; the raw record (or thread message) of theirs. */
  sourceId: z.string().nullable(),
});
export type ConverseLine = z.infer<typeof ConverseLine>;

export const ConverseOutput = z
  .object({
    outcome: ConverseOutcome,
    /** The goal's result (typed by the step's `result`), or null. */
    result: z.unknown(),
    confirmed: z.boolean(),
    who: z
      .object({ kind: z.enum(["contact", "user"]), id: z.string(), name: z.string() })
      .nullable(),
    channel: ConverseChannel,
    /** Messages we sent. */
    messages: z.number().int(),
    replies: z.number().int(),
    transcript: z.array(ConverseLine),
    sources: z.array(z.string()),
    reason: z.string().nullable(),
    costUsd: z.string(),
    /** A test run: the first message as it would have gone; nothing was sent. */
    testRun: z.boolean().optional(),
    opening: z.string().optional(),
  })
  .meta({ id: "ConverseOutput" });
export type ConverseOutput = z.infer<typeof ConverseOutput>;

// ── The model's answer each turn ────────────────────────────────────────────────────────────────

export const CONVERSE_TURN_TOOL = "turn";
export const CONVERSE_READ_TOOL = "read_conversation";
export const CONVERSE_MESSAGE_MAX = 1500;

const Message = z.string().trim().min(1).max(CONVERSE_MESSAGE_MAX);

/**
 * One turn's answer. No field names a recipient, a channel, an approval or a limit, so nothing the
 * person writes can change them (invariant 9).
 */
export const ConverseAnswer = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("ask"), message: Message }),
  z.strictObject({ action: z.literal("confirm"), message: Message, result: z.unknown() }),
  z.strictObject({
    action: z.literal("done"),
    result: z.unknown(),
    confirmed: z.boolean(),
    closing: Message.optional(),
  }),
  z.strictObject({ action: z.literal("give_up"), reason: z.string().trim().min(1).max(1000) }),
]);
export type ConverseAnswer = z.infer<typeof ConverseAnswer>;

/** The `turn` tool's input schema for the model, with `result` typed by the goal. */
export function converseTurnSchema(result: JsonSchema): Record<string, unknown> {
  const r = { ...result };
  delete r.$schema;
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["ask", "confirm", "done", "give_up"],
        description:
          "ask: send `message` and wait for the reply. confirm: send `message` restating `result` and asking the person to confirm it. done: the goal is met (`result`, and whether the person `confirmed` it). give_up: you can't reach the goal (`reason`).",
      },
      message: { type: "string", maxLength: CONVERSE_MESSAGE_MAX },
      result: r,
      confirmed: { type: "boolean" },
      closing: {
        type: "string",
        maxLength: CONVERSE_MESSAGE_MAX,
        description: "With done: a short last message (thanks), optional.",
      },
      reason: { type: "string" },
    },
    required: ["action"],
  };
}

/**
 * Whether `done` may end the conversation: with `confirm`, only right after a `confirm` message was
 * answered, and with `confirmed: true`. Null when it may, else why not.
 */
export function doneProblem(
  answer: Extract<ConverseAnswer, { action: "done" }>,
  needsConfirm: boolean,
  lastAsked: "ask" | "confirm" | null,
): string | null {
  if (!needsConfirm) return null;
  if (lastAsked !== "confirm") return "confirm the result with the person before finishing";
  if (!answer.confirmed) return "the person hasn't confirmed the result";
  return null;
}

// ── Subjects and names ──────────────────────────────────────────────────────────────────────────

/** A conversation's reach-out subject: one open message per conversation and person. */
export function converseSubject(runId: string, key: string): string {
  return `converse:${runId}:${key}`.slice(0, 500);
}

export function isConverseSubject(subject: string): boolean {
  return subject.startsWith("converse:");
}

/** The durable node of message `n` (1..) of a conversation keyed `key`. */
export function converseMessageNode(key: string, n: number): string {
  return `${key}:m${n}`;
}

export const CONVERSE_CHANNEL_WORDS: Record<ConverseChannel, string> = {
  whatsapp: "WhatsApp",
  sms: "text",
  email: "email",
  portal: "the portal",
};

// ── Validation (one function for the builder and the server, invariant 4) ───────────────────────

export interface ConverseProblem {
  field: string;
  message: string;
}

function durationMs(d: unknown): number | null {
  if (typeof d !== "string" || hasTemplate(d)) return null;
  try {
    return parseDuration(d as Duration);
  } catch {
    return null;
  }
}

/**
 * Problems with a conversation step's input as written (literal, templates unresolved). The input
 * schema checks types; this checks what it can't: the goal's result is an object schema with
 * fields, the channel fits who it is with, the limits within their caps, a template only on
 * WhatsApp.
 */
export function converseProblems(input: unknown): ConverseProblem[] {
  const out: ConverseProblem[] = [];
  if (!isPlainObject(input))
    return [{ field: "input", message: "give the conversation's settings" }];
  const result = input.result;
  if (!isPlainObject(result) || result.type !== "object" || !isPlainObject(result.properties)) {
    out.push({ field: "result", message: "describe the result as an object with fields" });
  } else {
    const n = Object.keys(result.properties).length;
    if (n === 0) out.push({ field: "result", message: "the result needs at least one field" });
    if (n > CONVERSE_CAPS.resultFields) {
      out.push({
        field: "result",
        message: `the result can have at most ${CONVERSE_CAPS.resultFields} fields`,
      });
    }
  }
  const to = isPlainObject(input.to) ? input.to : {};
  const channel = input.channel;
  if (typeof channel === "string" && !hasTemplate(channel)) {
    if ("userId" in to && channel !== "portal") {
      out.push({ field: "channel", message: "a client user is reached in the portal" });
    }
    if (!("userId" in to) && channel === "portal") {
      out.push({ field: "channel", message: "the portal is for client users: pick a channel" });
    }
    if (input.whatsappTemplate !== undefined && channel !== "whatsapp") {
      out.push({ field: "whatsappTemplate", message: "a template is for WhatsApp only" });
    }
  }
  const limits = isPlainObject(input.limits) ? input.limits : {};
  const wait = durationMs(limits.waitPerReply);
  if (wait !== null && wait > CONVERSE_CAPS.waitPerReplyMs) {
    out.push({ field: "limits.waitPerReply", message: "wait at most 7 days for a reply" });
  }
  const deadline = durationMs(limits.deadline);
  if (deadline !== null && deadline > CONVERSE_CAPS.deadlineMs) {
    out.push({ field: "limits.deadline", message: "a conversation can last at most 14 days" });
  }
  if (wait !== null && deadline !== null && wait > deadline) {
    out.push({
      field: "limits.waitPerReply",
      message: "the wait for a reply can't be longer than the whole conversation",
    });
  }
  const cost = limits.maxCostUsd;
  if (typeof cost === "string" && Number(cost) > CONVERSE_CAPS.maxCostUsd) {
    out.push({ field: "limits.maxCostUsd", message: "spend at most $5 on one conversation" });
  }
  return out;
}

/**
 * The step's output schema with `result` typed by the step's own `result` (a literal JSON Schema),
 * for template typing (`{{steps.<id>.output.result.<field>}}`).
 */
export function typedResultOutput(
  output: JsonSchema | undefined,
  field: string,
  stepInput: unknown,
): JsonSchema | undefined {
  if (!output || !isPlainObject(stepInput)) return output;
  const schema = stepInput[field];
  if (!isPlainObject(schema) || hasTemplate(schema) || schema.type !== "object") return output;
  // A schema made from a Zod object with an id is a `$ref` into its `$defs`: type the object itself.
  let base: JsonSchema = output;
  const ref = output.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/") && isPlainObject(output.$defs)) {
    const def = output.$defs[ref.slice("#/$defs/".length)];
    if (isPlainObject(def)) {
      base = { ...def, $defs: output.$defs };
    }
  }
  const properties = isPlainObject(base.properties) ? base.properties : {};
  return {
    ...base,
    properties: { ...properties, result: { anyOf: [schema, { type: "null" }] } },
  };
}

// ── What the run pages show ─────────────────────────────────────────────────────────────────────

// P-6: who stepped in or edited, as each surface names them (docs/plan.md §1.68).
/** A person on the transcript: `us` is Mezonas (the operator); the portal never names our people. */
export const ConverseActor = z.object({ us: z.boolean(), name: z.string().nullable() });
export type ConverseActor = z.infer<typeof ConverseActor>;

/** A person taking the conversation over or ending it, on the transcript (no model call). */
export const ConverseEvent = z.object({
  kind: z.enum(["taken_over", "ended"]),
  at: z.string(),
  by: ConverseActor,
  reason: z.string().nullable(),
});
export type ConverseEvent = z.infer<typeof ConverseEvent>;

/** One message on a run page. The back office also sees the turn's model and cost. */
export const ConverseViewMessage = z.object({
  turn: z.number().int(),
  direction: z.enum(["out", "in"]),
  text: z.string(),
  at: z.string().nullable(),
  /** Ours: sent, waiting for a signature, held for quiet hours, failed, or not sent. */
  status: z.string(),
  model: z.string().optional(),
  costUsd: z.string().optional(),
  // P-6: changed before it was approved; the agent's original is kept (§1.68).
  edited: z
    .object({ original: z.string().nullable(), by: ConverseActor, at: z.string() })
    .optional(),
  // P-7: a reply's translation into the working language (docs/plan.md §1.69).
  translation: OpsTranslationView.optional(),
});

/** The back office's view of a conversation step (`GET /api/ops/runs/:id`). */
export const ConverseOpsView = z.object({
  channel: ConverseChannel,
  who: z.object({ id: z.string(), name: z.string() }).nullable(),
  outcome: ConverseOutcome.nullable(),
  messages: z.array(ConverseViewMessage),
  costUsd: z.string(),
  // P-6: take-overs and ends, in order (§1.68).
  events: z.array(ConverseEvent).optional(),
});
export type ConverseOpsView = z.infer<typeof ConverseOpsView>;

/**
 * The portal's: the client's side of the conversation only, never a prompt, a model or a cost
 * (invariant 11).
 */
export const ConversePortalView = z.object({
  messages: z.array(
    z.object({
      direction: z.enum(["out", "in"]),
      text: z.string(),
      at: z.string().nullable(),
      // P-6: who changed it before it went (never the agent's draft).
      edited: z.object({ by: ConverseActor }).optional(),
      // P-7: a reply's translation, beside it (§1.69).
      translation: TranslationView.optional(),
    }),
  ),
  // P-6: take-overs and ends (§1.68); whether it is still going, and whether this person (the
  // conversation's approver) may take it over or end it.
  events: z.array(ConverseEvent).optional(),
  live: z.boolean().optional(),
  mayControl: z.boolean().optional(),
});
export type ConversePortalView = z.infer<typeof ConversePortalView>;
