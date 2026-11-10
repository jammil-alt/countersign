// R7 (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Conversations as a step"): the `conversation`
// step's runner, the executor's `conversation` port. It is a front door to P-4's engine, not a new
// one: the step becomes the engine's own input (`processes.toConverseInput`), and the engine (apps/
// api's `conversePort`, behind `ConversationEngine`) keeps doing everything it does for
// `comms.converse`: each message a reach-out with every check reach out makes, one open message
// per person, signatures, quiet hours, hand-over on every limit, stepping in, the transcript views.
// A call goes through the voice path, gathering or confirming only; what it found is read from its
// transcript by the same turn the engine uses (`converseFindings`).
//
// The engine's rows are the truth. The runner starts or carries the conversation on, and returns
// `pending` with the event to wait on (`conversation:<id>`) until it ends; the executor waits
// durably, as for a person step, and calls again when woken. Replies stay data (invariant 9): they
// reach the model only in a tool result, and `found` keeps only the step's own fields.

import {
  type ApprovalRequirement,
  ConverseInput as ConverseInputSchema,
  type ConverseLine,
  type ConverseOutcome,
  type ConverseTo,
  processes,
} from "@countersign/core";
import type { RuntimeDeps } from "./context";
import { converseFindings } from "./converse";

// ── The port the executor calls ──────────────────────────────────────────────────────────────

export type ConversationStepStatus = processes.ConversationStatus | "pending";

export interface ConversationStepInput {
  runId: string;
  /** The step's durable name: its id, or the loop's node name inside a `for_each`. */
  stepId: string;
  /** The step with its templates resolved. */
  step: processes.ConversationStep;
  tenantId: string;
  agentVersionId: string;
  mode: "live" | "test";
  // DECISION: two optional fields beyond the shared contract. `stepRunId` lets the engine log its
  // turns on the step (absent: the turns' usage is kept on the run only). `wake` says what woke a
  // waiting step: the payload of its `conversation:<id>` event (an inbox resolution, a reply), the
  // engine's own wake time passing (`timedOut`), or the step's deadline (`deadlinePassed`, after
  // which the conversation ends and `deadline.ifNoAnswer` applies).
  stepRunId?: string | undefined;
  wake?:
    | { payload?: unknown; timedOut?: boolean | undefined; deadlinePassed?: boolean | undefined }
    | undefined;
}

export interface ConversationStepResult {
  status: ConversationStepStatus;
  /** What it found, by the step's `find` fields only: the person's words, data. */
  found: Record<string, unknown>;
  conversationId: string | null;
  /** One plain line for the timeline: never a prompt, a model or a cost (invariant 11). */
  summary: string;
  /** `pending`: the event that wakes the step (`conversation:<id>`). */
  waitFor?: string;
  /** `pending`: wake the step by then even with no event (a reply's own wait), ISO. */
  wakeAt?: string | null;
  /** `pending`: what it waits for, for the timeline. */
  waitingOn?: ConversationWait;
  /** A message wasn't approved, or a person ended the conversation: approval's `onReject`. */
  declined?: true;
  /** The records it rests on: the messages and replies (invariant 10). */
  sources?: string[];
}

/** What the executor's StepRunner gets: `conversation(input)`. */
export interface ConversationPort {
  conversation(input: ConversationStepInput): Promise<ConversationStepResult>;
}

// ── The engine behind it (apps/api) ──────────────────────────────────────────────────────────

export type ConversationWait = "reply" | "signature" | "answer";

/** What the engine is asked to talk about: the engine's own input, or a call's brief. */
export type ConversationTalk =
  | { kind: "text"; input: ConverseInputSchema }
  | { kind: "call"; brief: processes.CallBrief };

export interface ConversationEngineRequest {
  tenantId: string;
  runId: string;
  agentVersionId: string;
  stepRunId?: string | undefined;
  mode: "live" | "test";
  /** The engine's key for its rows (`converse:<runId>:<key>`): the step's durable name. */
  key: string;
  conversationId: string;
  talk: ConversationTalk;
  /**
   * The step's message approvals. `first` is the conversation's plan: `required` unless the
   * operator switched it off, and then only where the gate allows (invariant 8). `later`:
   * `within_goal` sends later messages under the first signature; the person's autonomy and the
   * agent's trial or sign-off stage still force a signature on each, as the engine always has.
   */
  messages: { first: ApprovalRequirement; later: "required" | "within_goal" };
  /** What woke the step, passed through (`ConversationStepInput.wake`), deadline aside. */
  wake?: { payload?: unknown; timedOut?: boolean | undefined } | undefined;
}

