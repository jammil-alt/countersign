// What the executor needs from the rest of the platform, as interfaces. apps/api wires the real
// ones (packages/agents for skills and actions, the inbox, notifications, step_run logging); tests
// pass fakes. Keeping them injected is what lets the executor run on a fake StepRunner with no
// database and no model.

import {
  type ActionStep,
  type AnomalySignal,
  type Approval,
  type Duration,
  type Locale,
  type ModelChoice,
  type NotifyStep,
  type OwnerCheckEntry,
  type OwnerWatchedStep,
  type PersonStep,
  processes,
  type SkillDefinition,
  type SkillStep,
  type StepKind,
  type ToolSpec,
} from "@countersign/core";
import { z } from "zod";

export type RunMode = "live" | "test";

/** The run being executed: a client agent's pinned version and one of its workflows. */
export interface RunInfo {
  id: string;
  tenantId: string;
  agentId: string;
  agentVersionId: string;
  workflowSlug: string;
  mode: RunMode;
  /**
   * The client's language (docs/plan.md §1.18): summaries and the platform's timeline words are
   * written in it, and skills are asked to write client-facing text in it. Absent: English.
   */
  language?: Locale | undefined;
  // v0.12 W1-E
  /**
   * A retry: the failed run it repeats (ARCHITECTURE §10.10). The agent port carries that run's
   * approved, not-done writes with the same input under their original idempotency keys.
   */
  retryOf?: string | undefined;
  // R3 (docs/plan.md §1.86, §9)
  /**
   * The client's time zone (IANA), for business-hours deadlines when no hours port is wired (the
   * default week, `processes.defaultBusinessHours`). Absent: UTC.
   */
  timeZone?: string | undefined;
}

/** Step-run statuses (packages/db STEP_RUN_STATUSES) the executor writes. */
export type StepRunStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped";

/** A step that is waiting for someone to approve a write it proposed. */
export interface PendingApproval {
  inboxItemId: string;
  /** Whatever the agent port needs to resume (e.g. the external action id). Small JSON. */
  state?: unknown;
  // P-4: conversations (docs/plan.md §1.66)
  /** What the person is asked for: a signature (default), or an answer (a hand-over). */
  waitingFor?: "approval" | "answer";
  // R3 (docs/plan.md §1.86): a write that went ahead on `ifNoAnswer: proceed` names its action.
  /** The proposed external action the item signs, when the port knows it (`external_action.id`). */
  actionId?: string;
}

/** What a skill or action step came to. Small JSON: it is stored as a durable step result. */
export type StepOutcome =
  | {
      kind: "done";
      output: unknown;
      /**
       * A test run's write, recorded as proposed and never made (ARCHITECTURE §10.4): the timeline
       * says what would have been done, not what was. Only honoured in a test run.
       */
      notWritten?: boolean;
      /**
       * With `notWritten`: `output` is the tool's stand-in for what the write would have returned
       * (docs/plan.md §1.94), so later steps run on it; the timeline says so.
       */
      standIn?: boolean;
      costUsd?: string;
      tokensIn?: number;
      tokensOut?: number;
      // P-6: a person ended the step outside an approval (docs/plan.md §1.68)
      /**
       * A person turned the step down while it waited on something other than an approval (they
       * ended a live conversation): the step's `onReject` applies, as for a rejected write.
       */
      declined?: boolean;
    }
  /**
   * A write needs approval: the port has already created the inbox item (and the proposed
   * external action) and the executor waits on the item. `output` is what a test run reports
   * instead ("would have done").
   */
  | { kind: "approval"; pending: PendingApproval; output?: unknown }
  /**
   * The step waits for something outside the run (a reach-out's reply, docs/plan.md §1.25): the
   * executor waits for `eventType` or `timeout`, then asks the port (`afterWait`) what came of it.
   * The port's own record is the truth; the event only wakes the run.
   */
  | { kind: "waiting"; wait: StepWait; output?: unknown }
  /** A budget was hit: the port created an inbox item for the operator. */
  | { kind: "escalated"; reason: string; inboxItemId?: string }
  | { kind: "failed"; error: string };

