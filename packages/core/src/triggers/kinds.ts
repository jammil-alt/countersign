// Triggers, six kinds (ARCHITECTURE §10.1, §10.8; docs/plan.md §1.48): the events the new kinds
// start on, what each puts in `{{trigger.…}}`, their run ids, and the helpers the router, the
// inbound paths and validation share. Pure.

import { z } from "zod";
import { RUN_ID_NAMESPACE, uuidv5 } from "../ids";
import type { JsonSchema } from "../schemas/common";
import type {
  MessageChannel,
  Trigger,
  TriggerOn,
  TriggerRateLimit,
  Workflow,
} from "../schemas/workflow";
import { matchesPeople, type SenderFacts } from "./people";

const Id = z.uuid();

/** What holds triggers: a v3 workflow (`trigger`, `moreTriggers`) or a v4 process (`triggers`). */
export type TriggerHolder =
  | Pick<Workflow, "trigger" | "moreTriggers">
  | { readonly triggers: readonly Trigger[] };

/**
 * Every trigger of a workflow: its first, then `moreTriggers`, each with its own id. R9: a v4
 * process's `triggers` as they are, so a reader of a bundle typed v3 that holds a process (a
 * template's v4 version, or its fork) lists them instead of failing on a missing `trigger`.
 */
export function allTriggers(workflow: TriggerHolder): Trigger[] {
  if ("triggers" in workflow && Array.isArray(workflow.triggers)) return [...workflow.triggers];
  const v3 = workflow as Pick<Workflow, "trigger" | "moreTriggers">;
  return [v3.trigger, ...(v3.moreTriggers ?? [])];
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────

export const INBOUND_MESSAGE_EVENT = "inbound.message";
export const RUN_SUCCEEDED_EVENT = "run.succeeded";
export const ACCOUNT_REQUEST_PASSED_EVENT = "account.request_passed";

/** Channels whose messages come in from outside (email to the agent's address, its numbers). */
export const INBOUND_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const InboundChannel = z.enum(INBOUND_CHANNELS);
export type InboundChannel = z.infer<typeof InboundChannel>;

/**
 * `inbound.message`: something was sent to one agent from outside. Ids only: the text is a raw
 * record read with `inbound.get` (invariants 9 and 12), its attachments are documents.
 */
export const InboundMessagePayload = z.strictObject({
  agentId: Id,
  channel: InboundChannel,
  /** The sender's contact, when the platform knows (and, for email, DMARC proved) who it is. */
  contactId: Id.nullable(),
  userId: Id.nullable(),
  rawRecordId: Id,
  documents: z.array(Id).max(20),
  receivedAt: z.string(),
});
export type InboundMessagePayload = z.infer<typeof InboundMessagePayload>;

/** Most handoffs one chain makes (ARCHITECTURE §10.8). */
export const MAX_HANDOFF_DEPTH = 3;
/** The evaluated `handoff.output`, as JSON, at most 16 KB (docs/plan.md §1.48). */
export const HANDOFF_OUTPUT_MAX_BYTES = 16 * 1024;
export const HANDOFF_SOURCES_MAX = 100;

/** `run.succeeded`: a live run finished well, with what its workflow passes on. */
export const RunSucceededPayload = z.strictObject({
  runId: Id,
  agentId: Id,
  agentSlug: z.string().min(1),
  agentVersionId: Id,
  workflowSlug: z.string().min(1),
  /** The evaluated `handoff.output`; null without one, or when it was over 16 KB. */
  output: z.unknown(),
  /** True when the output was left out for its size. */
  outputTooLarge: z.boolean().optional(),
  sources: z.array(Id).max(HANDOFF_SOURCES_MAX),
  /** How many handoffs the next run would be from the first: the trigger's depth + 1. */
  depth: z.number().int().min(1),
});
export type RunSucceededPayload = z.infer<typeof RunSucceededPayload>;

/**
 * `account.request_passed`: Sloan passed a client's request to an agent (`account.pass_to_agent`,
 * ARCHITECTURE §9.8). The request is the asking person's message in the account thread; the user
 * comes from the thread, never from the model.
 */
export const AccountRequestPassedPayload = z.strictObject({
  agentId: Id,
  threadId: Id,
  messageId: Id,
  userId: Id,
});
export type AccountRequestPassedPayload = z.infer<typeof AccountRequestPassedPayload>;

// ── What `{{trigger.…}}` reads ──────────────────────────────────────────────────────────────────

const OBJ = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const NULLABLE_ID: JsonSchema = { type: ["string", "null"] };
const IDS: JsonSchema = { type: "array", items: { type: "string" } };

/**
 * A message trigger's payload, the same for every channel: who sent it and where the message is.
 * Its words are never here: step 1 reads them with `inbound.get` (invariant 9).
 */
export const MESSAGE_PAYLOAD: JsonSchema = OBJ(
  {
    channel: { type: "string" },
    contactId: NULLABLE_ID,
    userId: NULLABLE_ID,
    /** Email and texts: the stored message. */
    rawRecordId: NULLABLE_ID,
    /** Commands and Sloan: the thread message. */
    threadId: NULLABLE_ID,
    messageId: NULLABLE_ID,
    documents: IDS,
  },
  ["channel", "contactId", "userId", "rawRecordId", "threadId", "messageId", "documents"],
);

export const HANDOFF_PAYLOAD: JsonSchema = OBJ(
  {
    from: OBJ(
      {
        agentId: { type: "string" },
        agentSlug: { type: "string" },
        workflowSlug: { type: "string" },
        runId: { type: "string" },
      },
      ["agentId", "agentSlug", "workflowSlug", "runId"],
    ),
    output: {},
    sources: IDS,
    depth: { type: "integer" },
  },
  ["from", "output", "sources", "depth"],
);

/** A message trigger's run payload. */
export interface MessageRunPayload {
  channel: MessageChannel;
  contactId: string | null;
  userId: string | null;
  rawRecordId: string | null;
  threadId: string | null;
  messageId: string | null;
  documents: string[];
}

/** A handoff trigger's run payload. */
export interface HandoffRunPayload {
  from: { agentId: string; agentSlug: string; workflowSlug: string; runId: string };
  output: unknown;
  sources: string[];
  depth: number;
}

// ── Run ids ──────────────────────────────────────────────────────────────────────────────────────

/** A webhook trigger's run with a `dedupeKey`: the same key twice derives the same run. */
export async function webhookRunId(input: {
  agentId: string;
  workflowSlug: string;
  key: string;
}): Promise<string> {
  return uuidv5(`webhook:${input.agentId}:${input.workflowSlug}:${input.key}`, RUN_ID_NAMESPACE);
}

/** A rate limit's window in seconds. */
export function rateWindowSeconds(limit: TriggerRateLimit): number {
  return limit.per === "minute" ? 60 : limit.per === "hour" ? 3600 : 86_400;
}

// ── Message triggers: who may start them ────────────────────────────────────────────────────────

export interface AcceptingTrigger {
  workflowSlug: string;
  triggerId: string;
  on: Extract<TriggerOn, { type: "message" }>;
}

// Wave 3b: a bundle whose workflows may be v4 processes (`AnyAgentBundle`) reads the same way.
interface BundleLike {
  workflows: readonly {
    slug: string;
    enabled: boolean;
    workflow: TriggerHolder;
  }[];
}

/** The enabled message triggers of a bundle that listen on `channel`. */
export function messageTriggersOn(bundle: BundleLike, channel: MessageChannel): AcceptingTrigger[] {
  const out: AcceptingTrigger[] = [];
  for (const wf of bundle.workflows) {
    if (!wf.enabled) continue;
    for (const t of allTriggers(wf.workflow)) {
      if (t.on.type === "message" && t.on.channels.includes(channel)) {
        out.push({ workflowSlug: wf.slug, triggerId: t.id, on: t.on });
      }
    }
  }
  return out;
}

/** The message triggers on `channel` whose People filter takes this sender. */
export function acceptingTriggers(
  bundle: BundleLike,
  channel: MessageChannel,
  sender: SenderFacts,
): AcceptingTrigger[] {
  return messageTriggersOn(bundle, channel).filter((t) => matchesPeople(t.on.from, sender));
}

/** Whether Sloan may pass requests to this agent (a message trigger with channel `sloan`). */
export function acceptsSloan(bundle: BundleLike): boolean {
  return messageTriggersOn(bundle, "sloan").length > 0;
}

/**
 * The event `account.pass_to_agent` emits (W2-D, Sloan): pass it to the runtime's `emit` in the
 * tool's transaction. The router then starts the agent's message triggers on channel `sloan`
 * whose People filter takes the asking user; check `acceptsSloan` first to answer "can't" plainly.
 */
export function passToAgentEvent(input: AccountRequestPassedPayload): {
  type: typeof ACCOUNT_REQUEST_PASSED_EVENT;
  subjectType: "thread";
  subjectId: string;
  payload: AccountRequestPassedPayload;
} {
  const payload = AccountRequestPassedPayload.parse(input);
  return {
    type: ACCOUNT_REQUEST_PASSED_EVENT,
    subjectType: "thread",
    subjectId: payload.threadId,
    payload,
  };
}

/** `reply.confirm` and the polite reply go out on the channel the message came in on. */
export function repliesOn(channel: MessageChannel): channel is InboundChannel {
  return (INBOUND_CHANNELS as readonly string[]).includes(channel);
}
