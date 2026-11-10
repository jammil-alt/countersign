// R7 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Conversations as a step"): the `conversation`
// step's contract. Pure. The step is a new front door to P-4's conversation engine (§10.12,
// `comms.converse`), not a new engine: `toConverseInput` turns a step into the engine's own input
// (`ConverseInput`), so every check the engine makes per message (each message a reach-out, opt-out,
// consent, quiet hours, the person's autonomy, the agent's stage, the matrix and grant) still holds.
// Calls go through P-2's voice path, gathering or confirming only (`callBrief`).

import { z } from "zod";
import { CALL_DEFAULT_MINUTES } from "../calls/rules";
import {
  CONVERSE_CAPS,
  CONVERSE_DEFAULTS,
  type ConverseChannel,
  type ConverseInputIn,
  type ConverseTo,
} from "../converse";
import { parseDuration } from "../duration";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import { CHANNEL_TOOLS, type ReachChannel } from "../reach/rules";
import type { JsonSchema } from "../schemas/common";
import { hasTemplate } from "../template/template";
import type { ConversationStep } from "./schema";

// ── Channels ─────────────────────────────────────────────────────────────────────────────────

export const CONVERSATION_CHANNELS = ["email", "sms", "whatsapp", "call"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];

/**
 * Each channel's reach-out channel (whose connector tools send it) and the conversation engine's
 * channel for text. A call has no text channel: it goes through the voice path (`call.place`).
 */
export const CONVERSATION_CHANNEL_MAP: Record<
  ConversationChannel,
  { reach: ReachChannel; converse: ConverseChannel | null }
> = {
  email: { reach: "email", converse: "email" },
  sms: { reach: "sms", converse: "sms" },
  whatsapp: { reach: "whatsapp", converse: "whatsapp" },
  call: { reach: "voice", converse: null },
};

/** The permission verb of every send: a message or a call creates something in the tool. */
export const CONVERSATION_SEND_VERB = "create" as const;

/**
 * The connector tools that can carry a conversation's channel, with the verb the gate checks: reach
 * out's own table (`CHANNEL_TOOLS`), so a channel bound to a connection sends exactly as reach out
 * does. The agent's channel binding picks the one connection.
 */
export function conversationSendTools(
  channel: ConversationChannel,
): { connector: string; tool: string; verb: typeof CONVERSATION_SEND_VERB }[] {
  const reach = CONVERSATION_CHANNEL_MAP[channel].reach;
  const out: { connector: string; tool: string; verb: typeof CONVERSATION_SEND_VERB }[] = [];
  for (const [connector, tools] of Object.entries(CHANNEL_TOOLS)) {
    const tool = tools[reach];
    if (tool) out.push({ connector, tool, verb: CONVERSATION_SEND_VERB });
  }
  return out;
}

// ── What it must find (`find`) ───────────────────────────────────────────────────────────────

/**
 * The types a `find` field may have. Anything else that reads like a record type (`contact`,
 * `qbo.vendor`) is a reference to one: what the person called it, as text.
 */
// DECISION: `find`'s types are a small plain-word set (the builder's words); `?` at the end makes a
// field optional and `[]` a list, e.g. `{ deliveryDate: "date", items: "text[]", note: "text?" }`.
// Money is a decimal string, never a float (invariant 6).
export const FIND_TYPES: Record<string, JsonSchema> = {
  text: { type: "string" },
  number: { type: "number" },
  integer: { type: "integer" },
  money: { type: "string", pattern: "^-?\\d{1,10}(\\.\\d{1,4})?$" },
  date: { type: "string", format: "date" },
  datetime: { type: "string", format: "date-time" },
  yes_no: { type: "boolean" },
  email: { type: "string", format: "email" },
  phone: { type: "string" },
};

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RECORD_TYPE_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export interface FindField {
  name: string;
  /** The base type: a `FIND_TYPES` key, or a record type. */
  type: string;
  list: boolean;
  optional: boolean;
  /** Whether `type` is a record type rather than one of `FIND_TYPES`. */
  record: boolean;
}