/** What a waiting step waits for. Small JSON: it is stored as a durable step result. */
export interface StepWait {
  eventType: string;
  timeout: Duration;
  /** Whatever the port needs to look it up again (e.g. the reach-out's id). */
  state?: unknown;
  /** What it waits for, for the timeline: a reply (default) or a person's release code. */
  reason?: "reply" | "release";
}

export interface WaitRequest {
  run: RunInfo;
  step: SkillStep | ActionStep;
  nodeId: string;
  stepRunId: string;
  wait: StepWait;
  // v0.13 W2-I: as on the step's request, for a step that runs again once its wait is over.
  keyNode?: string;
  /**
   * Skill model (2026-11-10, review): as on the action's request (`ActionStepRequest.binding`), so
   * a message action that runs again after its wait still goes through its resolved channel.
   */
  binding?: { connector: string; connectionId: string };
}

export interface SkillStepRequest {
  run: RunInfo;
  step: SkillStep;
  /** The step's durable name: its id, or `${forEachId}:${index}:${childId}` inside a loop. */
  nodeId: string;
  stepRunId: string;
  /** The step's input with templates resolved. */
  input: unknown;
  /** The step's approval, or the default (required) when it has none. */
  approval: Approval;
  // v0.12 W2-B
  /**
   * Inside a use step: the automation (`slug@version`). Its skill steps run as the using agent
   * though the agent doesn't list their skills: using an automation brings them in (§10.7).
   */
  automation?: string;
  // v0.13 W2-I
  /**
   * The step part of its external actions' idempotency keys, when not `nodeId`: a retry with a
   * corrected input (run oversight) uses `${nodeId}:o${seq}`, so the gate decides it afresh.
   */
  keyNode?: string;
  // R3 (docs/plan.md §1.86): a v4 skill step's customization of its Library skill.
  /**
   * What the step changes about its skill (`processes.customizeSkill`): the runtime applies the
   * added instructions and rule rows. The executor has already checked it against the catalog's
   * definition, layered the step's and the customization's settings into `step.settings`
   * (`processes.stepSkillSettings`; the skill's defaults and the agent's own settings for the skill
   * stay the runtime's, beneath them), put its model in `step.model` when the step names none, and
   * keeps only the customized output's fields. Sent only to a port that `appliesCustomization`.
   */
  customize?: processes.SkillCustomization;
  /**
   * Reshape data (2026-11-11): a `data.reshape` step's mapping (`processes.ReshapeMapping`), which
   * the runtime runs on `input`, deterministically. Sent only for that skill's steps.
   */
  reshape?: processes.ReshapeMapping;
}

export interface ActionStepRequest {
  run: RunInfo;
  step: ActionStep;
  nodeId: string;
  stepRunId: string;
  input: unknown;
  approval: Approval;
  // Skill model (2026-11-10)
  /**
   * An action write step's channel connection (`ResolvedAction.connectionId`): the tool's call
   * goes through it, as the agent's binding for `connector`. Absent: the agent's own bindings.
   */
  binding?: { connector: string; connectionId: string };
  // v0.12 W2-B
  automation?: string;
  // v0.13 W2-I
  keyNode?: string;
}

// Skill model (2026-11-10): action write steps.
/** An action write step to resolve for the run's agent (`AgentPort.resolveAction`). */
export interface ResolveActionRequest {
  run: RunInfo;
  /** The step's durable name. */
  nodeId: string;
  action: processes.WriteAction;
  /** The connector the step pins (accounting actions only). */
  via?: string;
}

/**
 * The tool an action runs with for this agent: `processes.actionTool(action, connector)`. Small
 * JSON: it is stored as a durable step result. `refused`: it doesn't resolve (nothing written).
 */
