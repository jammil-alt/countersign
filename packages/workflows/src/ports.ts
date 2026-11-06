// What the executor needs from the rest of the platform, as interfaces. apps/api wires the real
// ones (packages/agents for skills and actions, the inbox, notifications, step_run logging); tests
// pass fakes. Keeping them injected is what lets the executor run on a fake StepRunner with no
// database and no model.

import type {
  ActionStep,
  Approval,
  Duration,
  Locale,
  NotifyStep,
  PersonStep,
  SkillDefinition,
  SkillStep,
  StepKind,
  ToolSpec,
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
}

/** Step-run statuses (packages/db STEP_RUN_STATUSES) the executor writes. */
export type StepRunStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped";

/** A step that is waiting for someone to approve a write it proposed. */
export interface PendingApproval {
  inboxItemId: string;
  /** Whatever the agent port needs to resume (e.g. the external action id). Small JSON. */
  state?: unknown;
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
      costUsd?: string;
      tokensIn?: number;
      tokensOut?: number;
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
}

export interface ActionStepRequest {
  run: RunInfo;
  step: ActionStep;
  nodeId: string;
  stepRunId: string;
  input: unknown;
  approval: Approval;
  // v0.12 W2-B
  automation?: string;
  // v0.13 W2-I
  keyNode?: string;
}

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
}

/** How an inbox item was resolved: the payload of its event and of `POST /api/inbox/:id/resolve`. */
export const InboxResolution = z.object({
  approved: z.boolean().nullable().default(null),
  answer: z.unknown().optional(),
  /** The user who resolved it. */
  by: z.string().nullable().default(null),
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
}

export interface StepRunStart {
  runId: string;
  nodeId: string;
  nodeType: StepKind;
  skillRef?: string;
  input?: unknown;
  // v0.13 W2-I
  /**
   * A run oversight retry's attempt (2, 3…): the step keeps its one row, whose `attempts` rises to
   * this and whose `input` becomes the attempt's (ARCHITECTURE §5.6). Absent: the first attempt.
   */
  attempt?: number;
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

/** A step for the run's own agent to review. */
export interface OversightRequest {
  run: RunInfo;
  step: SkillStep | ActionStep;
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