/** One `find` entry read, or why it can't be. */
export function parseFindField(
  name: string,
  spec: string,
): { field: FindField } | { problem: string } {
  if (!FIELD_RE.test(name)) {
    return { problem: `"${name}" isn't a field name: letters, digits and _ only` };
  }
  let t = spec.trim();
  const optional = t.endsWith("?");
  if (optional) t = t.slice(0, -1);
  const list = t.endsWith("[]");
  if (list) t = t.slice(0, -2);
  if (t in FIND_TYPES) return { field: { name, type: t, list, optional, record: false } };
  if (RECORD_TYPE_RE.test(t)) return { field: { name, type: t, list, optional, record: true } };
  return {
    problem: `"${spec}" isn't a type: use ${Object.keys(FIND_TYPES).join(", ")} or a record type`,
  };
}

/** The step's `find` read; fields that don't read are left out (see `conversationProblems`). */
export function findFields(find: Record<string, string>): FindField[] {
  const out: FindField[] = [];
  for (const [name, spec] of Object.entries(find)) {
    const r = parseFindField(name, spec);
    if ("field" in r) out.push(r.field);
  }
  return out;
}

function fieldSchema(f: FindField): JsonSchema {
  const base: JsonSchema = f.record
    ? { type: "string", description: `the ${f.type}, as the person names it` }
    : { ...(FIND_TYPES[f.type] as JsonSchema) };
  return f.list ? { type: "array", items: base } : base;
}

/** With an empty `find`: what the person said, in a line. */
// DECISION: an empty `find` still has one field (the engine's result needs one): `answer`, optional.
export const EMPTY_FIND_FIELD = "answer";

