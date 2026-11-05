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
}

export interface ActionStepRequest {
  run: RunInfo;
  step: ActionStep;
  nodeId: string;
  stepRunId: string;
  input: unknown;
  approval: Approval;
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
  /** A notify step (rendered). In a test run the port must not message the client. */
  send(message: {
    run: RunInfo;
    step: NotifyStep;
    nodeId: string;
    channel: NotifyStep["channel"];
    to: string | null;
    text: string;
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