/** How a conversation ended, as the engine keeps it (`ConverseOutput`, and a call's). */
export interface ConversationEnded {
  /** The engine's outcomes; `no_answer` for a call nobody picked up. */
  outcome: ConverseOutcome | "no_answer";
  /** The goal's result; a call's is null (it is read here from the transcript). */
  result: unknown;
  confirmed: boolean;
  who: { name: string } | null;
  messages: number;
  replies: number;
  transcript: ConverseLine[];
  sources: string[];
  reason: string | null;
  testRun?: boolean | undefined;
  opening?: string | undefined;
}

export type ConversationProgress =
  | { kind: "ended"; output: ConversationEnded }
  | { kind: "waiting"; on: ConversationWait; wakeAt?: string | null | undefined }
  | { kind: "failed"; error: string };

/**
 * P-4's engine as the runner needs it. apps/api implements it over `conversePort` (text) and the
 * voice path (calls): `advance` starts the conversation if it has no rows yet, else carries it on
 * from them (the truth after any wake, signature or retry); `end` stops it without another
 * message and withdraws anything it waits on.
 */
export interface ConversationEngine {
  advance(req: ConversationEngineRequest): Promise<ConversationProgress>;
  end(req: {
    tenantId: string;
    runId: string;
    key: string;
    conversationId: string;
    reason: string;
  }): Promise<{ output: ConversationEnded; endedNow: boolean } | null>;
}

export interface ConversationRunnerDeps {
  engine: ConversationEngine;
  /** For reading a call's findings: the agent's model, logged on the step. */
  runtime: RuntimeDeps;
}

// ── The runner ───────────────────────────────────────────────────────────────────────────────

const CHANNEL_WORDS: Record<processes.ConversationChannel, string> = {
  email: "email",
  sms: "text",
  whatsapp: "WhatsApp",
  call: "phone",
};

const WAIT_WORDS: Record<ConversationWait, string> = {
  reply: "Waiting for their reply.",
  signature: "Waiting for a signature on the message.",
  answer: "Waiting for a person to take the conversation over.",
};

/** Problems that make a step unrunnable even with its templates resolved. */
const RUNTIME_PROBLEMS = new Set(["conversation_with_team", "conversation_find_type"]);

/** The step as the engine's request: the engine's own input, parsed (invariant 5), or a brief. */
export function talkOf(
  step: processes.ConversationStep,
): { ok: true; talk: ConversationTalk } | { ok: false; error: string } {
  const brief = processes.callBrief(step);
  if (brief) return { ok: true, talk: { kind: "call", brief } };
  const parsed = ConverseInputSchema.safeParse(processes.toConverseInput(step));
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") || "input";
    return { ok: false, error: `the conversation's settings don't fit (${where})` };
  }
  return { ok: true, talk: { kind: "text", input: parsed.data } };
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Runs a conversation step once: starts it, carries it on after a wake, or reads how it ended.
 * Never throws for what the engine reports; a thrown engine error is the executor's to retry.
 */
export async function runConversationStep(
  deps: ConversationRunnerDeps,
  input: ConversationStepInput,
): Promise<ConversationStepResult> {
  const { step } = input;
  const id = processes.conversationId(input.runId, input.stepId);
  const failed = (summary: string): ConversationStepResult => ({
    status: "failed",
    found: {},
    conversationId: id,
    summary,
  });

  const problem = processes.conversationProblems(step).find((p) => RUNTIME_PROBLEMS.has(p.code));
  if (problem) return failed(`The conversation can't start: ${problem.message}.`);
  const talk = talkOf(step);
  if (!talk.ok) return failed(`The conversation can't start: ${talk.error}.`);

  if (input.wake?.deadlinePassed) {
    const ended = await deps.engine.end({
      tenantId: input.tenantId,
      runId: input.runId,
      key: input.stepId,
      conversationId: id,
      reason: "the deadline passed",
    });
    // It had ended on its own before the deadline: that is its result.
    if (ended && !ended.endedNow) return endedResult(deps, input, id, talk.talk, ended.output);
    const found = processes.foundOf(step.find, ended?.output.result);
    return {
      status: "no_answer",
      found,
      conversationId: id,
      summary: `No answer from ${ended?.output.who?.name ?? "them"} by the deadline.`,
      ...(ended ? { sources: ended.output.sources } : {}),
    };
  }

  const progress = await deps.engine.advance({
    tenantId: input.tenantId,
    runId: input.runId,
    agentVersionId: input.agentVersionId,
    stepRunId: input.stepRunId,
    mode: input.mode,
    key: input.stepId,
    conversationId: id,
    talk: talk.talk,
    messages: { first: step.messages.first, later: step.messages.later },
    ...(input.wake ? { wake: { payload: input.wake.payload, timedOut: input.wake.timedOut } } : {}),
  });
  switch (progress.kind) {
    case "failed":
      return failed(`The conversation stopped: ${progress.error}.`);
    case "waiting":
      return {
        status: "pending",
        found: {},
        conversationId: id,
        summary: WAIT_WORDS[progress.on],
        waitFor: processes.conversationEventType(id),
        wakeAt: progress.wakeAt ?? null,
        waitingOn: progress.on,
      };
    case "ended":
      return endedResult(deps, input, id, talk.talk, progress.output);
  }
}

