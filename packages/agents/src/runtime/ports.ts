// What the runtime needs from storage, as interfaces. The runtime itself never imports the database
// (CLAUDE.md invariant 2): src/registry/ implements the reads and src/log/ the writes
// (`createDbPorts`), and tests may pass in-memory ones. Every method names its client: each call is
// one short transaction scoped to that client (withTenant), never held across a model call.

import type { ConnectionRef } from "@countersign/connectors";
import type { AgentBundle, ApproverRule, GrantLimits, JsonObject } from "@countersign/core";
import type { ResolvedSkill } from "../registry/skills";
import type { DocumentsPort, KnowledgePort, PlatformStore, RunMode } from "../tools/types";

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

export interface ApprovalRouting {
  rules: ApproverRule[];
  revision: number;
  clientDefault: string | null;
  members: ReadonlySet<string>;
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
  /**
   * The client agent's grant on a connection (docs/plan.md §1.26), read fresh for every call so a
   * client's tightening or revoke applies at once; null = no narrowing.
   */
  grant(tenantId: string, agentId: string, connectionId: string): Promise<GrantLimits | null>;
  /**
   * What decides who approves a write, read fresh for every proposal so a client's tightening
   * applies at once: the client's approver rules (`tenant.settings.approver_rules`), its default
   * (`tenant.settings.approvals.external_actions`) and its client users' ids.
   */
  approvalRouting(tenantId: string): Promise<ApprovalRouting>;
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
  /** The action proposed under this idempotency key, if any (a retried step finds its own). */
  byKey(tenantId: string, idempotencyKey: string): Promise<ExternalActionRecord | null>;
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
  /**
   * Marks the action failed. With `inbox`, an item for a person to look at is opened in the same
   * transaction (a write that may have happened: UnconfirmedWriteError).
   */
  fail(
    tenantId: string,
    actionId: string,
    error: unknown,
    options?: { inbox?: FailureInboxItem },
  ): Promise<ExternalActionRecord>;
}

/** An inbox item opened with a failed action, for the operator to check what happened. */
export interface FailureInboxItem {
  title: string;
  agentId: string | null;
  payload: JsonObject;
}

/** One call that needs a vault item released by a person (docs/plan.md §1.26 "Human release"). */
export interface ReleaseAsk {
  connection: ConnectionRef;
  agentId: string;
  runId: string;
  stepRunId: string;
  /** The tool the agent tried, for the person's inbox item. */
  toolId: string;
  test: boolean;
}

/** A request made: the code went out and the person's inbox item is open. */
export interface ReleaseRequested {
  releaseId: string;
  inboxItemId: string;
}

/**
 * Human release (apps/api implements it over the database, the client's messaging and Mezonas'
 * sending). The runtime asks only whether a release covers a call and, when none does, for a new
 * request; it never sees a code.
 */
export interface ReleasePort {
  /** Whether a live release lets this agent use the connection in this run now. */
  covers(
    tenantId: string,
    ask: Omit<ReleaseAsk, "stepRunId" | "toolId" | "test">,
  ): Promise<boolean>;
  /**
   * Voids this connection, agent and run's older pending request, sends a new code to the person
   * the setting names and opens their inbox item. `refused` when no code can be sent.
   */
  request(tenantId: string, ask: ReleaseAsk): Promise<ReleaseRequested | { refused: string }>;
}

export interface RuntimePorts {
  store: RuntimeStore;
  log: RunLog;
  actions: ExternalActionStore;
  platform: PlatformStore;
  /** The documents capability for `docs.*` tools; absent: those tools fail with a reason. */
  documents?: DocumentsPort;
  /** The client's knowledge base for `knowledge.search`; absent: that tool fails with a reason. */
  knowledge?: KnowledgePort;
  /**
   * Human release; absent: a connection that needs one refuses every call (fails closed), as in a
   * voice call's tool, which can't wait for a code.
   */
  release?: ReleasePort;
}
