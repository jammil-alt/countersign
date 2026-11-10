// Executing an approved external action, exactly once (ARCHITECTURE §9.5, docs/plan.md §1.2
// "External actions"). The workflow executor calls this in its own durable step keyed by the
// action's idempotency key, after the approval resolved (or at once on the automatic path).

import {
  bindingKeyFor,
  type ConnectionRef,
  type Connector,
  captureBefore,
  executeWrite,
  ToolCallError,
  UnconfirmedWriteError,
  type UndoInputHook,
} from "@countersign/connectors";
import {
  canonicalJson,
  decideToolCall,
  editablePaths,
  editProblem,
  effectiveMode,
  grantAllowsTool,
  isAlwaysSigned,
  isPlainObject,
  type JsonObject,
  type JsonValue,
  processes,
  recipientOf,
  releaseOf,
  type ToolSpec,
} from "@countersign/core";
import { AgentsError, notFound } from "../errors";
import { noteReconnect } from "./attention";
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
  input: {
    tenantId: string;
    actionId: string;
    /**
     * v0.12 W1-E: the run executing it, when not the one that proposed it (a retry carrying the
     * original's approved action, ARCHITECTURE §10.10): its release is the one that must cover it.
     */
    runId?: string;
  },
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
    const refused = await releaseRefusal(deps, input.tenantId, found, input.runId);
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
        // v0.12 W1-D: approved but still inside its undo window: not executed now. The run is
        // told once the window has passed, and an undo before then puts it back to proposed.
        return { status: "awaiting_approval", action };
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
  // v0.14 W4-A: a shared id runs through the connector of the connection it was proposed on.
  const own = deps.tools.forConnector(action.tool, conn.connector);
  if (own?.kind !== "connector") {
    const message = `${action.tool} isn't supplied by the ${conn.connector} connection`;
    const failed = await actions.fail(input.tenantId, action.id, { message });
    return { status: "failed", action: failed, error: message };
  }
  try {
    // v0.12 W1-D: the signer's edit, when there is one, is what is written; `input` stays the
    // agent's version (ARCHITECTURE §11.1).
    const written = await executeWrite(
      own.connector,
      action.tool,
      action.editedInput ?? action.input,
      {
        ...connectionContext(deps, input.tenantId, conn),
        idempotencyKey: action.idempotencyKey,
        // v0.14 W4-D: what the approver saw, for tools that refuse a change made since.
        proposedBefore: action.before,
      },
    );
    // R5: the record as this write left it, for an undo to check that nobody changed it since.
    const after = actions.keepsAfter
      ? await readAfter(deps, input.tenantId, own, conn, action)
      : undefined;
    const done = await actions.complete(input.tenantId, action.id, {
      output: written.output,
      before: written.before,
      ...(after === undefined ? {} : { after }),
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
    await noteReconnect(deps, input.tenantId, conn, error);
    const failed = await actions.fail(input.tenantId, action.id, { message: message(error) });
    return { status: "failed", action: failed, error: message(error) };
  }
}

/** Why an approved write may not run now for want of a release, or null. */
async function releaseRefusal(
  deps: RuntimeDeps,
  tenantId: string,
  action: ExternalActionRecord,
  executingRunId?: string,
): Promise<string | null> {
  const conn = await deps.ports.store.connection(tenantId, action.connectionId);
  if (!conn || releaseOf(conn.config).mode !== "code") return null;
  const runId = executingRunId ?? action.runId;
  const run = runId ? await deps.ports.store.run(tenantId, runId) : null;
  const covered =
    run && runId
      ? await deps.ports.release?.covers(tenantId, {
          connection: conn,
          agentId: run.agentId,
          runId,
        })
      : false;
  return covered
    ? null
    : `the ${conn.connector} connection needs a person to release it, and no release is live`;
}

// ── v0.12 W1-D: edit before signing (ARCHITECTURE §11.1) ─────────────────────────────────────────

export type EditCheck =
  | { ok: true; input: JsonObject; before: unknown }
  | { ok: false; code: "not_editable" | "invalid_input" | "refused"; message: string };

/**
 * Checks a person's edit of a proposed action before it is stored: it differs from the agent's
 * input only in fields the tool's display marks editable (never fixed inputs, ids or guards), it
 * reaches the same connection, the gate still lets the tool through that connection, and the
 * connector's own proposal checks pass on it (its Zod input and its `before` hook, e.g. an itemize
 * total). Who signs it is checked by the caller (the approver rules, again). Nothing is written.
 */
export async function checkEditedInput(
  deps: RuntimeDeps,
  input: { tenantId: string; action: ExternalActionRecord; edited: unknown },
): Promise<EditCheck> {
  const { action, edited, tenantId } = input;
  const tool = deps.tools.get(action.tool);
  if (tool?.kind !== "connector" || tool.spec.sideEffect !== "external") {
    return { ok: false, code: "not_editable", message: `${action.tool} can't be edited` };
  }
  const problem = editProblem({
    original: action.input,
    edited,
    paths: editablePaths(tool.spec.display, tool.spec.fixedInputs),
  });
  if (problem) return { ok: false, code: "not_editable", message: problem };
  // The same binding: an edit never moves a change to another connection (e.g. a browser site).
  if (bindingKeyFor(tool.connector, edited) !== bindingKeyFor(tool.connector, action.input)) {
    return { ok: false, code: "not_editable", message: "the edit reaches a different connection" };
  }
  const conn = await deps.ports.store.connection(tenantId, action.connectionId);
  const owner = action.runId ? await deps.ports.store.run(tenantId, action.runId) : null;
  if (!conn || !owner) return { ok: false, code: "refused", message: "the connection is gone" };
  // v0.14 W4-A: a shared id is checked by the connector of the connection it was proposed on.
  const own = deps.tools.forConnector(action.tool, conn.connector);
  if (own?.kind !== "connector") {
    return { ok: false, code: "refused", message: "the connection is gone" };
  }
  const refused = await signedGateRefusal(deps, tenantId, {
    spec: own.spec,
    connector: own.connector,
    conn,
    agentId: owner.agentId,
    input: edited,
  });
  if (refused) return { ok: false, code: "refused", message: refused };
  try {
    const captured = await captureBefore(
      own.connector,
      tool.spec.id,
      edited,
      connectionContext(deps, tenantId, conn),
    );
    return { ok: true, input: captured.input as JsonObject, before: captured.before };
  } catch (error) {
    return { ok: false, code: "invalid_input", message: message(error) };
  }
}

/**
 * Why the gate refuses a write a person signs (an edit before signing, an undo), or null. Asked
 * with the strictest mode: a person's signature never lets a change through a connection or grant
 * that is off for it, and the gate is never asked whether it may run unsigned.
 */
// DECISION: shared by the edit before signing (v0.12 W1-D) and R5's undo, so both read the
// connection's matrix, the agent's grant and the entity's level the same way. A write with no
// agent (a signed write's undo) has no grant to narrow it.
async function signedGateRefusal(
  deps: RuntimeDeps,
  tenantId: string,
  call: {
    spec: ToolSpec;
    connector: Connector;
    conn: ConnectionRef;
    agentId: string | null;
    input: unknown;
    // R3: asked whether the write may run with no signature at all (`unsignedRefusal`): the
    // agent's mode at its stage and the recipient's autonomy decide too, and only `run` passes.
    unsigned?: {
      mode: Parameters<typeof decideToolCall>[0]["agentMode"];
      ceilings?: Parameters<typeof decideToolCall>[0]["ceilings"];
    };
  },
): Promise<string | null> {
  const { spec, conn, unsigned } = call;
  const grant = call.agentId ? await deps.ports.store.grant(tenantId, call.agentId, conn.id) : null;
  const decision = decideToolCall({
    sideEffect: spec.sideEffect,
    verb: spec.verb,
    matrix: conn.permissions,
    grant,
    agentMode: unsigned?.mode ?? "suggest_only",
    ...(unsigned
      ? {
          stepApproval: "not_required" as const,
          ceilings: unsigned.ceilings,
          alwaysSigned: isAlwaysSigned(spec),
        }
      : {}),
    // v0.12 W2-A: the input's entity and scope count too.
    entity: {
      tool: spec,
      input: call.input,
      declared: call.connector.manifest.permissionEntities,
    },
  });
  if (!grantAllowsTool(grant, spec.id) || decision === "refused") {
    return `${spec.verb} is off for this change now`;
  }
  if (unsigned && decision !== "run") {
    return `${spec.verb} needs a person's signature on this connection now`;
  }
  return null;
}

// ── R3: a write that goes ahead with nobody's answer (docs/plan.md §1.86) ──────────────────────

/**
 * Why a proposed write may not go ahead unsigned now, or null when the gate would let it run
 * without a signature: the step's approval `not_required` (what an approval's `ifNoAnswer:
 * proceed` stands for once nobody answered), the connection's matrix and the agent's grant at
 * `auto` for the verb (and its entity), the recipient's autonomy, and the agent's mode `act` at
 * its stage, each read fresh. The executor asks this before a write proceeds with nobody's answer.
 */
// DECISION: the validator let `proceed` only where the gate would run the write unsigned when the
// process was published (invariant 8), but a client may tighten the matrix (or the agent leave
// `live`) since: the gate is asked again, now, with the same inputs it decides a write by, and a
// write it would make wait never goes ahead on a deadline.
export async function unsignedRefusal(
  deps: RuntimeDeps,
  input: { tenantId: string; actionId: string },
): Promise<string | null> {
  const { tenantId } = input;
  const { store } = deps.ports;
  const action = await deps.ports.actions.get(tenantId, input.actionId);
  if (!action) throw notFound(`external action ${input.actionId}`);
  // DECISION (wave 2c): a change a person edited and left unsigned never goes ahead on a
  // deadline: the edit was theirs, the signature never came. The gate below reads the input that
  // would be written all the same.
  if (action.editedInput) return "a person edited this change and never signed it";
  const written = action.editedInput ?? action.input;
  const conn = await store.connection(tenantId, action.connectionId);
  const owner = action.runId ? await store.run(tenantId, action.runId) : null;
  if (!conn || !owner || !action.agentVersionId) return "the change has no agent to go ahead for";
  const own = deps.tools.forConnector(action.tool, conn.connector);
  if (own?.kind !== "connector") return "the connection is gone";
  const pinned = await store.loadAgentVersion(tenantId, action.agentVersionId);
  const stage = await store.agentStage(tenantId, owner.agentId);
  const recipient = recipientOf(own.spec, written);
  const autonomy =
    recipient && store.contactAutonomy ? await store.contactAutonomy(tenantId, recipient) : null;
  const refused = await signedGateRefusal(deps, tenantId, {
    spec: own.spec,
    connector: own.connector,
    conn,
    agentId: owner.agentId,
    input: written,
    unsigned: {
      mode: effectiveMode(pinned.bundle.definition, stage),
      ...(autonomy ? { ceilings: [autonomy] } : {}),
    },
  });
  return refused;
}

// ── R5: undo (docs/plan.md §1.86, §9; ARCHITECTURE §10.14 "Undo") ────────────────────────────────

/** A connector tool as the registry hands it out. */
type ConnectorTool = { kind: "connector"; spec: ToolSpec; connector: Connector };

/** The context a write ran with, for reading its record the same way (its key included). */
function writeContext(
  deps: RuntimeDeps,
  tenantId: string,
  conn: ConnectionRef,
  idempotencyKey: string,
) {
  return { ...connectionContext(deps, tenantId, conn), idempotencyKey };
}

/**
 * The record as a write left it: the tool's own `before`, read again right after writing with the
 * same input and key, so it has the shape of `before` and of an undo's current read. Undefined for
 * a write that can't be taken back (nothing to read for); null when the read fails, which never
 * fails the write (an undo then refuses: `after_unknown`).
 */
async function readAfter(
  deps: RuntimeDeps,
  tenantId: string,
  own: ConnectorTool,
  conn: ConnectionRef,
  action: ExternalActionRecord,
): Promise<unknown> {
  const undo = processes.undoOf(own.spec);
  if (!undo || undo.kind === "none") return undefined;
  try {
    const read = await captureBefore(
      own.connector,
      action.tool,
      action.editedInput ?? action.input,
      writeContext(deps, tenantId, conn, action.idempotencyKey),
    );
    return read.before ?? null;
  } catch {
    return null;
  }
}

/** The key of a write's undo: one undo per write, so a second press never writes twice. */
export function undoKey(actionId: string): string {
  return `undo:${actionId}`;
}

/** What a connector may give a write tool to build its undo's input (R5): connectors' own types. */
export type { UndoInputArgs, UndoInputHook } from "@countersign/connectors";

// DECISION: a connector says how its write is taken back with an optional `undoInput` on the
// write's handler (WriteToolHandler, set by `defineWriteTool`). Without one, a restore by the same
// tool uses `restoreInput` below and a reverse is refused (`no_undo_input`).
function undoInputHook(connector: Connector, toolId: string): UndoInputHook | null {
  const handler = connector.tools[toolId];
  return handler?.kind === "write" ? (handler.undoInput ?? null) : null;
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * A restore's input when the write's own tool puts the before state back: each field the write
 * set takes its value from before the write; a field the write only named as it was (an id, a
 * version it was read at) takes its value from now, so the restore is made against the record as
 * it is. Null when a field's value is neither, or nothing would change.
 */
// DECISION: written for the common shape (the before state names the fields the write sets, as
// the testkit, website and HubSpot updates do); a tool whose before state is shaped otherwise
// gives its own `undoInput`, and an input that doesn't parse for the tool is refused before
// anything is recorded.
export function restoreInput(
  input: JsonObject,
  before: unknown,
  current: unknown,
): JsonObject | null {
  if (!isPlainObject(before) || !isPlainObject(current)) return null;
  const out: JsonObject = {};
  let changes = false;
  for (const [key, value] of Object.entries(input)) {
    if (!(key in before)) {
      out[key] = value;
      continue;
    }
    const was = before[key];
    const now = current[key];
    if (same(value, was)) {
      // Named as it was: an id, or the version the write was read at (now the record's latest).
      out[key] = (key in current ? now : value) as JsonValue;
    } else if (same(value, now)) {
      out[key] = (was ?? null) as JsonValue;
      changes = true;
    } else {
      return null;
    }
  }
  return changes ? out : null;
}

export const UNDO_OUTCOME_REFUSALS = [
  ...processes.UNDO_REFUSALS,
  /** The write didn't go through (proposed, rejected, failed or still running). */
  "not_done",
  /** Test runs never write (ARCHITECTURE §10.4). */
  "test_run",
  /** The tool or its connection is gone, or this store records no undo. */
  "unavailable",
  /** We couldn't read the record just now. */
  "read_failed",
  /** No input that takes the write back: the tool doesn't say how, and it can't be worked out. */
  "no_undo_input",
  /** The connection's matrix or the agent's grant is off for the undo. */
  "refused",
] as const;
export type UndoOutcomeRefusal = (typeof UNDO_OUTCOME_REFUSALS)[number];

export type UndoOutcome =
  | { status: "done"; original: ExternalActionRecord; undo: ExternalActionRecord; output: unknown }
  | { status: "failed"; original: ExternalActionRecord; undo: ExternalActionRecord; error: string }
  | {
      status: "refused";
      original: ExternalActionRecord;
      code: UndoOutcomeRefusal;
      reason: string;
    };

/**
 * Takes a done write back, as a person asked (R5): the person's press approves the undo, which is
 * a write of its own through the external-action path (its own key, `undoKey(original.id)`, its
 * before state, executed once by `executeAction`). It first reads the record and runs
 * `processes.canUndo` against the saved before and after states: anything changed since our write
 * refuses, with a plain reason. Never a delete (undoProblems in packages/connectors refuses one
 * when the connector is defined); test runs never write. Who may press is the caller's to check.
 */
export async function undoAction(
  deps: RuntimeDeps,
  input: { tenantId: string; actionId: string; by: string },
): Promise<UndoOutcome> {
  const { actions, store } = deps.ports;
  const { tenantId } = input;
  const original = await actions.get(tenantId, input.actionId);
  if (!original) throw notFound(`external action ${input.actionId}`);
  const refuse = (code: UndoOutcomeRefusal, reason: string): UndoOutcome => ({
    status: "refused",
    original,
    code,
    reason,
  });
  const run = original.runId ? await store.run(tenantId, original.runId) : null;
  if (run?.mode === "test") return refuse("test_run", "test runs never change a client's tools");
  // A second press: the first undo stands, whatever happened to it (never written twice).
  const earlier = await actions.byKey(tenantId, undoKey(original.id));
  if (earlier) return finishUndo(deps, tenantId, original, earlier);
  if (original.status !== "done") {
    return refuse("not_done", "this change didn't go through, so there's nothing to take back");
  }
  if (!actions.proposeUndo) return refuse("unavailable", "undo isn't available here");
  const conn = await store.connection(tenantId, original.connectionId);
  const own = conn ? deps.tools.forConnector(original.tool, conn.connector) : undefined;
  if (!conn || own?.kind !== "connector") {
    return refuse("unavailable", "the connection this change went through is gone");
  }
  const undo = processes.undoOf(own.spec);
  if (!undo || undo.kind === "none") {
    const verdict = processes.canUndo(own.spec, original.before, null, null);
    return verdict.ok
      ? refuse("cannot_undo", "this change can't be taken back")
      : refuse(verdict.code, verdict.reason);
  }
  const written = original.editedInput ?? original.input;
  let current: unknown;
  try {
    const read = await captureBefore(
      own.connector,
      original.tool,
      written,
      writeContext(deps, tenantId, conn, original.idempotencyKey),
    );
    current = read.before;
  } catch (error) {
    const why = readRefusal(error, own.spec);
    return refuse(why.code, why.reason);
  }
  const verdict = processes.canUndo(own.spec, original.before, current, original.after);
  if (!verdict.ok) return refuse(verdict.code, verdict.reason);

  const undoTool = undo.tool ?? original.tool;
  const target = deps.tools.forConnector(undoTool, conn.connector);
  if (target?.kind !== "connector" || target.spec.sideEffect !== "external") {
    return refuse("unavailable", `${undoTool} isn't supplied by the ${conn.connector} connection`);
  }
  // Belt and braces: the connector already refuses a delete as an undo when it is defined.
  if (target.spec.verb === "delete") return refuse("cannot_undo", "an undo never deletes");
  const hook = undoInputHook(own.connector, original.tool);
  const planned = hook
    ? hook({ input: written, before: original.before, output: original.result, current })
    : undo.kind === "restore" && undoTool === original.tool
      ? restoreInput(written, original.before, current)
      : null;
  if (!isPlainObject(planned)) {
    return refuse("no_undo_input", "we can't work out how to put this back on our own");
  }
  // Checked as the connector will check it, and what the undo replaces read, before anything is
  // recorded: an input that doesn't parse, or a record that refuses, records nothing.
  let undoInput: JsonObject;
  let replaces: unknown;
  try {
    const read = await captureBefore(
      target.connector,
      undoTool,
      planned,
      connectionContext(deps, tenantId, conn),
    );
    undoInput = read.input as JsonObject;
    replaces = read.before;
  } catch {
    return refuse("no_undo_input", "we can't work out how to put this back on our own");
  }
  const gate = await signedGateRefusal(deps, tenantId, {
    spec: target.spec,
    connector: target.connector,
    conn,
    agentId: run?.agentId ?? null,
    input: undoInput,
  });
  if (gate) return refuse("refused", gate);
  const { action } = await actions.proposeUndo(tenantId, {
    original,
    tool: undoTool,
    input: undoInput,
    before: replaces,
    approvedBy: input.by,
    idempotencyKey: undoKey(original.id),
  });
  return finishUndo(deps, tenantId, original, action);
}

/** Why the record couldn't be read for an undo, in the person's words. */
function readRefusal(error: unknown, spec: ToolSpec): { code: UndoOutcomeRefusal; reason: string } {
  if (error instanceof ToolCallError) {
    if (error.code === "permission_off") {
      return { code: "refused", reason: `${spec.verb} is off on this connection now` };
    }
    if (error.code === "not_connected" || error.code === "wrong_connection") {
      return { code: "unavailable", reason: "the connection needs signing in again first" };
    }
  }
  return {
    code: "read_failed",
    reason: "we couldn't read the record just now; try again in a minute",
  };
}

/** Runs (or reports) the undo action once: executeAction keys it, so a retry never writes twice. */
async function finishUndo(
  deps: RuntimeDeps,
  tenantId: string,
  original: ExternalActionRecord,
  undo: ExternalActionRecord,
): Promise<UndoOutcome> {
  const out = await executeAction(deps, { tenantId, actionId: undo.id });
  switch (out.status) {
    case "done":
      return { status: "done", original, undo: out.action, output: out.output };
    case "failed":
      return { status: "failed", original, undo: out.action, error: out.error };
    default:
      // An undo is recorded approved; anything else is not ours to run.
      return {
        status: "failed",
        original,
        undo: out.action,
        error: `the undo is ${out.action.status}`,
      };
  }
}