/** How an ended conversation reads as the step's result. */
async function endedResult(
  deps: ConversationRunnerDeps,
  input: ConversationStepInput,
  id: string,
  talk: ConversationTalk,
  out: ConversationEnded,
): Promise<ConversationStepResult> {
  const { step } = input;
  const who = out.who?.name ?? "them";
  const by = CHANNEL_WORDS[step.channel];
  const base = { conversationId: id, sources: out.sources };

  if (out.testRun || input.mode === "test") {
    // Test runs never write (invariant 8): nothing was sent and nothing was found.
    const first = out.opening ? ` The first message would have been: "${out.opening}"` : "";
    return { ...base, status: "done", found: {}, summary: `Test run: nothing was sent.${first}` };
  }

  let result = out.result;
  if (
    talk.kind === "call" &&
    out.outcome === "completed" &&
    (result === null || result === undefined) &&
    out.transcript.some((l) => l.direction === "in")
  ) {
    const read = await converseFindings(deps.runtime, {
      tenantId: input.tenantId,
      runId: input.runId,
      stepRunId: input.stepRunId ?? "",
      agentVersionId: input.agentVersionId,
      key: input.stepId,
      turn: out.messages + out.replies + 1,
      // DECISION: the runner doesn't know the person's language; field values keep their own
      // words whatever it is, and nothing is written to them.
      language: "en",
      goal: talk.brief.purpose,
      result: talk.brief.result,
      data: talk.brief.mayShare.length ? { mayShare: talk.brief.mayShare } : null,
      about: [],
      who: { name: who },
      channel: "call",
      clientName: "the client",
      transcript: out.transcript,
    });
    if (!read.ok) {
      return {
        ...base,
        status: "failed",
        found: {},
        summary: "We couldn't read what the call found.",
      };
    }
    result = read.result;
  }

  const found = processes.foundOf(step.find, result);
  const missing = processes.requiredFindFields(step.find).filter((f) => !(f in found));
  const foundWords = Object.keys(found);
  switch (out.outcome) {
    case "completed":
    case "handed_over": {
      const lead =
        out.outcome === "handed_over"
          ? "A person took the conversation over"
          : `Talked with ${who} by ${by}`;
      if (missing.length === 0 && (foundWords.length > 0 || Object.keys(step.find).length === 0)) {
        const what = foundWords.length ? `: found ${list(foundWords)}` : "";
        return { ...base, status: "done", found, summary: `${lead}${what}.` };
      }
      return {
        ...base,
        status: "not_found",
        found,
        summary: `${lead}, but didn't find ${list(missing.length ? missing : ["what it needed"])}.`,
      };
    }
    case "opted_out":
      return { ...base, status: "not_found", found, summary: `${who} asked not to be contacted.` };
    case "no_answer":
      return { ...base, status: "no_answer", found, summary: `${who} didn't pick up.` };
    case "declined":
      return {
        ...base,
        status: "failed",
        found,
        declined: true,
        summary: "The conversation was turned down before it finished.",
      };
    case "not_allowed":
    case "not_sent":
      // The engine's reasons are its own words (consent, an opt-out, a channel), never theirs.
      return {
        ...base,
        status: "failed",
        found,
        summary: `Nothing could be sent to ${who}${out.reason ? `: ${out.reason}` : ""}.`,
      };
  }
}

/** The executor's `conversation` port over an engine. */
export function conversationRunner(deps: ConversationRunnerDeps): ConversationPort {
  return { conversation: (input) => runConversationStep(deps, input) };
}

/** Who the conversation is with, as the engine reads it (for adapters and views). */
export function talkTo(talk: ConversationTalk): ConverseTo {
  return talk.kind === "call" ? talk.brief.to : talk.input.to;
}