export type ResolvedAction =
  | {
      tool: string;
      connector: string;
      /**
       * The connection a message action's channel resolved to (the agent's own, else the
       * account's), which the call goes through even when the agent isn't bound to it.
       */
      connectionId?: string;
    }
  | { refused: string };

export interface ResumeRequest {
  run: RunInfo;
  step: SkillStep | ActionStep;
  nodeId: string;
  stepRunId: string;
  pending: PendingApproval;
  resolution: InboxResolution;
}

/**
 * Runs skill and action steps (packages/agents' runtime behind it). It owns the permission gate,
 * external actions and their idempotency keys (built from `run.id` and `nodeId`). In a test run
 * (`run.mode === 'test'`) it must never execute an external action.
 */
export interface AgentPort {
  runSkill(request: SkillStepRequest): Promise<StepOutcome>;
  runAction(request: ActionStepRequest): Promise<StepOutcome>;
  /**
   * After the approval for `pending` was resolved: execute the write once (approved) or mark it
   * rejected. May ask for another approval (an agent-mode skill that writes again).
   */
  resume(request: ResumeRequest): Promise<StepOutcome>;
  /**
   * Check-before-wait for a `waiting` outcome: whether what it waits for has already happened (its
   * event may have been sent before the run began waiting). Ports that never wait leave it out.
   */
  waitDone?(request: WaitRequest): Promise<boolean>;
  /** After the wait (its event, or the timeout): what the step came to, or a further wait. */
  afterWait?(request: WaitRequest & { timedOut: boolean }): Promise<StepOutcome>;
  // R3 (docs/plan.md §1.86): approval modes and escalation on a write.
  /**
   * Asks one more person to sign the write `pending` waits on: another approval item for the same
   * proposed external action (the next approver `in_turn`, every approver at once for `any` and
   * `all`, or the person an unanswered approval escalates to). Resolving it signs the action as
   * the gate's own item does. Idempotent per `nodeId`. Ports without it ask only the approver the
   * gate asked: further approvers and escalations are not asked, and the approval's `ifNoAnswer`
   * applies when that one doesn't answer.
   */
  askApprover?(request: AskApproverRequest): Promise<{ inboxItemId: string }>;
  /**
   * Wave 5 review (docs/plan.md §1.86 "Forks (wave 5)"): whether any write the step under
   * `nodeId` proposed in this run was made, or may have been (its `external_action` done,
   * executing, or failed without the runtime's `notWritten`). A step that failed goes on past its
   * failure (`onError: continue`) only when this says none. Ports without it: only a failure whose
   * error says the write may have happened ends the run (`processes.writeMayHaveHappened`).
   */
  stepWrites?(request: { run: RunInfo; nodeId: string }): Promise<boolean>;
  /**
   * The port applies `SkillStepRequest.customize`: the added instructions and rule rows reach the
   * skill's run. Without it, a step that adds either fails before it runs: it would otherwise run
   * without them, silently.
   */
  appliesCustomization?: boolean;
  /**
   * Keeps the lead's answer to a skill's help request that carries `remember` (a browsing skill's,
   * docs/plan.md §1.86) where the next run of that skill gets it back as data: the platform's own
   * note, which the model's memory never reaches. Throws when it wasn't kept. Ports without it:
   * the answer is kept as an ordinary memory note (`memory.write`), never read back as an answer.
   */
  keepHelp?(request: KeepHelpRequest): Promise<void>;
  /**
   * Skill model (2026-11-10): the tool an action write step runs with for the run's agent: its
   * bound accounting connection (or `via`), or its email or text channel (its own, else the
   * account's). Called once per step in a durable step. Ports without it fail action steps.
   */
  resolveAction?(request: ResolveActionRequest): Promise<ResolvedAction>;
}

