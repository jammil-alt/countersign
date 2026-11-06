// What the runtime needs from storage, as interfaces. The runtime itself never imports the database
// (CLAUDE.md invariant 2): src/registry/ implements the reads and src/log/ the writes
// (`createDbPorts`), and tests may pass in-memory ones. Every method names its client: each call is
// one short transaction scoped to that client (withTenant), never held across a model call.

import type { ConnectionRef } from "@countersign/connectors";
import type {
  AgentBundle,
  ApproverRule,
  GrantLimits,
  JsonObject,
  PermissionLevel,
  ReachChannel,
} from "@countersign/core";
import type { ModelCallPort } from "../log/model-calls";
import type { ResolvedSkill } from "../registry/skills";
import type {
  DirectoryPort,
  DocumentsPort,
  FindingsPort,
  HealthPort,
  KnowledgePort,
  PlatformStore,
  RunMode,
} from "../tools/types";

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
  /** v0.12 W1-D: the client's viewers (`membership.can_sign` false): never assigned anything. */
  viewers?: ReadonlySet<string>;
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
  // v0.12 W1-G: the recipient's autonomy (docs/plan.md §1.42).
  /**
   * The autonomy for `channel` of the client's contact at this address (an email address or an
   * E.164 number), read fresh for every send; null when the contact has none set or isn't one of
   * the client's. Optional: a store without it narrows nothing.
   */
  contactAutonomy?(
    tenantId: string,
    recipient: { channel: ReachChannel; to: string },
  ): Promise<PermissionLevel | null>;
  // v0.12 W1-A: go-live stages
  /**
   * The client agent's go-live stage (ARCHITECTURE §10.9), read fresh at every write decision like
   * the matrix, so a stage change applies mid-run; null when it has none.
   */
  agentStage(tenantId: string, agentId: string): Promise<string | null>;
  /**
   * What decides who approves a write, read fresh for every proposal so a client's tightening
   * applies at once: the client's approver rules (`tenant.settings.approver_rules`), its default
   * (`tenant.settings.approvals.external_actions`) and its client users' ids.
   */
  approvalRouting(tenantId: string): Promise<ApprovalRouting>;
  run(tenantId: string, runId: string): Promise<{ mode: RunMode; agentId: string } | null>;
  /**
   * Another client agent of the same client that `agents.ask` may run: its live version and
   * name; null when there is none (another client's agent, a template, a test copy, retired or
   * discarded, or no live version).
   */
  askTarget(
    tenantId: string,
    agentId: string,
  ): Promise<{ agentId: string; agentVersionId: string; name: string } | null>;
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
  /**
   * A test run for an ask (`agents.ask`, docs/plan.md §1.28): the asked agent's live version, in
   * the same client, with the asking run in its trigger. Returns the run id.
   */
  startAskRun(
    tenantId: string,
    input: { agentId: string; agentVersionId: string; askedBy: { agentId: string; runId: string } },
  ): Promise<string>;
  finishAskRun(
    tenantId: string,
    runId: string,
    result: { status: "succeeded" | "failed"; error?: string },
  ): Promise<void>;
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
  // v0.12 W1-D: the signer's edit before signing (ARCHITECTURE §11.1). `input` stays the agent's;
  // execution uses the edit when there is one.
  editedInput?: JsonObject | null;
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
    /** v0.12 W1-D: `<run id>:<top step id>`, shared by the items one step proposes. */
    batchKey?: string | null;
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
   * executing, proposed, rejected) for the caller to decide. An approved action whose inbox item is
   * still inside its undo window (`deliver_after` in the future) is not claimed (v0.12 W1-D).
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

/**
 * A connection the platform found needing a person (src/log/connection-attention.ts): marks it
 * `error`, logs the change and emits `connection.needs_attention` in one transaction, once.
 */
export interface ConnectionAttentionPort {
  needsAttention(
    tenantId: string,
    input: { connectionId: string; reason: "signin_expired" | "sync_failed"; detail: string },
  ): Promise<void>;
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
  /** The client's directory for `directory.*`; absent: those tools fail with a reason. */
  directory?: DirectoryPort;
  /**
   * Human release; absent: a connection that needs one refuses every call (fails closed), as in a
   * voice call's tool, which can't wait for a code.
   */
  release?: ReleasePort;
  /** The client's health records for `health.*` and the supervisor; absent: those tools fail. */
  health?: HealthPort;
  /** The supervisor's findings and summaries; absent: `supervisor.*` fail. */
  findings?: FindingsPort;
  /** Marks connections that need a person (an expired sign-in); absent: nothing is marked. */
  attention?: ConnectionAttentionPort;
  // v0.12 W1-E
  /** A retry's carried approvals; absent: a retry proposes every write again. */
  carried?: CarriedActionsPort;
  /** Each model call of a run's step, with its request and answer; absent: not kept. */
  modelCalls?: ModelCallPort;
}

// ── v0.12 W1-E: carried approvals and model calls (ARCHITECTURE §10.10) ─────────────────────────

/** An action a retry may carry: one the same step proposed in the run retried (or before it). */
export interface CarryCandidate {
  id: string;
  tool: string;
  connectionId: string;
  input: unknown;
  idempotencyKey: string;
  status: ExternalActionStatus;
  approvedAt: Date | null;
  /** Who signed it; null when the system approved it (the automatic path). */
  approvedBy: string | null;
  result: unknown;
  error: unknown;
}

/** src/log/carried-actions.ts. */
export interface CarriedActionsPort {
  /** The actions node `nodeId` proposed in `retryOf` and the runs it retried, oldest first. */
  candidates(
    tenantId: string,
    input: { retryOf: string; nodeId: string },
  ): Promise<CarryCandidate[]>;
  /**
   * Makes a carried action executable again under its original key (`failed` → `approved`);
   * true when it now is (approved or executing), false when something else changed it.
   */
  reopen(tenantId: string, actionId: string): Promise<boolean>;
}
