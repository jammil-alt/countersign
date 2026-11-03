// One tool call through the permission gate (ARCHITECTURE §9.5 step 5). Used by agent-mode loops,
// tool-mode skills and the executor's `action` steps alike, so every call is logged and gated the
// same way.

import { captureBefore, runReadTool } from "@countersign/connectors";
import { decideToolCall, type JsonObject } from "@countersign/core";
import type { RegisteredTool } from "../registry/tools";
import { executeAction } from "./actions";
import {
  asJsonObject,
  connectionContext,
  idempotencyKey,
  type RuntimeDeps,
  resolveApprover,
  type StepContext,
} from "./context";
import type { ToolCallStatus } from "./ports";

export type ToolOutcome =
  | { status: "done"; output: unknown; summary?: string | undefined; actionId?: string }
  /** A write waiting for a person: the action and its inbox item. */
  | { status: "awaiting_approval"; actionId: string; inboxItemId: string | null; before: unknown }
  /** Test runs: the write was recorded as proposed and will never run. */
  | { status: "would_have_done"; actionId: string; before: unknown }
  | { status: "refused"; reason: string }
  | { status: "failed"; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOG_STATUS: Record<ToolOutcome["status"], ToolCallStatus> = {
  done: "succeeded",
  awaiting_approval: "awaiting_approval",
  would_have_done: "awaiting_approval",
  refused: "refused",
  failed: "failed",
};

export interface CallToolInput {
  toolId: string;
  input: unknown;
  /** The tools this call may use (the skill's tools plus extraTools); absent = any registered. */
  allowed?: ReadonlySet<string>;
}

/** Calls a tool for a step, logging a `tool_call` row whatever happens. */
export async function callTool(
  deps: RuntimeDeps,
  step: StepContext,
  call: CallToolInput,
): Promise<ToolOutcome> {
  const { log } = deps.ports;
  const tool = deps.tools.get(call.toolId);
  if (!tool) return { status: "refused", reason: `no tool ${call.toolId}` };
  if (call.allowed && !call.allowed.has(call.toolId)) {
    return { status: "refused", reason: `${call.toolId} is not one of this skill's tools` };
  }
  const started = Date.now();
  const toolCallId = await log.startToolCall(step.tenantId, {
    stepRunId: step.stepRunId,
    tool: call.toolId,
    input: call.input,
  });
  let outcome: ToolOutcome;
  try {
    outcome = await dispatch(deps, step, tool, call.input);
  } catch (error) {
    outcome = { status: "failed", error: errorText(error) };
  }
  const actionId = "actionId" in outcome ? outcome.actionId : undefined;
  await log.finishToolCall(step.tenantId, toolCallId, {
    status: LOG_STATUS[outcome.status],
    output:
      outcome.status === "done"
        ? outcome.output
        : outcome.status === "refused"
          ? { refused: outcome.reason }
          : outcome.status === "failed"
            ? { error: outcome.error }
            : { status: outcome.status },
    durationMs: Date.now() - started,
    externalActionId: actionId ?? null,
  });
  return outcome;
}

async function dispatch(
  deps: RuntimeDeps,
  step: StepContext,
  tool: RegisteredTool,
  input: unknown,
): Promise<ToolOutcome> {
  const mode = step.agent.bundle.definition.permissions.mode;
  if (tool.kind === "internal") {
    // Platform and pack tools write only the platform's own records: `none` and `internal` run.
    const parsed = tool.tool.input.safeParse(input);
    if (!parsed.success)
      return { status: "failed", error: `invalid input: ${parsed.error.message}` };
    const raw = await tool.tool.run(parsed.data, {
      tenantId: step.tenantId,
      agentId: step.agent.agentId,
      agentVersionId: step.agent.agentVersionId,
      runId: step.runId,
      stepRunId: step.stepRunId,
      stepId: step.stepId,
      mode: step.mode,
      threadId: step.threadId,
      platform: deps.ports.platform,
    });
    const out = tool.tool.output.safeParse(raw);
    if (!out.success) return { status: "failed", error: `invalid output: ${out.error.message}` };
    return { status: "done", output: out.data };
  }

  const connectorId = tool.connector.manifest.id;
  const connectionId = step.agent.bindings[connectorId];
  // Read fresh on every call: a client's tightening applies at once, even mid-run (§1.2).
  const conn = connectionId ? await deps.ports.store.connection(step.tenantId, connectionId) : null;
  if (!conn) return { status: "refused", reason: `no ${connectorId} connection is bound` };
  const decision = decideToolCall({
    sideEffect: tool.spec.sideEffect,
    verb: tool.spec.verb,
    matrix: conn.permissions,
    stepApproval: step.approval?.required,
    agentMode: mode,
  });
  if (decision === "refused") {
    return {
      status: "refused",
      reason: `${tool.spec.verb} is off on the ${connectorId} connection`,
    };
  }
  const ctx = connectionContext(deps, step.tenantId, conn);
  if (tool.spec.sideEffect !== "external") {
    const r = await runReadTool(tool.connector, tool.spec.id, input, ctx);
    return { status: "done", output: r.output, summary: r.summary };
  }

  // A write to the client's tool: always an external_action, with its before state.
  const captured = await captureBefore(tool.connector, tool.spec.id, input, ctx);
  const key = idempotencyKey(step);
  const test = step.mode === "test";
  const automatic = decision === "run" && !test;
  const approver =
    automatic || test
      ? null
      : resolveApprover([
          step.approval?.approver,
          step.agent.bundle.definition.permissions.approver,
          step.agent.approver,
          await deps.ports.store.clientApprover(step.tenantId),
        ]);
  const { action } = await deps.ports.actions.propose(step.tenantId, {
    connectionId: conn.id,
    tool: tool.spec.id,
    runId: step.runId,
    stepRunId: step.stepRunId,
    agentVersionId: step.agent.agentVersionId,
    input: asJsonObject(captured.input),
    idempotencyKey: key,
    before: captured.before,
    status: automatic ? "approved" : "proposed",
    inbox: approver
      ? {
          title: `${tool.spec.description} (${tool.spec.id})`,
          agentId: step.agent.agentId,
          ...approver,
          payload: {
            tool: tool.spec.id,
            verb: tool.spec.verb,
            connector: connectorId,
            connectionId: conn.id,
            input: captured.input as JsonObject[string],
            before: (captured.before ?? null) as JsonObject[string],
            stepId: step.stepId,
            onReject: step.approval?.onReject ?? "stop",
          },
        }
      : null,
  });
  if (test) return { status: "would_have_done", actionId: action.id, before: captured.before };
  switch (action.status) {
    case "proposed":
      return {
        status: "awaiting_approval",
        actionId: action.id,
        inboxItemId: action.inboxItemId,
        before: action.before,
      };
    case "rejected":
      return { status: "refused", reason: "a person rejected this change" };
    default: {
      // approved (now, automatically, or earlier by a person), executing, done or failed.
      const r = await executeAction(deps, { tenantId: step.tenantId, actionId: action.id });
      if (r.status === "done") {
        return { status: "done", output: r.output, summary: r.summary, actionId: action.id };
      }
      if (r.status === "failed") return { status: "failed", error: r.error };
      if (r.status === "rejected") return { status: "refused", reason: "rejected" };
      return {
        status: "awaiting_approval",
        actionId: action.id,
        inboxItemId: action.inboxItemId,
        before: action.before,
      };
    }
  }
}