/** The lead's answer to a help request, to keep (`AgentPort.keepHelp`). */
export interface KeepHelpRequest {
  run: RunInfo;
  /** The step's row, where the write is logged. */
  stepRunId: string;
  /** Durable name of this keep (`${step}:help:memory`). */
  nodeId: string;
  /** `NeedsHelp.remember`: the request's tag. */
  remember: string;
  question: string;
  answer: string;
}

/** One more approver for a write that waits (`AgentPort.askApprover`). */
export interface AskApproverRequest {
  run: RunInfo;
  step: SkillStep | ActionStep;
  /** Durable name of this ask (`${step}:approval:<n>:a<k>` or `…:esc<d>`): its idempotency key. */
  nodeId: string;
  stepRunId: string;
  /** The write it signs: the gate's pending approval. */
  pending: PendingApproval;
  /** Who is asked: a role, a user id or a contact id. */
  who: string;
  /** When the asking ends (ISO instant). */
  dueAt: string;
  /** When to remind them (ISO instants), from the approver's deadline. */
  remindAt?: string[];
}

/** How an inbox item was resolved: the payload of its event and of `POST /api/inbox/:id/resolve`. */
export const InboxResolution = z.object({
  approved: z.boolean().nullable().default(null),
  answer: z.unknown().optional(),
  /** The user who resolved it. */
  by: z.string().nullable().default(null),
  // P-6: an item withdrawn when a person took a conversation over (docs/plan.md §1.68)
  /**
   * Not a decision: the item was withdrawn (its conversation was taken over), so it is neither an
   * approval nor a rejection. The port says what comes next; nothing is written on it.
   */
  withdrawn: z.boolean().optional(),
  // R3 (docs/plan.md §1.86)
  /**
   * Nobody answered and the approval's `ifNoAnswer` is `proceed`: the executor goes on as if
   * approved. Set only by the executor, never by a person, on a write the validator let proceed
   * (invariant 8); the port signs the action as approved by its deadline.
   */
  proceeded: z.boolean().optional(),
});
export type InboxResolution = z.infer<typeof InboxResolution>;

export interface CreatePersonItem {
  run: RunInfo;
  step: PersonStep;
  nodeId: string;
  stepRunId: string;
  /** `approval` for mode approve, `request` for mode ask. */
  kind: "approval" | "request";
  title: string;
  payload: unknown;
  /** When the step times out (ISO instant). */
  dueAt: string;
  // R3 (docs/plan.md §1.86): the deadline's reminders, on the asked person's clock.
  /** When to remind the person (ISO instants), from the deadline's `remind`. */
  remindAt?: string[];
}

export interface InboxPort {
  /** Creates the item for a person step, with `run_id`; returns its id. Idempotent per nodeId. */
  createForPerson(item: CreatePersonItem): Promise<{ id: string }>;
  /** Null while open. Called before waiting, in case it was resolved before the wait began. */
  resolution(inboxItemId: string): Promise<InboxResolution | null>;
  /** The step gave up waiting: mark the item expired. */
  expire(inboxItemId: string): Promise<void>;
  /**
   * The run has taken the item's resolution (from its event or the check before waiting), so
   * nothing needs to re-send it (docs/plan.md §1.5 "Approval resume"). Idempotent.
   */
  received(inboxItemId: string): Promise<void>;
}

export interface NotifyPort {
  /**
   * A notify step (rendered). Never called for a test run: the executor records the text on the
   * step and sends nothing (ARCHITECTURE §10.4).
   */
  send(message: {
    run: RunInfo;
    step: NotifyStep;
    nodeId: string;
    channel: NotifyStep["channel"];
    to: string | null;
    text: string;
    /** The step's `sources`, resolved: record ids, deduplicated (invariant 10). */
    sources: string[];
  }): Promise<void>;
  /** A person step timed out with `onTimeout: 'notify_operator'`. */
  notifyOperator(notice: {
    run: RunInfo;
    nodeId: string;
    inboxItemId: string;
    reason: string;
  }): Promise<void>;
  // R3 (docs/plan.md §1.86): v4 notifications (notify steps and checks) and deadlines' `tell`.
  /**
   * A v4 notification to the client's team or ours (`processes.NotifyCheck`), rendered. Urgent
   * ones go at once whatever the hours (by text too) and return the item a "Seen" resolves.
   * Never called for a test run. Ports without it get each recipient through `send` (an inbox
   * notice as a thread message), and an urgent one is not waited on.
   */
  notify?(message: V4Notice): Promise<{ ackItemId?: string | null }>;
  /**
   * A deadline passed: its `tell` people are told, whatever `ifNoAnswer` does. Ports without it
   * tell only `operator` (through `notifyOperator`).
   */
  tell?(notice: {
    run: RunInfo;
    nodeId: string;
    to: string[];
    inboxItemId: string | null;
    reason: string;
  }): Promise<void>;
}

