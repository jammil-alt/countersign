// The runtime's dependencies and the per-step context every tool call carries.

import {
  type ConnectionRef,
  type ConnectorServices,
  type CredentialsAccessor,
  type Logger,
  memoryCredentials,
  noopLogger,
} from "@countersign/connectors";
import type { Approval, JsonObject, Locale } from "@countersign/core";
import type { LlmTransport } from "@countersign/llm";
import type { SkillCatalog } from "../registry/skills";
import type { ToolRegistry } from "../registry/tools";
import type { AskAnswer, AskInput, RunMode } from "../tools/types";
import type { PinnedAgent, RuntimePorts } from "./ports";

export interface RuntimeDeps {
  ports: RuntimePorts;
  tools: ToolRegistry;
  catalog: SkillCatalog;
  /** The model transport (live, record/replay, or a FakeModel in tests). */
  transport: LlmTransport;
  /**
   * A connection's credentials for connector calls. apps/api passes the encrypted accessor;
   * the default has none, which is all `auth: 'none'` connectors need.
   */
  credentials?: (connection: ConnectionRef) => CredentialsAccessor;
  /** Platform services for connector calls (e.g. contacts and consent); apps/api passes them. */
  services?: (connection: ConnectionRef) => ConnectorServices;
  logger?: Logger;
  now?: () => Date;
}

/** One step of one run, for one client agent version. */
export interface StepContext {
  tenantId: string;
  agent: PinnedAgent;
  runId: string;
  stepRunId: string;
  /** The workflow step id (or a command's id): part of each external action's idempotency key. */
  stepId: string;
  mode: RunMode;
  /** The step's approval setting; absent means required (approval is on by default). */
  approval?: Approval | undefined;
  /**
   * An action step's input as written in the agent's version, before templates: the gate checks a
   * tool's fixed inputs (ToolSpec `fixedInputs`) against it. Absent when a model wrote the call
   * (skills, agent mode), so such tools are refused there.
   */
  literalInput?: unknown;
  threadId?: string | undefined;
  /** Counts external calls in this step, for `<run id>:<step id>:<index>` keys. */
  externalIndex: { next: number };
  /**
   * An asked agent (`agents.ask`, docs/plan.md §1.28): only tools that read (`sideEffect: none`)
   * run, and a connection that needs a person's release refuses rather than asks for one.
   */
  readOnly?: boolean | undefined;
  /** How this step asks another agent of the client; absent inside an ask and in action steps. */
  ask?: ((input: AskInput) => Promise<AskAnswer>) | undefined;
  /** The client's language, for tools that write words a client reads. */
  language?: Locale | undefined;
}

export function connectionContext(deps: RuntimeDeps, tenantId: string, connection: ConnectionRef) {
  return {
    tenantId,
    connection,
    credentials: deps.credentials?.(connection) ?? memoryCredentials(null),
    logger: deps.logger ?? noopLogger,
    now: deps.now ?? (() => new Date()),
    ...(deps.services ? { services: deps.services(connection) } : {}),
  };
}

/** `<run id>:<step id>:<index>` (docs/plan.md §1.2 "External actions"). */
export function idempotencyKey(step: StepContext): string {
  const key = nextIdempotencyKey(step);
  step.externalIndex.next += 1;
  return key;
}

/** The key the step's next external call will take, without taking it. */
export function nextIdempotencyKey(step: StepContext): string {
  return `${step.runId}:${step.stepId}:${step.externalIndex.next}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Assignee = {
  assigneeRole: "operator" | "client_admin" | "client_user" | null;
  assigneeUserId: string | null;
};

/**
 * Who approves a step's write: the step's approver, else the agent's (its definition, then the
 * client agent's override), else the client's setting, else the client admin (ARCHITECTURE §4, §10.1).
 */
export function resolveApprover(candidates: readonly (string | null | undefined)[]): Assignee {
  for (const c of candidates) {
    if (!c) continue;
    if (UUID.test(c)) return { assigneeRole: null, assigneeUserId: c };
    if (c === "operator" || c === "client_admin" || c === "client_user") {
      return { assigneeRole: c, assigneeUserId: null };
    }
  }
  return { assigneeRole: "client_admin", assigneeUserId: null };
}

export function asJsonObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : { value: value as JsonObject[string] };
}
