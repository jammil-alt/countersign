// Executing an approved external action, exactly once (ARCHITECTURE §9.5, docs/plan.md §1.2
// "External actions"). The workflow executor calls this in its own durable step keyed by the
// action's idempotency key, after the approval resolved (or at once on the automatic path).

import { executeWrite, UnconfirmedWriteError } from "@countersign/connectors";
import { releaseOf } from "@countersign/core";
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
 * - A connector that can't tell whether such a write happened (UnconfirmedWriteError) never writes
 *   again: the action fails with its reason and the operator gets a `review` item to check it.
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
  // Human release holds at execution too (docs/plan.md §1.26): an approved write runs only under a
  // live release for its agent, connection and run. An approval is not a release, and nothing here
  // asks for one: without it the write fails.
  // DECISION: the check is made before the action is claimed, so a refused write never starts.
  if (found.status === "approved" || found.status === "executing") {
    const refused = await releaseRefusal(deps, input.tenantId, found);
    if (refused) {
      const failed = await actions.fail(input.tenantId, found.id, {
        message: refused,
        release: true,
      });
      return { status: "failed", action: failed, error: refused };
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
    if (error instanceof UnconfirmedWriteError) {
      // DECISION: a write that may have happened goes to the operator, not to a retry: the action
      // fails with the connector's reason and a `review` item opens with it, in one transaction
      // (docs/plan.md §1.22).
      const owner = action.runId ? await store.run(input.tenantId, action.runId) : null;
      const failed = await actions.fail(
        input.tenantId,
        action.id,
        { message: error.message, unconfirmed: true, ...error.details },
        {
          inbox: {
            title: error.title,
            agentId: owner?.agentId ?? null,
            payload: {
              reason: error.message,
              tool: action.tool,
              connectionId: action.connectionId,
              idempotencyKey: action.idempotencyKey,
              ...error.details,
            },
          },
        },
      );
      return { status: "failed", action: failed, error: error.message };
    }
    const failed = await actions.fail(input.tenantId, action.id, { message: message(error) });
    return { status: "failed", action: failed, error: message(error) };
  }
}

/** Why an approved write may not run now for want of a release, or null. */
async function releaseRefusal(
  deps: RuntimeDeps,
  tenantId: string,
  action: ExternalActionRecord,
): Promise<string | null> {
  const conn = await deps.ports.store.connection(tenantId, action.connectionId);
  if (!conn || releaseOf(conn.config).mode !== "code") return null;
  const run = action.runId ? await deps.ports.store.run(tenantId, action.runId) : null;
  const covered =
    run && action.runId
      ? await deps.ports.release?.covers(tenantId, {
          connection: conn,
          agentId: run.agentId,
          runId: action.runId,
        })
      : false;
  return covered
    ? null
    : `the ${conn.connector} connection needs a person to release it, and no release is live`;
}