/** A v4 notification, rendered (`NotifyPort.notify`). */
export interface V4Notice {
  run: RunInfo;
  nodeId: string;
  to: string[];
  channel: "inbox" | "email" | "sms";
  text: string;
  /** Resolved record ids, deduplicated (invariant 10). */
  sources: string[];
  /** Urgent: sent at once, by text too; a "Seen" is due by `dueAt` (ISO instant). */
  urgent?: { dueAt: string };
}

export interface StepRunStart {
  runId: string;
  nodeId: string;
  /**
   * A v3 step's kind (a converted step keeps its stored kind); R3: a v4 step's kind, or `confer`
   * for one reviewer's check of a step (`${step}:confer:<n>`).
   */
  nodeType: StepKind | processes.StepKind | "confer";
  skillRef?: string;
  input?: unknown;
  // v0.13 W2-I
  /**
   * A run oversight retry's attempt (2, 3…): the step keeps its one row, whose `attempts` rises to
   * this and whose `input` becomes the attempt's (ARCHITECTURE §5.6). Absent: the first attempt.
   */
  attempt?: number;
  // v0.14 W4-B
  /**
   * The platform retried the step's work (a durable step's try after the first): the step's row
   * counts one more attempt. Absent: the first try, or a call that only finds the row.
   */
  retried?: boolean;
}

export interface StepRunUpdate {
  status: StepRunStatus;
  output?: unknown;
  /** The client timeline line (ARCHITECTURE §10.6). */
  summary?: string | null;
  error?: string;
  costUsd?: string;
  tokensIn?: number;
  tokensOut?: number;
  // R3 (docs/plan.md §1.86): the late-answer path (R5) reads these.
  /** The write went ahead on its approval's `ifNoAnswer: proceed`, nobody having answered. */
  proceededWithoutAnswer?: boolean;
  /** That write's external action, when the port named it (`PendingApproval.actionId`). */
  externalActionId?: string;
}

/** Writes `step_run` rows. Both calls may repeat on a retry, so they must be idempotent. */
export interface StepLog {
  /** Creates the row (or returns the existing one for this run and nodeId); returns its id. */
  start(entry: StepRunStart): Promise<string>;
  update(stepRunId: string, update: StepRunUpdate): Promise<void>;
}

/** Skill and tool definitions, for the summary templates (ARCHITECTURE §10.6). */
export interface StepCatalog {
  skills?: Record<string, SkillDefinition>;
  tools?: Record<string, ToolSpec>;
}

// ── v0.13 W2-I: run oversight (ARCHITECTURE §10.11; docs/plan.md §1.54) ─────────────────────────