/** The result the conversation looks for, as a JSON Schema object (the engine's `result`). */
export function findResultSchema(find: Record<string, string>): JsonSchema {
  const fields = findFields(find);
  if (fields.length === 0) {
    return { type: "object", properties: { [EMPTY_FIND_FIELD]: { type: "string" } } };
  }
  const properties: Record<string, JsonSchema> = {};
  for (const f of fields) properties[f.name] = fieldSchema(f);
  const required = fields.filter((f) => !f.optional).map((f) => f.name);
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The fields the conversation must find for it to count as done. */
export function requiredFindFields(find: Record<string, string>): string[] {
  return findFields(find)
    .filter((f) => !f.optional)
    .map((f) => f.name);
}

/** A result narrowed to the step's `find` fields (anything else the model added is dropped). */
export function foundOf(find: Record<string, string>, result: unknown): Record<string, unknown> {
  if (!isPlainObject(result)) return {};
  const names = findFields(find).map((f) => f.name);
  if (names.length === 0) names.push(EMPTY_FIND_FIELD);
  const out: Record<string, unknown> = {};
  for (const n of names) {
    const v = result[n];
    if (v !== undefined && v !== null && v !== "") out[n] = v;
  }
  return out;
}

// ── The step's output ────────────────────────────────────────────────────────────────────────

/**
 * How a conversation ended. `done`: every required field found. `not_found`: it ended without
 * them (they didn't know, declined, opted out, or a person took it over without them).
 * `no_answer`: the step's deadline passed first (`deadline.ifNoAnswer` applies). `failed`: nothing
 * could be sent, a message wasn't approved, or the engine failed.
 */
export const CONVERSATION_STATUSES = ["done", "not_found", "no_answer", "failed"] as const;
export const ConversationStatus = z.enum(CONVERSATION_STATUSES);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const ConversationOutput = z.object({
  status: ConversationStatus,
  /** What it found, by `find` field: the person's words, data only (invariant 9). */
  found: z.record(z.string(), z.unknown()),
  conversationId: z.string().nullable(),
  /** One plain line for the timeline: never a prompt, a model or a cost (invariant 11). */
  summary: z.string(),
});
export type ConversationOutput = z.infer<typeof ConversationOutput>;

/** The step's output schema with `found` typed by its `find`, for the validator and the builder. */
export function conversationOutputSchema(step: Pick<ConversationStep, "find">): JsonSchema {
  const result = findResultSchema(step.find);
  return {
    type: "object",
    properties: {
      status: { type: "string", enum: [...CONVERSATION_STATUSES] },
      // Fields may be missing unless the status is `done`, so none is required here.
      found: { type: "object", properties: result.properties as Record<string, JsonSchema> },
      conversationId: { type: ["string", "null"] },
      summary: { type: "string" },
    },
    required: ["status", "found", "conversationId", "summary"],
  };
}

// ── Ids and events ───────────────────────────────────────────────────────────────────────────

/**
 * A conversation's id: its run and the step's durable name (its id, or the loop's node name). The
 * engine's rows carry it in their subject (`converse:<runId>:<key>`), so a reply or an inbox
 * resolution finds it without a lookup.
 */
// DECISION: the id is derived, never stored: a retried step finds the same conversation.
export function conversationId(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`;
}

/** The event that wakes a step waiting on its conversation. */
export function conversationEventType(id: string): string {
  return `conversation:${id}`;
}

/** The conversation id of an engine row's subject (`converse:<runId>:<key>`), or null. */
export function conversationIdOfSubject(subject: string): string | null {
  return subject.startsWith("converse:") ? subject.slice("converse:".length) : null;
}

// ── Into the engine ──────────────────────────────────────────────────────────────────────────

/** Ask our own team with a person step: a conversation is with a contact. */
export const TEAM_WHO = ["operator", "client_admin", "client_user", "lead"] as const;

/** Who the engine talks to: a directory contact (an id) or one of the agent's people roles. */
// DECISION: after templates resolve, a uuid is a contact id and anything else is a role of the
// agent's `people`; a client user is reached in the portal, which is not a conversation channel.
export function conversationTo(withWho: string): ConverseTo {
  const w = withWho.trim();
  return isUuid(w) || hasTemplate(w) ? { contactId: w } : { role: w };
}

const OPENING_RE = /^\s*first message:\s*/i;

/**
 * The goal's own text and its opening. v4 has no `opening` field: a goal paragraph that starts
 * "First message:" is it; otherwise the engine opens with `DEFAULT_OPENING`.
 */
// DECISION: the opening lives in the goal (one fixed text the operator writes) rather than a field
// the schema doesn't have; `conversationFromConverse` writes a v3 opening back the same way.
export function splitGoal(goal: string): { goal: string; opening: string | null } {
  const paragraphs = goal.split(/\n\s*\n/);
  const at = paragraphs.findIndex((p) => OPENING_RE.test(p));
  if (at < 0) return { goal: goal.trim(), opening: null };
  const opening = (paragraphs[at] as string).replace(OPENING_RE, "").trim();
  const rest = paragraphs
    .filter((_, i) => i !== at)
    .join("\n\n")
    .trim();
  return { goal: rest, opening: opening || null };
}

export const DEFAULT_OPENING =
  "Say who you are writing for, then ask for what the goal needs, in one short message.";

/** What may be said, as fixed words added to the goal; the facts themselves go in as data. */
export function shareRule(mayShare: readonly string[]): string {
  return mayShare.length
    ? "You may tell them only the facts under `mayShare` in the record's data. If they ask for anything else, say someone will follow up."
    : "Tell them nothing about the client's records. If they ask, say someone will follow up.";
}

function findLine(find: Record<string, string>): string {
  const fields = findFields(find);
  if (fields.length === 0) return "";
  const words = fields.map((f) => `${f.name}${f.optional ? " (if they know)" : ""}`);
  return `Find out: ${words.join(", ")}.`;
}

/**
 * The engine's limits for a step: at most `maxTurns` messages (the engine's cap, 12), a reply wait
 * of a day or the deadline if shorter, the default spend.
 */
// DECISION: the step's deadline is the executor's (business hours included); the engine's own
// `deadline` is a backstop: the step's for clock time, the engine's cap (14 days) for business
// time. Within it, a limit hands the conversation to a person as §10.12 always has.
export function conversationLimits(step: Pick<ConversationStep, "maxTurns" | "deadline">) {
  const capMs = CONVERSE_CAPS.deadlineMs;
  let deadlineMs = capMs;
  try {
    if (step.deadline.hours === "clock") {
      deadlineMs = Math.min(capMs, parseDuration(step.deadline.after));
    }
  } catch {
    deadlineMs = capMs;
  }
  const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))} minutes`;
  const waitMs = Math.min(parseDuration(CONVERSE_DEFAULTS.waitPerReply), deadlineMs);
  return {
    maxMessages: Math.min(step.maxTurns, CONVERSE_CAPS.maxMessages),
    waitPerReply: minutes(waitMs),
    deadline: minutes(deadlineMs),
    maxCostUsd: CONVERSE_DEFAULTS.maxCostUsd,
  };
}

/**
 * A text conversation step (templates resolved) as the engine's input. The goal (with the share and
 * find lines, fixed words) is instructions; what may be shared goes in as data, so the model has
 * nothing else of the client's to tell (invariant 9). It always asks the person to confirm what it
 * found, as `comms.converse` does by default. Null for a call (`callBrief`).
 */
export function toConverseInput(step: ConversationStep): ConverseInputIn | null {
  const channel = CONVERSATION_CHANNEL_MAP[step.channel].converse;
  if (!channel) return null;
  const { goal, opening } = splitGoal(step.goal);
  const text = [goal, findLine(step.find), shareRule(step.mayShare)].filter(Boolean).join("\n\n");
  return {
    to: conversationTo(step.with),
    channel,
    goal: text.slice(0, 2000),
    result: findResultSchema(step.find),
    confirm: true,
    opening: (opening ?? DEFAULT_OPENING).slice(0, 2000),
    about: [],
    ...(step.mayShare.length ? { data: { mayShare: step.mayShare } } : {}),
    limits: conversationLimits(step),
  };
}

/** What a call needs: the voice agent's settings (`VoiceSettings`) and what to find. */
export interface CallBrief {
  to: ConverseTo;
  /** The voice agent's purpose: the goal plus the gather-or-confirm rule. Fixed text. */
  purpose: string;
  /** Said after the disclosure. */
  firstMessage?: string;
  /** A call gathers or confirms only: no tools, so it can read nothing and change nothing. */
  tools: [];
  maxMinutes: number;
  /** What to find, read from the transcript once the call is over. */
  result: JsonSchema;
  /** The facts it may say: data. */
  mayShare: string[];
  /**
   * Always true: the call opens with core's `openingLine`, which says it is an automated assistant
   * and asks to keep a record before anything else.
   */
  announceRecording: true;
}

export const CALL_RULE =
  "Only gather or confirm information. Never agree to order, pay, book or change anything; say a person will follow up.";

/** A call step (templates resolved) as the voice path's settings. Null for a text channel. */
// DECISION: a call's purpose is capped at the voice settings' 500 characters; `conversationProblems`
// warns the builder before that cuts the goal.
function callPurpose(step: ConversationStep): string {
  const { goal } = splitGoal(step.goal);
  return [goal, findLine(step.find), CALL_RULE, shareRule(step.mayShare)].filter(Boolean).join(" ");
}

export function callBrief(step: ConversationStep): CallBrief | null {
  if (step.channel !== "call") return null;
  const { opening } = splitGoal(step.goal);
  const purpose = callPurpose(step).slice(0, 500);
  return {
    to: conversationTo(step.with),
    purpose,
    ...(opening ? { firstMessage: opening.slice(0, 300) } : {}),
    tools: [],
    maxMinutes: CALL_DEFAULT_MINUTES,
    result: findResultSchema(step.find),
    mayShare: [...step.mayShare],
    announceRecording: true,
  };
}

// ── Problems (one function for the builder, the validator and the runner, invariant 4) ───────

export interface ConversationProblem {
  field: string;
  code: string;
  message: string;
}

/** What the schema can't check about a conversation step as written (templates unresolved). */
export function conversationProblems(step: ConversationStep): ConversationProblem[] {
  const out: ConversationProblem[] = [];
  const add = (field: string, code: string, message: string) => out.push({ field, code, message });
  // §1.23's rule, as for `comms.converse`: the goal becomes instructions, so it is fixed text.
  if (hasTemplate(step.goal)) {
    add("goal", "conversation_goal_template", "write the goal as fixed text, with no {{…}}");
  }
  if (!step.goal.trim()) add("goal", "conversation_goal_empty", "say what the conversation is for");
  if ((TEAM_WHO as readonly string[]).includes(step.with.trim())) {
    add(
      "with",
      "conversation_with_team",
      "a conversation is with a contact or one of the agent's people; ask your team with a person step",
    );
  }
  for (const [name, spec] of Object.entries(step.find)) {
    const r = parseFindField(name, spec);
    if ("problem" in r) add(`find.${name}`, "conversation_find_type", r.problem);
  }
  if (Object.keys(step.find).length > CONVERSE_CAPS.resultFields) {
    add(
      "find",
      "conversation_find_too_many",
      `find at most ${CONVERSE_CAPS.resultFields} things in one conversation`,
    );
  }
  if (step.channel !== "call" && step.maxTurns > CONVERSE_CAPS.maxMessages) {
    add(
      "maxTurns",
      "conversation_too_many_turns",
      `a conversation sends at most ${CONVERSE_CAPS.maxMessages} messages`,
    );
  }
  try {
    if (parseDuration(step.deadline.after) > CONVERSE_CAPS.deadlineMs) {
      add("deadline.after", "conversation_too_long", "a conversation can last at most 14 days");
    }
  } catch {
    // A malformed duration is the schema's to report.
  }
  if (step.channel === "call") {
    if (callPurpose(step).length > 500) {
      add(
        "goal",
        "conversation_call_goal_long",
        "a call's goal must be shorter: about 250 characters",
      );
    }
    const { opening } = splitGoal(step.goal);
    if (opening && opening.length > 300) {
      add(
        "goal",
        "conversation_call_opening_long",
        "a call's first message is at most 300 characters",
      );
    }
  }
  return out;
}

// ── From a v3 `comms.converse` step (an upgrade the operator asks for) ───────────────────────

function sameSchema(a: Record<string, unknown>, b: JsonSchema): boolean {
  const ak = Object.keys(a).filter((k) => k !== "description" && k !== "title");
  const bk = Object.keys(b);
  return ak.length === bk.length && bk.every((k) => a[k] === b[k]);
}

function findTypeOf(schema: unknown): string | null {
  if (!isPlainObject(schema)) return null;
  if (schema.type === "array") {
    const inner = findTypeOf(schema.items);
    return inner && !inner.endsWith("[]") ? `${inner}[]` : null;
  }
  for (const [name, s] of Object.entries(FIND_TYPES)) {
    // `phone` reads like `text`; a plain string is text.
    if (name !== "phone" && sameSchema(schema, s)) return name;
  }
  return null;
}

export interface ConversationUpgrade {
  /** The conversation step's own fields (the caller adds id, name and the rest of the base). */
  step: Omit<ConversationStep, "id" | "name" | "client" | "checks" | "review">;
  /** What didn't carry over, in plain words, for the operator to review. */
  dropped: string[];
}

/**
 * A v3 `comms.converse` input read as a conversation step's fields, for an upgrade the operator
 * asks for and reviews (a new version, never a stored one rewritten: invariant 3). Null when it
 * can't be a conversation at all: a client user in the portal, or an input that doesn't read.
 * `first` is the v3 step's approval requirement.
 */
// DECISION: the opening goes into the goal as a "First message:" paragraph (`splitGoal`); `about`
// ids and `data` templates become `mayShare` (what it may use and tell); a result field with no
// `find` type becomes text; v3's later messages went under the first signature unless the person
// or the stage forced one, so `later` is `within_goal`. Confirm off, a WhatsApp template, the reply
// wait and the spending limit have no place in v4 and are listed in `dropped`.
export function conversationFromConverse(
  input: unknown,
  first: "required" | "not_required" = "required",
): ConversationUpgrade | null {
  if (!isPlainObject(input)) return null;
  const to = isPlainObject(input.to) ? input.to : null;
  if (!to || "userId" in to) return null;
  const withWho =
    typeof to.contactId === "string" ? to.contactId : typeof to.role === "string" ? to.role : null;
  const channel = input.channel;
  if (!withWho || (channel !== "email" && channel !== "sms" && channel !== "whatsapp")) return null;
  if (typeof input.goal !== "string") return null;
  const dropped: string[] = [];
  const goal =
    typeof input.opening === "string" && input.opening.trim()
      ? `${input.goal.trim()}\n\nFirst message: ${input.opening.trim()}`
      : input.goal.trim();

  const find: Record<string, string> = {};
  const result = isPlainObject(input.result) ? input.result : {};
  const props = isPlainObject(result.properties) ? result.properties : {};
  const required = Array.isArray(result.required) ? (result.required as unknown[]) : [];
  for (const [name, schema] of Object.entries(props)) {
    if (!FIELD_RE.test(name)) {
      dropped.push(`result field ${name}`);
      continue;
    }
    let t = findTypeOf(schema);
    if (!t) {
      dropped.push(`the shape of result field ${name} (now text)`);
      t = "text";
    }
    find[name] = required.includes(name) ? t : `${t}?`;
  }

  const mayShare: string[] = [];
  if (Array.isArray(input.about)) {
    for (const a of input.about) if (typeof a === "string") mayShare.push(a);
  }
  if (typeof input.data === "string") mayShare.push(input.data);
  else if (isPlainObject(input.data)) {
    for (const [k, v] of Object.entries(input.data)) {
      if (typeof v === "string") mayShare.push(v);
      else dropped.push(`data.${k}`);
    }
  } else if (input.data !== undefined) dropped.push("data");
  if (mayShare.length > 20) dropped.push("what it may share beyond 20 items");

  if (input.confirm === false) dropped.push("confirm off (a conversation always confirms)");
  if (input.whatsappTemplate !== undefined) dropped.push("the WhatsApp template");
  const limits = isPlainObject(input.limits) ? input.limits : {};
  if (limits.waitPerReply !== undefined && limits.waitPerReply !== CONVERSE_DEFAULTS.waitPerReply) {
    dropped.push("the wait for each reply");
  }
  if (limits.maxCostUsd !== undefined && limits.maxCostUsd !== CONVERSE_DEFAULTS.maxCostUsd) {
    dropped.push("the spending limit");
  }
  const maxMessages =
    typeof limits.maxMessages === "number" ? limits.maxMessages : CONVERSE_DEFAULTS.maxMessages;
  const after = typeof limits.deadline === "string" ? limits.deadline : CONVERSE_DEFAULTS.deadline;

  return {
    step: {
      kind: "conversation",
      with: withWho,
      channel,
      goal,
      mayShare: mayShare.slice(0, 20),
      find,
      maxTurns: Math.max(1, Math.min(20, maxMessages)),
      messages: { first, later: "within_goal" },
      deadline: { after, hours: "clock", ifNoAnswer: "stop" },
    },
    dropped,
  };
}
