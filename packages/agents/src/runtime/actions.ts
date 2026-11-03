// Executing an approved external action, exactly once (ARCHITECTURE §9.5, docs/plan.md §1.2
// "External actions"). The workflow executor calls this in its own durable step keyed by the
// action's idempotency key, after the approval resolved (or at once on the automatic path).

import { executeWrite } from "@countersign/connectors";
import { AgentsError, notFound } from "../errors";
import { connectionContext, type RuntimeDeps } from "./context";
import type { ExternalActionRecord } from "./ports";

export type ActionOutcome =
  | { status: "done"; action: ExternalActionRecord; output: unknown; summary?: string | undefined }
  | { status: "failed"; action: ExternalActionRecord; error: string }
  | { status: "awaiting_approval"; action: ExternalActionRecord }
  | { status: "rejected"; action: ExternalActionRecord };

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Runs an approved action through its connector and records the result and the before state.
 *
 * - `done` / `failed` actions return what was recorded: a retried step never writes twice.
 * - `proposed` / `rejected` actions never execute.
 * - Actions of test runs never execute (ARCHITECTURE §10.4).
 * - An action left `executing` by a crash is run again with the same idempotency key; connectors
 *   must make writes idempotent by that key (the testkit does; QBO takes it as its request id).
 */
// DECISION: crash recovery re-runs an `executing` action with its key rather than failing it, so a
// Workflow retry after a lost response completes the write instead of stranding it.
export async function executeAction(
  deps: RuntimeDeps,
  input: { tenantId: string; actionId: string },
): Promise<ActionOutcome> {
  const { actions, store } = deps.ports;
  const found = await actions.get(input.tenantId, input.actionId);
  if (!found) throw notFound(`external action ${input.actionId}`);
  if (found.runId) {
    const run = await store.run(input.tenantId, found.runId);
    if (run?.mode === "test") {
      throw new AgentsError("test_run", "test runs never execute external actions");
    }
  }
  const { action, claimed } = await actions.claim(input.tenantId, input.actionId);
  if (!claimed) {
    switch (action.status) {
      case "done":
        return { status: "done", action, output: action.result };
      case "failed":
        return {
          status: "failed",
          action,
          error: String((action.error as { message?: unknown })?.message ?? "failed"),
        };
      case "proposed":
        return { status: "awaiting_approval", action };
      case "rejected":
        return { status: "rejected", action };
      case "approved":
      case "executing":
        break;
    }
  }
  const tool = deps.tools.get(action.tool);
  if (tool?.kind !== "connector") {
    const failed = await actions.fail(input.tenantId, action.id, {
      message: `unknown tool ${action.tool}`,
    });
    return { status: "failed", action: failed, error: `unknown tool ${action.tool}` };
  }
  const conn = await store.connection(input.tenantId, action.connectionId);
  if (!conn) {
    const failed = await actions.fail(input.tenantId, action.id, {
      message: "connection not found",
    });
    return { status: "failed", action: failed, error: "connection not found" };
  }
  try {
    const written = await executeWrite(tool.connector, action.tool, action.input, {
      ...connectionContext(deps, input.tenantId, conn),
      idempotencyKey: action.idempotencyKey,
    });
    const done = await actions.complete(input.tenantId, action.id, {
      output: written.output,
      before: written.before,
    });
    return { status: "done", action: done, output: written.output, summary: written.summary };
  } catch (error) {
    const failed = await actions.fail(input.tenantId, action.id, { message: message(error) });
    return { status: "failed", action: failed, error: message(error) };
  }
}