/** A step for the run's own agent (its owner, R6) to review. */
export interface OversightRequest {
  run: RunInfo;
  /**
   * The step as stored: a v3 skill or action (a converted step's stored v3 step, as before), or
   * R6: a native v4 read, skill, write or conversation step.
   */
  step: OwnerWatchedStep;
  /** The step's durable name. */
  nodeId: string;
  stepRunId: string;
  /** 1.. per node: the review's place in the step's interventions. */
  seq: number;
  /** A failed step, or (M32) one that succeeded and is reviewed before the run goes on. */
  cause: "failed" | "checkpoint";
  /** The input the attempt ran with (resolved, or the corrected one). */
  input: unknown;
  /** A failure: the step's error, as it would fail the run. A checkpoint: "". */
  error: string;
  /** A failure: `<tool id or step kind>:<code>` (ARCHITECTURE §10.10). A checkpoint: "". */
  errorKey: string;
  /** M32: a checkpoint's output, as the steps after it would see it. */
  output?: unknown;
  /** Attempts so far, the last one included. */
  attempts: number;
  /** Inside a use step: the automation (`slug@version`) the step comes from. */
  automation?: string;
  // R6: the owner's cheap watch (core `anomalySignals`), v4 processes only.
  /** A checkpoint review the watch asked for: why (an empty result, an outlier total, a "no"). */
  signals?: readonly AnomalySignal[];
}

/**
 * What the executor does with a review. `none`: no intervention (review off for this run, a limit
 * reached, an answer that failed validation, a review that failed): the step fails exactly as it
 * would without oversight. Every other verdict is a recorded decision; `note` is its diagnosis,
 * operator only (it rides on `run.failed`, never the portal).
 */
export type OversightVerdict =
  | { action: "none"; reason: string }
  | { action: "retry"; after: Duration; note: string }
  | { action: "retry_with"; input: unknown; note: string }
  /** The port created the inbox item; the run waits on it. */
  | { action: "ask"; inboxItemId: string; note: string }
  | { action: "stop"; note: string }
  /** After a checkpoint (M32). */
  | { action: "continue"; note: string };

/**
 * The run's own agent, overseeing it (packages/agents' `overseeStep` behind it, one model call). The
 * port records the decision (`oversight_decision`), creates any ask or proposal item, enforces the
 * cost limit and the write check (a write that reached the client's tool is never retried). The
 * executor applies the verdict; it never calls a model. Called inside a durable step, so a
 * replayed run reuses the verdict; the port also finds a decision already recorded for (run, node,
 * seq) and returns it without a second model call.
 */
export interface OversightPort {
  review(request: OversightRequest): Promise<OversightVerdict>;
}

// ── M61: the agent chooses (ARCHITECTURE v0.17 §10.14; docs/plan.md §1.97) ────────────────────

/** One path an agent may choose: its id, its name and when to take it (the operator's words). */
export interface ChoicePath {
  id: string;
  name: string;
  describe: string;
}

/** An `if` the agent decides, among the paths its rules allow (two or more). */
export interface ChoiceRequest {
  run: RunInfo;
  /** The if's durable name: the call's label and the decision's node. */
  nodeId: string;
  stepRunId: string;
  stepId: string;
  stepName: string;
  paths: ChoicePath[];
  /** What the agent reads (the step's `show`, else the trigger and the outputs in scope): data. */
  data: unknown;
}

/** A repeat's check after a pass, when the agent says whether it is done. */
export interface JudgeRequest {
  run: RunInfo;
  /** The repeat's durable name; the decision's `seq` is the pass. */
  nodeId: string;
  stepRunId: string;
  stepId: string;
  stepName: string;
  pass: number;
  maxTimes: number;
  /** The operator's goal, fixed text: the instruction side (invariant 9). */
  goal: string;
  /** The pass's outputs (or the step's `show`): data. */
  data: unknown;
}

/**
 * Where the agent chooses. Each answer is recorded by the port (an `oversight_decision` row) and
 * returned once; the executor calls it inside a durable step, so a replay never asks again.
 */
export interface ChoicePort {
  /** A path id the request allowed, or null when unsure (or no answer held). */
  choose(request: ChoiceRequest): Promise<{ path: string | null; by: string }>;
  /** Done or not, or null when no answer held (the repeat ends at its limit). */
  judge(request: JudgeRequest): Promise<{ done: boolean | null; feedback?: string; by: string }>;
}

// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the owner's check on every step, recorded.
/**
 * Where the owner's check on each attempt at a v4 read, skill or write step is kept (`owner_check`,
 * with the decision a review led to). Called inside a durable step of its own after the attempt
 * (and its review), so a replay reuses it; inside a for each, once for the whole loop's checks
 * (`recordMany`, else `record` for each). The store keeps one row per run, node and attempt, so a
 * repeat is a no-op. Absent: nothing is recorded and the run has exactly the durable steps it had.
 */
export interface OwnerCheckLog {
  record(entry: OwnerCheckEntry): Promise<void>;
  /** A loop's checks at once (one transaction); absent: `record` for each. */
  recordMany?(entries: readonly OwnerCheckEntry[]): Promise<void>;
}

// ── R3: the process model's ports (ARCHITECTURE §10.14; docs/plan.md §1.86, §9) ─────────────────

/** What a conversation step came to (`ConversationPort.conversation`). */
export interface ConversationResult {
  /**
   * `pending`: the conversation is under way; the executor waits for `waitFor` (or the step's
   * deadline, or `wakeAt`), then asks the port again with what woke it. The rest are final:
   * `no_answer` takes the step's `deadline.ifNoAnswer`, `declined` its `checks.approval.onReject`.
   */
  status: "done" | "not_found" | "no_answer" | "failed" | "pending";
  /** What it found out, by the step's `find` fields: the person's words, data only. */
  found: Record<string, unknown>;
  conversationId: string | null;
  /** One plain line for the client's timeline. */
  summary: string;
  /** `pending`: the event that wakes the step, `processes.conversationEventType(id)`. */
  waitFor?: string;
  /** `pending`: wake the step by then even with no event (a reply's own wait), ISO; null: none. */
  wakeAt?: string | null;
  /** `pending`: what it waits for, for the timeline. */
  waitingOn?: "reply" | "signature" | "answer";
  /** A message wasn't approved, or a person ended it: `checks.approval.onReject` applies. */
  declined?: true;
  /** The records it rests on: its messages and replies (invariant 10). */
  sources?: string[];
}

export interface ConversationRequest {
  runId: string;
  /** The step's durable name: its id, or the loop's node name inside a `for_each`. */
  stepId: string;
  /** The step with `with` resolved (its goal is fixed text, invariant 9). */
  step: processes.ConversationStep;
  tenantId: string;
  agentVersionId: string;
  mode: RunMode;
  /** The step's row, so the engine logs its turns on it. */
  stepRunId?: string;
  /**
   * What woke a waiting step: its event's payload (an inbox resolution, a reply), `wakeAt`
   * passing (`timedOut`), or the step's deadline (`deadlinePassed`: the port ends the
   * conversation and answers `no_answer` unless it had already ended). Absent: the first call,
   * or a check before waiting.
   */
  wake?: { payload?: unknown; timedOut?: boolean; deadlinePassed?: boolean };
}

/**
 * Conversation steps (packages/agents `conversationRunner`; R7). Idempotent per (runId, stepId):
 * a second call returns the conversation's current state, so the executor calls it again after
 * each wake to learn what came of it (the port's record is the truth).
 */
export interface ConversationPort {
  conversation(input: ConversationRequest): Promise<ConversationResult>;
}

// DECISION (R3): a conversation that is under way returns `pending` with its id and the executor
// waits durably on its event (as person steps wait on their inbox item), rather than the port
// blocking: a conversation can take days.
/**
 * The event type a run waits on for one conversation; the service sends it when it moves on.
 * Core's (`processes.conversationEventType`): letters, digits, `-` and `_` only.
 */
export const conversationEventType = processes.conversationEventType;

/** Whose hours a deadline runs on (`HoursPort.hoursFor`). */
export interface HoursAnswer {
  client: processes.BusinessHours;
  /** The person asked, when `who` is one person. */
  person?: processes.PersonHours;
  /** The people of a role, when `who` is a role: the clock runs while any one is working. */
  people?: processes.Schedule[];
}

