// What the runtime needs from storage, as interfaces. The runtime itself never imports the database
// (CLAUDE.md invariant 2): src/registry/ implements the reads and src/log/ the writes
// (`createDbPorts`), and tests may pass in-memory ones. Every method names its client: each call is
// one short transaction scoped to that client (withTenant), never held across a model call.

import type { ConnectionRef } from "@countersign/connectors";
import type { AgentBundle, JsonObject } from "@countersign/core";
import type { ResolvedSkill } from "../registry/skills";
import type { PlatformStore, RunMode } from "../tools/types";

export interface PinnedAgent {
  agentId: string;
  agentVersionId: string;
  tenantId: string;
  slug: string;
  version: number;
  bundle: AgentBundle;
  /** connector id → connection id. */
  bindings: Record<string, string>;
  /** The client agent's approver override (null: the client's setting). */
  approver: "client_admin" | "operator" | null;
}

export interface MemoryNoteRecord {
  id: string;
  note: string;
  scope: string;
  createdAt: Date;
}

/** Reads (src/registry/runtime-store.ts). */
export interface RuntimeStore {
  /** A client agent's version, as pinned by the run. Templates are never loaded for a run. */
  loadAgentVersion(tenantId: string, agentVersionId: string): Promise<PinnedAgent>;
  /** A `custom:` skill reference, resolved for this client. Built-ins come from the catalog. */
  resolveCustomSkill(tenantId: string, ref: string): Promise<ResolvedSkill | null>;
  /** The client agent's live memory notes (never another agent's or client's; no test notes). */
  memoryNotes(tenantId: string, agentId: string, limit: number): Promise<MemoryNoteRecord[]>;
  connection(tenantId: string, connectionId: string): Promise<ConnectionRef | null>;
  /** `tenant.settings.approvals.external_actions`. */
  clientApprover(tenantId: string): Promise<string | null>;
  run(tenantId: string, runId: string): Promise<{ mode: RunMode; agentId: string } | null>;
}

export type StepStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type ToolCallStatus = "running" | "succeeded" | "failed" | "refused" | "awaiting_approval";

export interface UsageDelta {
  costUsd: string;
  tokensIn: number;
  tokensOut: number;
}

/** Writes about what ran (src/log/run-log.ts). */
export interface RunLog {
  startStepRun(
    tenantId: string,
    input: {
      runId: string;
      nodeId: string;
      nodeType: string;
      skillRef: string | null;
      agentVersionId: string;
      input: unknown;
    },
  ): Promise<string>;
  finishStepRun(
    tenantId: string,
    stepRunId: string,
    result: { status: StepStatus; output?: unknown; summary?: string | null; error?: unknown },
  ): Promise<void>;
  /** Adds one model call's cost and tokens to the step run and its run (at write time). */
  addUsage(
    tenantId: string,
    ids: { runId: string; stepRunId: string },
    usage: UsageDelta,
  ): Promise<void>;
  startToolCall(
    tenantId: string,
    input: { stepRunId: string; tool: string; input: unknown },
  ): Promise<string>;
  finishToolCall(
    tenantId: string,
    toolCallId: string,
    result: {
      status: ToolCallStatus;
      output?: unknown;
      durationMs: number;
      externalActionId?: string | null;
    },
  ): Promise<void>;
}

export type ExternalActionStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "executing"
  | "done"
  | "failed";

export interface ExternalActionRecord {
  id: string;
  tenantId: string;
  connectionId: string;
  tool: string;
  runId: string | null;
  stepRunId: string | null;
  agentVersionId: string | null;
  input: JsonObject;
  idempotencyKey: string;
  status: ExternalActionStatus;
  inboxItemId: string | null;
  approvedBy: string | null;
  result: unknown;
  error: unknown;
  before: unknown;
}

export interface ProposeActionInput {
  connectionId: string;
  tool: string;
  runId: string;
  stepRunId: string;
  agentVersionId: string;
  input: JsonObject;
  idempotencyKey: string;
  before: unknown;
  /** `proposed` waits for a person; `approved` is the automatic path (approved by the system). */
  status: "proposed" | "approved";
  /** The approval card, created with the action in one transaction; none for test runs. */
  inbox: {
    title: string;
    agentId: string;
    assigneeRole: "operator" | "client_admin" | "client_user" | null;
    assigneeUserId: string | null;
    payload: JsonObject;
  } | null;
}

/**
 * External actions (src/log/external-actions.ts): every write to a client's tool, proposed or
 * approved, then executed once by idempotency key.
 */
export interface ExternalActionStore {
  /**
   * Inserts the action (and its inbox item) unless one with the same idempotency key exists, in
   * which case that one is returned unchanged: a retried step never proposes twice.
   */
  propose(
    tenantId: string,
    input: ProposeActionInput,
  ): Promise<{ action: ExternalActionRecord; created: boolean }>;
  get(tenantId: string, actionId: string): Promise<ExternalActionRecord | null>;
  /**
   * Moves `approved` → `executing` and returns the action, or returns it as it is (done, failed,
   * executing, proposed, rejected) for the caller to decide.
   */
  claim(
    tenantId: string,
    actionId: string,
  ): Promise<{ action: ExternalActionRecord; claimed: boolean }>;
  complete(
    tenantId: string,
    actionId: string,
    result: { output: unknown; before: unknown },
  ): Promise<ExternalActionRecord>;
  fail(tenantId: string, actionId: string, error: unknown): Promise<ExternalActionRecord>;
}

export interface RuntimePorts {
  store: RuntimeStore;
  log: RunLog;
  actions: ExternalActionStore;
  platform: PlatformStore;
}