/** Stored business hours and away dates (apps/api implements it from settings; R4). */
export interface HoursPort {
  hoursFor(input: { tenantId: string; who: string }): Promise<HoursAnswer>;
}

/** One AI reviewer's check of a step (`ConferPort.ai`). */
export interface ConferAiRequest {
  run: RunInfo;
  /** The reviewer's durable name, `${step}:confer:<n>`. */
  nodeId: string;
  stepRunId: string;
  /** The step's own id and name, for the record. */
  stepId: string;
  stepName: string;
  /**
   * The reviewer's fixed focus, as written in the step ("do these lines add up to the bill's
   * total"): the instruction side. Never rendered with run data (invariant 9).
   */
  focus: string;
  /**
   * The values the focus's `{{…}}` references stand for, by reference (`steps.get.output.total`),
   * resolved in the run: data, never instructions. The port puts them in the data part of its
   * request, with `input` and `output`. Absent when the focus references nothing (the validator
   * holds it to fixed text, so a stored one normally doesn't).
   */
  references?: Record<string, unknown>;
  /** The reviewer's model; absent: a model other than the step's (`stepModel`). */
  model?: ModelChoice;
  stepModel?: ModelChoice;
  /** The step's input and, for a read or a skill, its output: data, never instructions. */
  input: unknown;
  output?: unknown;
}

export interface ConferAiAnswer {
  verdict: "agree" | "disagree" | "unsure";
  /** Its reasons, in a sentence or two. */
  note: string;
}

/** AI reviewers (packages/agents: one model call with the focus fixed and the step as data). */
export interface ConferPort {
  ai(request: ConferAiRequest): Promise<ConferAiAnswer>;
}

/**
 * A skill that couldn't do its work (a browsing skill that didn't find it within its limits) says
 * so in its output, and the executor asks the lead (docs/plan.md §1.86).
 */
export const NeedsHelp = z.object({
  question: z.string().min(1),
  tried: z.array(z.string()).default([]),
  /** Evidence screenshots: storage keys on the connection's log (the browse stream's scope). */
  screenshots: z.array(z.string()).optional(),
  /** The tag the lead's answer is kept under (`[browse-help skill=… sites=…]`). */
  remember: z.string().min(1).max(500).optional(),
  /**
   * Who is asked: the lead (absent), or the operator for work only we can do (a recorded script
   * to record again). Read only from a tool step's output, which our code writes, never a skill's.
   */
  to: z.enum(["lead", "operator"]).optional(),
  /** False when the answer isn't kept as a note (it changes nothing about how to do the work). */
  keep: z.boolean().optional(),
});
export type NeedsHelp = z.infer<typeof NeedsHelp>;

// ── Hand off (owner, 2026-11-11; docs/plan.md §1.96) ─────────────────────────────────────────

/** A hand-off step's ask: start `to.agent`'s live version at `to.step` with `input`. */
export interface HandoffRequest {
  run: RunInfo;
  /** The hand-off step's durable name. */
  nodeId: string;
  to: { agent: string; step: string };
  input: unknown;
}

/** What people call the target and its entry step ("Price checker", "5 · Itemize the invoice"). */
export interface HandoffNames {
  name: string;
  at: string;
}

/**
 * Starts the run a hand-off step asks for (apps/api, with the router's `handoffRunRequest`), or in
 * a test run only names the target: a test run starts nothing. Starting another agent's run is
 * internal, never a write to a client's tool; the run started applies its own approvals.
 */
export interface HandoffPort {
  /** Names the target for a test run's "would hand off" line; starts nothing. */
  names(request: HandoffRequest): Promise<HandoffNames>;
  /** Starts the run; idempotent per (run, nodeId). A refusal says why in plain words. */
  start(
    request: HandoffRequest,
  ): Promise<
    | (HandoffNames & { runId: string })
    | (Partial<HandoffNames> & { refused: string; notStarted?: boolean })
  >;
}
