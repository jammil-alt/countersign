// One tool call through the permission gate (ARCHITECTURE §9.5 step 5). Used by agent-mode loops,
// tool-mode skills and the executor's `action` steps alike, so every call is logged and gated the
// same way.

import {
  actionIsOn,
  BROWSE_NOTE_SCOPE,
  bindingKeyFor,
  browseHelpNote,
  builtInConnectorOf,
  builtInManifest,
  type ConnectionRef,
  captureBefore,
  isBrowseHelpTag,
  parseWriteInput,
  type RunSessions,
  runReadTool,
  standInOutput,
  ToolRefused,
} from "@countersign/connectors";
import {
  // Round 4 D
  amountOf,
  assigneeOf,
  autonomyMessage,
  batchKeyOf,
  changeFacts,
  decideToolCall,
  effectiveMode,
  entityCeiling,
  entityOfCall,
  explainWrite,
  fixedInputProblem,
  grantAllowsTool,
  hashJson,
  isAlwaysSigned,
  type JsonObject,
  levelFor,
  pickLocalized,
  recipientOf,
  releaseOf,
  releaseSettingProblem,
  routeApproval,
  type ToolSpec,
  thresholdReached,
  undiscussedFor,
  verifiesWrites,
  type WriteVerification,
} from "@countersign/core";
import type { RegisteredTool } from "../registry/tools";
import { recordWriteKey, recordWriteParts } from "../tools/records";
import { executeAction } from "./actions";
import { noteReconnect } from "./attention";
import { carryApproval } from "./carry";
import {
  asJsonObject,
  connectionContext,
  idempotencyKey,
  nextIdempotencyKey,
  type RuntimeDeps,
  type StepContext,
  signAllWrites,
} from "./context";
import { recordModelCall } from "./model-call";
import type { ExternalActionRecord, ToolCallStatus } from "./ports";
import { recordGrantRefusal } from "./record-grants";
import { verifyWrite } from "./verify";

export type ToolOutcome =
  | {
      status: "done";
      output: unknown;
      summary?: string | undefined;
      actionId?: string;
      /** v0.12 W1-E: a retry's write carried from the run retried (`approved_via: retry_of`). */
      carried?: { retryOf: string };
    }
  /**
   * A write waiting for a person: the action and its inbox item. `recorded`: the step's change
   * found under this call's key had another input (follow-up 3); the step waits on that change,
   * and the model is told what it is.
   */
  | {
      status: "awaiting_approval";
      actionId: string;
      inboxItemId: string | null;
      before: unknown;
      recorded?: RecordedChange;
      /** A save to our own records waiting for a signature: `actionId` is its card's id. */
      recordSave?: true;
    }
  /**
   * Test runs: the write was recorded as proposed and will never run. `standIn`: what the tool
   * says it would have returned (docs/plan.md §1.94), for later steps; absent when it says nothing.
   */
  | {
      status: "would_have_done";
      actionId: string;
      before: unknown;
      standIn?: unknown;
      /** §1.212: the verifier's outcome on the write, kept on a test run's step (the evals). */
      verification?: WriteVerification;
    }
  /**
   * The connection needs a person to release it (docs/plan.md §1.26): a code went to them and their
   * inbox item is open. The step waits; once released, it runs again from the start.
   */
  | { status: "awaiting_release"; releaseId: string; inboxItemId: string; connectionId: string }
  | { status: "refused"; reason: string }
  /**
   * `actionId`: a carried write that failed (its tool call names the action, `stepWrites`).
   * `stopsStep`: the step can't go on (a retry calling another tool where its first try made a
   * change under the same key): an agent loop fails the step rather than tell the model.
   */
  | { status: "failed"; error: string; actionId?: string; stopsStep?: true }
  /**
   * Follow-up 1: the change was claimed by an earlier try that may have stopped mid-write. The
   * step stops and waits until that claim's lease runs out (`leaseEndsAt`, ISO, by the database),
   * then runs again and takes the change over under its key. Nothing was sent by this call.
   */
  | { status: "busy"; actionId: string; leaseEndsAt: string | null }
  /**
   * Follow-up 3: the step already has a change under this call's key, made with another input
   * (a retry whose model asked differently). Nothing was done for this call; the model is told
   * what the step's change is, as data.
   */
  | { status: "recorded"; actionId: string; change: RecordedChange };

/** A change a step already has, as its model is told it (follow-up 3): data, never instructions. */
export interface RecordedChange {
  tool: string;
  input: unknown;
  status: "done" | "waiting for approval" | "being made" | "failed" | "turned down";
  result?: unknown;
  error?: string;
  note: string;
}

const RECORDED_NOTE =
  "This step already has this change; it was not made again. If you meant a different change, finish and say so instead of repeating it.";

/** The step's change as its model is told it. */
export function recordedChange(
  action: Pick<ExternalActionRecord, "tool" | "status" | "result" | "error"> & { input: unknown },
): RecordedChange {
  const status: RecordedChange["status"] =
    action.status === "done"
      ? "done"
      : action.status === "proposed" || action.status === "approved"
        ? "waiting for approval"
        : action.status === "executing"
          ? "being made"
          : action.status === "rejected"
            ? "turned down"
            : "failed";
  const error = (action.error as { message?: unknown } | null)?.message;
  return {
    tool: action.tool,
    input: action.input,
    status,
    ...(status === "done" ? { result: action.result } : {}),
    ...(status === "failed" && typeof error === "string" ? { error } : {}),
    note: RECORDED_NOTE,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LOG_STATUS: Record<ToolOutcome["status"], ToolCallStatus> = {
  done: "succeeded",
  awaiting_approval: "awaiting_approval",
  would_have_done: "awaiting_approval",
  // DECISION: tool_call has no release status; a call waiting for a release is logged as
  // waiting (`awaiting_approval`) with `{status: "awaiting_release", releaseId}` as its output.
  awaiting_release: "awaiting_approval",
  refused: "refused",
  failed: "failed",
  // Review 2, item 7: the step waits for an earlier try's claim to run out. No approval is asked
  // for, so it is logged as still running (its output says what it waits for), never as an
  // approval wait. DECISION: no new tool_call status (that would need a migration).
  busy: "running",
  // Follow-up 3: nothing was done for this call; the step's change stands as it is.
  recorded: "refused",
};

export interface CallToolInput {
  toolId: string;
  input: unknown;
  /**
   * Review 2, item 5: the input is the step's own (an action step, a tool-mode skill's handler),
   * never a model's. A change found under the call's key with another input is then reported
   * (`recorded`) and never settled on: the caller fails the step.
   */
  ownInput?: boolean;
  /** The tools this call may use (the skill's tools plus extraTools); absent = any registered. */
  allowed?: ReadonlySet<string>;
  /**
   * v0.16 (docs/plan.md §1.86): what this skill run may reach, narrower than its tools: a browsing
   * skill's sites and pages (connectors' `BrowseScope`). Checked before the gate; never loosens it.
   */
  scope?: ToolCallScope | undefined;
}

/**
 * A narrowing of one skill run's tool calls, kept across its calls. Generic: the runtime names no
 * connector; a browsing skill's is `BrowseScope` (packages/connectors/src/browser/scope.ts).
 */
export interface ToolCallScope {
  /** Refuse the call, or the input to call with (only ever narrowed). Before the gate. */
  check(
    toolId: string,
    input: unknown,
  ): { ok: true; input: unknown } | { ok: false; reason: string };
  /** After the call, refusals included (the scope's own, the gate's, the tool's). */
  observe?(toolId: string, input: unknown, outcome: ToolOutcome): void;
  /**
   * Once a live skill run finished with an answer: what to keep, given the agent's live notes in
   * `noteScope` (applied by `finishScope`; a test run keeps nothing).
   */
  finish?(notes: readonly string[]): Promise<ScopeEffects> | ScopeEffects;
  /**
   * The memory scope the scope keeps its own notes in (read and written by `finishScope`), apart
   * from the agent's notes the model reads (`agent`). Absent: `agent`.
   */
  noteScope?: string | undefined;
  /** What connectors may keep open across the run's calls (a signed-in browser per site). */
  sessions?: RunSessions | undefined;
  /** Closes what `sessions` holds; the runtime calls it once the run ends, however it ends. */
  close?(): Promise<void>;
}

/** What a scope asks the platform to keep after a live skill run (`finishScope` applies it). */
export interface ScopeEffects {
  /** Notes in the scope's `noteScope`. */
  memory?: string[] | undefined;
  /**
   * An operator `review` item, such as a script draft. With `once`, a note that marks it offered:
   * written first, and the item is created only by the run whose note is the earliest such one
   * read back, so two runs finishing together offer it once.
   */
  operatorItem?:
    | { title: string; subjectType: string; payload: JsonObject; once?: string | undefined }
    | undefined;
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
  // An asked agent only reads: no platform records, no writes to a client's tool, not even
  // proposed ones (docs/plan.md §1.28).
  if (step.readOnly && tool.spec.sideEffect !== "none") {
    return { status: "refused", reason: `${call.toolId} writes, and an asked agent only reads` };
  }
  // v0.16: the skill run's scope (a browsing skill's sites and pages), before anything else runs.
  const scoped = call.scope ? call.scope.check(call.toolId, call.input) : null;
  const input = scoped?.ok ? scoped.input : call.input;
  const started = Date.now();
  const toolCallId = await log.startToolCall(step.tenantId, {
    stepRunId: step.stepRunId,
    tool: call.toolId,
    input,
  });
  let outcome: ToolOutcome;
  try {
    // v0.14 W4-A: a shared id (`whatsapp.send`) goes to the connector this agent is bound to.
    // Logged like any refused call: an attempt to leave the skill's pages is evidence.
    const resolved =
      scoped && !scoped.ok
        ? { refused: scoped.reason }
        : tool.kind === "connector"
          ? deps.tools.resolve(call.toolId, step.agent, input)
          : tool;
    if ("refused" in resolved) {
      outcome = { status: "refused", reason: resolved.refused };
    } else {
      // Refused by the platform's policy (e.g. HIPAA mode): logged like any refused call.
      const refusal = await deps.policy?.refuseTool({
        tenantId: step.tenantId,
        toolId: call.toolId,
        connectorId: resolved.kind === "connector" ? resolved.connector.manifest.id : null,
      });
      outcome = refusal
        ? { status: "refused", reason: refusal }
        : await dispatch(deps, step, resolved, input, call.scope?.sessions, call.ownInput);
    }
  } catch (error) {
    // DECISION (v0.16): a connector's own refusal (a site's pages, its sign-in caps) is a refusal,
    // as the gate's are, for every caller: nothing was done.
    outcome =
      error instanceof ToolRefused
        ? { status: "refused", reason: error.message }
        : { status: "failed", error: errorText(error) };
  }
  call.scope?.observe?.(call.toolId, input, outcome);
  // A record save's card names no external action (its id is the card's).
  const actionId =
    "actionId" in outcome && !(outcome.status === "awaiting_approval" && outcome.recordSave)
      ? outcome.actionId
      : undefined;
  await log.finishToolCall(step.tenantId, toolCallId, {
    status: LOG_STATUS[outcome.status],
    output:
      outcome.status === "done"
        ? // v0.12 W1-E: a carried write says whose approval it ran under (§10.10).
          outcome.carried
          ? { approvedVia: "retry_of", retryOf: outcome.carried.retryOf, output: outcome.output }
          : outcome.output
        : outcome.status === "refused"
          ? { refused: outcome.reason }
          : outcome.status === "failed"
            ? { error: outcome.error }
            : outcome.status === "awaiting_release"
              ? { status: outcome.status, releaseId: outcome.releaseId }
              : outcome.status === "busy"
                ? { status: "waiting_for_claim", leaseEndsAt: outcome.leaseEndsAt }
                : outcome.status === "recorded"
                  ? { alreadyRecorded: outcome.change }
                  : outcome.status === "awaiting_approval" && outcome.recorded
                    ? { status: outcome.status, alreadyRecorded: outcome.recorded }
                    : outcome.status === "would_have_done" && outcome.standIn !== undefined
                      ? { status: outcome.status, standIn: true, output: outcome.standIn }
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
  sessions: RunSessions | undefined,
  ownInput?: boolean,
): Promise<ToolOutcome> {
  // A retry finds its first try's action before any check, the fixed-input check included.
  if (tool.kind === "connector" && tool.spec.sideEffect === "external") {
    const resumed = await resumeProposed(deps, step, tool, input, ownInput === true);
    if (resumed) return resumed;
  }
  // Inputs that become instructions are the step's own fixed text, before any approval card or
  // write: never a template's value or a model's words (invariant 9).
  const fixed = tool.spec.fixedInputs;
  if (fixed?.length) {
    const problem = fixedInputProblem(fixed, step.literalInput, input);
    if (problem) return { status: "refused", reason: `${tool.spec.id}: ${problem}` };
  }
  if (tool.kind === "internal") {
    // Skill model (2026-11-10): a tool that calls a model says so (`usesModel`); one that doesn't
    // and records a model call's cost is reported (recorded all the same, so no cost is lost).
    const modelUsed = () => {
      if (tool.spec.usesModel !== undefined) return;
      if (deps.onUndeclaredModelCall) deps.onUndeclaredModelCall(tool.spec.id);
      else
        deps.logger?.warn("tool called a model without declaring usesModel", {
          toolId: tool.spec.id,
        });
    };
    // Step model E: a built-in connector's action (Web's search and page read) the operator turned
    // off on its page is refused, as a connector's is; read fresh like the matrix.
    const builtIn = builtInConnectorOf(tool.spec.id);
    if (builtIn && deps.ports.store.actionSwitches) {
      const switches = await deps.ports.store.actionSwitches(builtIn.id);
      if (!actionIsOn(builtInManifest(builtIn), tool.spec.id, switches)) {
        return { status: "refused", reason: `${tool.spec.id} is turned off for agents` };
      }
    }
    // Platform and pack tools write only the platform's own records: `none` and `internal` run.
    const parsed = tool.tool.input.safeParse(input);
    if (!parsed.success)
      return { status: "failed", error: `invalid input: ${parsed.error.message}` };
    // Step model §10f: a record type's standard action runs only within the agent version's
    // grant on that record type, and a Find within its grant on each record type it follows. The
    // grant is read from the pinned version only: nothing in a run widens it (invariant 9).
    const ungranted = recordGrantRefusal(step.agent, tool.spec, parsed.data);
    if (ungranted) return { status: "refused", reason: ungranted };
    // Signed record saves (follow-up to #687, invariant 8): a live run's record write runs on its
    // own only for an agent that acts and is live, on a step that adds no approver. Otherwise it
    // waits for a person's signature: the records port checks it against the record type's rules
    // now and puts one approval card per write key; the run resumes on the answer and the write is
    // made once, under its key (apps/api `runs/ports.ts`). A test run goes on: it checks and saves
    // nothing.
    const record = tool.spec.record;
    if (
      record &&
      (record.action === "create" || record.action === "update") &&
      step.mode !== "test"
    ) {
      const signed = await signedRecordSave(deps, step, tool.spec, record.action, parsed.data);
      if (signed) return signed;
    }
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
      documents: deps.ports.documents,
      // P-1: a pack tool's settings and services (docs/plan.md §1.63).
      settings: step.settings ?? {},
      ...(deps.packServices ? { packServices: deps.packServices } : {}),
      knowledge: deps.ports.knowledge,
      // B3: other agents' manuals for this client
      manuals: deps.ports.manuals,
      directory: deps.ports.directory,
      ledger: deps.ports.ledger,
      health: deps.ports.health,
      findings: deps.ports.findings,
      // v0.12 W1-C
      threads: deps.ports.threads,
      // v0.12 W2-D
      account: deps.ports.account,
      // v0.12 W2-E
      inbound: deps.ports.inbound,
      // P-7: message translation
      translation: deps.ports.translation,
      // §1.77: web research
      web: deps.ports.web,
      // Step model §10f: the standard record actions.
      records: deps.ports.records,
      ask: step.ask,
      language: step.language,
      now: deps.now,
      // The cost is recorded first, then an undeclared call is reported: no cost is lost.
      recordUsage: async (usage) => {
        await deps.ports.log.addUsage(
          step.tenantId,
          { runId: step.runId, stepRunId: step.stepRunId },
          usage,
        );
        modelUsed();
      },
      // v0.12 W1-E: a tool's own model call (a document read) is the step's `model_call` too.
      recordModelCall: async (record, exchange) => {
        await recordModelCall(
          deps.ports.modelCalls,
          step.tenantId,
          {
            runId: step.runId,
            stepRunId: step.stepRunId,
            agentVersionId: step.agent.agentVersionId,
            action: "tool_call",
          },
          record,
          exchange,
        );
        modelUsed();
      },
    });
    const out = tool.tool.output.safeParse(raw);
    if (!out.success) return { status: "failed", error: `invalid output: ${out.error.message}` };
    return { status: "done", output: out.data };
  }

  const connectorId = tool.connector.manifest.id;
  // Bindings are keyed by connector, or by what the connector's `bindingKey` reads from the input
  // (a browser site, docs/plan.md §1.26); no special case for any connector here.
  const binding = bindingKeyFor(tool.connector, input);
  const connectionId = binding ? step.agent.bindings[binding] : undefined;
  // Read fresh on every call: a client's tightening applies at once, even mid-run (§1.2).
  const conn = connectionId ? await deps.ports.store.connection(step.tenantId, connectionId) : null;
  if (!conn) return { status: "refused", reason: `no ${connectorId} connection is bound` };
  // The agent's grant narrows the binding: a tool outside its subset is refused like an unbound
  // connector, and each verb's ceiling is the stricter of the matrix and the grant.
  const grant = await deps.ports.store.grant(step.tenantId, step.agent.agentId, conn.id);
  if (!grantAllowsTool(grant, tool.spec.id)) {
    return {
      status: "refused",
      reason: `${tool.spec.id} is not in this agent's access to the ${connectorId} connection`,
    };
  }
  // Step model E: an action the operator turned off on the connector's page is refused, whatever
  // the matrix, the grant, the step and the mode say; it only ever narrows (invariant 8).
  if (!actionIsOn(tool.connector.manifest, tool.spec.id, conn.actionSwitches)) {
    return { status: "refused", reason: `${tool.spec.id} is turned off for agents` };
  }
  // v0.12 W1-G: a send's recipient's autonomy for the channel is one more ceiling, read fresh.
  const recipient = recipientOf(tool.spec, input);
  const autonomy =
    recipient && deps.ports.store.contactAutonomy
      ? await deps.ports.store.contactAutonomy(step.tenantId, recipient)
      : null;
  // v0.12 W1-A: the go-live stage, read fresh like the matrix: in trial and signoff every write
  // needs a signature, whatever the step, matrix or mode say (ARCHITECTURE §10.9). Reads don't ask.
  // v0.12 W1-D: the stage is kept for the explanation (`whyApproval`).
  const stage =
    tool.spec.sideEffect === "external"
      ? await deps.ports.store.agentStage(step.tenantId, step.agent.agentId)
      : null;
  const mode =
    tool.spec.sideEffect === "external"
      ? effectiveMode(step.agent.bundle.definition, stage)
      : step.agent.bundle.definition.permissions.mode;
  // docs/plan.md §1.124: the safety hold, read fresh like the stage: while held, every write waits
  // for a person (an approval ceiling, which only tightens: invariant 8). Test runs are unchanged.
  const held =
    tool.spec.sideEffect === "external" && step.mode !== "test" && deps.ports.store.agentHold
      ? await deps.ports.store.agentHold(step.tenantId, step.agent.agentId)
      : false;
  const ceilings = [...(autonomy ? [autonomy] : []), ...(held ? (["approval"] as const) : [])];
  const decision = decideToolCall({
    sideEffect: tool.spec.sideEffect,
    verb: tool.spec.verb,
    matrix: conn.permissions,
    grant,
    stepApproval: step.approval?.required,
    agentMode: mode,
    ceilings: ceilings.length > 0 ? ceilings : undefined,
    // v0.12 W2-A: the entity and its scope, on the connection and the grant.
    entity: { tool: tool.spec, input, declared: tool.connector.manifest.permissionEntities },
    // §1.73: publishing, posting: a person signs every one.
    alwaysSigned: isAlwaysSigned(tool.spec),
  });
  // v0.12 W1-G: the person's own setting refuses before the matrix's words would.
  if (decision === "refused" && recipient && autonomy === "off") {
    return { status: "refused", reason: autonomyMessage(recipient.channel, "off") };
  }
  // ── v0.12 W2-A: per-entity permissions (docs/plan.md §1.44) ──────────────────────────────────
  // The entity the call works on, for the refusal's words and the explanation of a wait.
  const entity = entityOfCall(tool.spec, input);
  if (decision === "refused" && entity !== undefined) {
    const verb = tool.spec.sideEffect === "none" ? "read" : tool.spec.verb;
    const onConnection = entityCeiling({
      tool: { ...tool.spec, verb },
      input,
      declared: tool.connector.manifest.permissionEntities,
      matrix: conn.permissions,
    });
    if (levelFor(conn.permissions, verb) !== "off" && onConnection === "off") {
      return {
        status: "refused",
        reason:
          entity === null
            ? `${tool.spec.id} names a record type the ${connectorId} connection doesn't know`
            : `${tool.spec.id} is off for ${entity} on the ${connectorId} connection`,
      };
    }
  }
  // ── end v0.12 W2-A ──────────────────────────────────────────────────────────────────────────
  if (decision === "refused") {
    const verb = tool.spec.sideEffect === "none" ? "read" : tool.spec.verb;
    return {
      status: "refused",
      reason:
        levelFor(conn.permissions, verb) === "off"
          ? `${tool.spec.verb} is off on the ${connectorId} connection`
          : `${tool.spec.verb} is off in this agent's access to the ${connectorId} connection`,
    };
  }
  // Human release (docs/plan.md §1.26): a connection that needs a person's release is used only
  // under a live release; without one the step asks the person for a code and waits. Test runs
  // too: a test reads the client's real data.
  const waiting = await releaseGate(deps, step, conn, tool.spec.id);
  if (waiting) return waiting;
  const ctx = connectionContext(deps, step.tenantId, conn, step.agent.agentId);
  if (tool.spec.sideEffect !== "external") {
    // v0.16: a scoped run's reads may share what the connector keeps open (one browser per site).
    const readCtx = sessions ? { ...ctx, sessions } : ctx;
    try {
      const r = await runReadTool(tool.connector, tool.spec.id, input, readCtx);
      return { status: "done", output: r.output, summary: r.summary };
    } catch (error) {
      await noteReconnect(deps, step.tenantId, conn, error);
      throw error;
    }
  }

  // A write to the client's tool: always an external_action, with its before state.
  // DECISION (test runs never write, invariant 8): a test run's write on what an earlier unmade
  // write would have returned (a stand-in id) names a record that only exists in a live run, so
  // its before state isn't read from the client's tool (it would fail, or read the wrong record):
  // the input is still checked, and the change is recorded with no before state.
  const captured = await captureBefore(tool.connector, tool.spec.id, input, ctx, {
    skipBefore: step.mode === "test" && step.afterUnwritten === true,
  });
  // v0.12 W1-E: a retry carries the run retried's approved, not-done write with the same input,
  // under its original key; the gate above (stage included) has just allowed the write again.
  const carried = await carryApproval(deps, step, tool.spec.id, captured.input, decision);
  if (carried) return carried;
  const key = idempotencyKey(step);
  const test = step.mode === "test";
  // Round 4 D (docs/plan.md §1.211): the verifier works the write out again from the run's
  // sources, on agents whose `oversight.verify` is `writes` (saved on the definition: an agent
  // made before stays off). Test runs too: they never write, and the check is what they test.
  const verification = verifiesWrites(step.agent.bundle.definition.oversight)
    ? await verifyWrite(deps, {
        tenantId: step.tenantId,
        runId: step.runId,
        stepRunId: step.stepRunId,
        stepId: step.stepId,
        agent: step.agent,
        spec: tool.spec,
        proposed: captured.input,
      })
    : null;
  // Read fresh for each proposal, so a client's tightening applies to the next write at once.
  const routing = test ? null : await deps.ports.store.approvalRouting(step.tenantId);
  // Round 4 D: the client's dollar threshold: at or over it, a person signs (only tightens).
  const threshold = thresholdReached(
    routing?.thresholds ?? [],
    amountOf(tool.spec, captured.input),
  );
  // Follow-up 3: after a call that didn't match the step's change under its key, every write of
  // this try waits for a person, whatever the step, matrix and mode say (only tightens).
  // Round 4 D: so does a write the verifier didn't agree with, or one at a threshold.
  const automatic =
    decision === "run" &&
    !test &&
    step.signAllWrites !== true &&
    threshold === null &&
    (verification === null || verification.outcome === "agreed");
  // Who approves (never whether: that was decided above, invariant 8).
  let approver: ReturnType<typeof routeApproval> | null = null;
  let revision = 0;
  if (!automatic && routing) {
    revision = routing.revision;
    approver = routeApproval({
      rules: routing.rules,
      facts: changeFacts({
        spec: tool.spec,
        connector: connectorId,
        agentId: step.agent.agentId,
        input: captured.input,
      }),
      step: step.approval?.approver,
      agent: [step.agent.bundle.definition.permissions.approver, step.agent.approver],
      client: routing.clientDefault,
      members: routing.members,
    });
    // Round 4 D: a write the verifier couldn't work out goes to the operator, who can see why.
    // DECISION (§1.211): a disagreement stays with the client's own approver, with both answers.
    if (verification?.outcome === "cannot_verify") {
      const operator = { kind: "operator" } as const;
      approver = { ...approver, approver: operator, assignee: assigneeOf(operator) };
    }
  }
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
          // DECISION: the item's title is the tool's plain line for people (its display
          // description) when it declares one, else its description; never its id, which is
          // not for clients. The card renders the title in the reader's language from the spec.
          title: tool.spec.display?.description
            ? pickLocalized(tool.spec.display.description)
            : tool.spec.description,
          agentId: step.agent.agentId,
          ...approver.assignee,
          payload: {
            tool: tool.spec.id,
            verb: tool.spec.verb,
            connector: connectorId,
            connectionId: conn.id,
            input: captured.input as JsonObject[string],
            before: (captured.before ?? null) as JsonObject[string],
            stepId: step.stepId,
            // B3 (docs/builder-plan.md §5): the decisions this step rests on that nobody has
            // discussed yet, from the agent's manual, so the card says so. Never loosens.
            ...undiscussedPayload(step),
            onReject: step.approval?.onReject ?? "stop",
            // Round 4 D (§1.211): the verifier's outcome (both answers where they differ) and the
            // threshold that made it wait. No note, model or cost: the portal shows the payload.
            ...(verification ? { verification: verification as JsonObject[string] } : {}),
            ...(threshold ? { threshold: threshold as JsonObject[string] } : {}),
            // What chose the approver: a rule (with the rules' revision), the step, the agent,
            // the client's default, or the default (the client admin).
            approverRoute: { source: approver.source, ruleId: approver.ruleId, revision },
            // v0.12 W1-D: why it waits, over the gate's own inputs (core explainWrite); the
            // gate's decision above is unchanged.
            whyApproval: explainWrite({
              verb: tool.spec.verb,
              matrix: conn.permissions,
              grant,
              stepApproval: step.approval?.required,
              // The mode the gate used, the definition's own and the stage that forced it.
              agentMode: mode,
              definitionMode: step.agent.bundle.definition.permissions.mode,
              stage,
              // v0.12 W1-G: the recipient's autonomy (reason `person` when it is `approval`).
              person: autonomy,
              route: { source: approver.source, ruleId: approver.ruleId },
              // v0.12 W2-A: the entity, named when its own setting asked.
              entity,
              // §1.73
              alwaysSigned: isAlwaysSigned(tool.spec),
              // §1.124: on a safety hold.
              held,
              // Review 2, item 2: a retry's write signed because of an earlier change, which
              // the card names so the person checks it first.
              retry: step.signedBecause ?? null,
            }) as JsonObject,
          },
          // v0.12 W1-D: the items one step proposes are signed together.
          batchKey: batchKeyOf(step.runId, step.stepId),
        }
      : null,
  });
  const settled = await settle(deps, step, tool, action);
  // §1.212: a test run routes no person, so its verification would go nowhere: it stays on the
  // step's output, which the eval harness scores (the verifier's agreement).
  if (settled.status === "would_have_done" && verification) return { ...settled, verification };
  return settled;
}

/**
 * B3 (docs/builder-plan.md §5): the approval card's never-discussed decisions: those in the agent's
 * manual that shape this step and nobody has discussed yet. Nothing when there are none, so a card
 * without them is the same as before.
 */
export function undiscussedPayload(step: Pick<StepContext, "agent" | "stepId">): JsonObject {
  const list = undiscussedFor(step.agent.bundle.definition, step.stepId);
  return list.length > 0
    ? { undiscussed: list.map((d) => ({ id: d.id, what: d.what })) as JsonObject[string] }
    : {};
}

/**
 * Null when the call may go on: the connection needs no release, or a live release covers this
 * agent in this run. Otherwise the request (a code sent, an inbox item) or why none could be made.
 */
export async function releaseGate(
  deps: RuntimeDeps,
  step: StepContext,
  conn: ConnectionRef,
  toolId: string,
): Promise<Extract<ToolOutcome, { status: "awaiting_release" | "refused" }> | null> {
  const setting = releaseOf(conn.config);
  if (setting.mode !== "code") return null;
  const name = conn.connector;
  const problem = releaseSettingProblem(setting);
  if (problem) return { status: "refused", reason: `${name}: ${problem}` };
  // An asked agent never asks a person for a release (docs/plan.md §1.28).
  if (step.readOnly) {
    return {
      status: "refused",
      reason: `the ${name} connection needs a person to release it, and an ask never asks for one`,
    };
  }
  const port = deps.ports.release;
  // DECISION: without the release port (a voice call's tools) a connection that needs a release
  // refuses: nothing there can wait for a person's code.
  if (!port) {
    return {
      status: "refused",
      reason: `the ${name} connection needs a person to release it, and that can't be asked for here`,
    };
  }
  const ask = { connection: conn, agentId: step.agent.agentId, runId: step.runId };
  if (await port.covers(step.tenantId, ask)) return null;
  const requested = await port.request(step.tenantId, {
    ...ask,
    stepRunId: step.stepRunId,
    toolId,
    test: step.mode === "test",
  });
  if ("refused" in requested) return { status: "refused", reason: requested.refused };
  return {
    status: "awaiting_release",
    releaseId: requested.releaseId,
    inboxItemId: requested.inboxItemId,
    connectionId: conn.id,
  };
}

/**
 * A retried step (a crash, a Workflow retry) finds the action its first try proposed under the
 * same key and resumes or returns it, before any proposal check: fixed inputs, the matrix, the
 * before state and the connector's consent checks only apply to a new action. Otherwise an opt-out since the first
 * try would fail the step and leave the action `executing`, though its write may have gone out.
 * The connector's `run` still checks every write it hasn't made yet.
 */
// DECISION: on a retry the action found by key stands as it is (docs/plan.md §1.22); a person's
// approval path runs it directly (executeAction) and is unchanged.
// DECISION (audit 3.1): keys are positional (`<run>:<step>:<index>`), and a model asked again may
// call its tools in another order or with other inputs. The action found by key is resumed only
// when this call is the same write: the same tool and the same input, compared as the tool reads
// it (its Zod input, defaults filled in, as `captureBefore` stored it), in canonical JSON.
// Another tool there fails the step (`stopsStep`).
// DECISION (follow-up 3, the lead's): another input is neither failed nor silently reused. The
// key is taken and nothing is done for this call: the model is told the step's change as data
// (tool, input, where it stands) and asked to finish rather than repeat it. A change still waiting
// (proposed, or approved and not made) is settled on as before, so the person approves what they
// saw. From then on in this try, every write the model proposes waits for a person
// (`signAllWrites`): it only tightens (invariant 8).
async function resumeProposed(
  deps: RuntimeDeps,
  step: StepContext,
  tool: RegisteredTool,
  input: unknown,
  ownInput: boolean,
): Promise<ToolOutcome | null> {
  const existing = await deps.ports.actions.byKey(step.tenantId, nextIdempotencyKey(step));
  if (!existing) return null;
  idempotencyKey(step); // taken, as proposing would have
  if (existing.tool !== tool.spec.id) {
    return {
      status: "failed",
      error: `this step's change ${existing.idempotencyKey} was proposed for ${existing.tool}, and this try called ${tool.spec.id} in its place: check the step's changes before trying again`,
      stopsStep: true,
    };
  }
  if (await sameWrite(tool, input, existing.input)) return settle(deps, step, tool, existing);
  // Review 2, item 5: an input that is the step's own never settles on another one's card or
  // write: the caller fails the step, naming it.
  if (ownInput) {
    return { status: "recorded", actionId: existing.id, change: recordedChange(existing) };
  }
  signAllWrites(step, { code: "retry_reworded", actionId: existing.id, runId: existing.runId });
  return recordedOutcome(deps, step, tool, existing);
}

/**
 * What a call that isn't the step's change under its key gets (follow-up 3): a change still
 * waiting is settled on as before, the model told what it is; any other is described, untouched.
 */
async function recordedOutcome(
  deps: RuntimeDeps,
  step: StepContext,
  tool: RegisteredTool,
  existing: ExternalActionRecord,
): Promise<ToolOutcome> {
  // Review 2, item 1: a change claimed by an earlier try that may have stopped mid-write is taken
  // over as recorded (its own input, under its key) once the claim runs out, as for a matching
  // call: the step waits (`busy`) meanwhile, so it never ends with the change left claimed.
  if (
    existing.status === "proposed" ||
    existing.status === "approved" ||
    existing.status === "executing"
  ) {
    const settled = await settle(deps, step, tool, existing);
    if (settled.status === "awaiting_approval") {
      return { ...settled, recorded: recordedChange(existing) };
    }
    if (settled.status === "busy" || settled.status === "would_have_done") return settled;
    // Executed (or turned down) just now: told as it stands.
    const now = (await deps.ports.actions.get(step.tenantId, existing.id)) ?? existing;
    return { status: "recorded", actionId: existing.id, change: recordedChange(now) };
  }
  return { status: "recorded", actionId: existing.id, change: recordedChange(existing) };
}

/** Whether a call's input is the write an action recorded (`input`, the agent's, never an edit). */
async function sameWrite(tool: RegisteredTool, input: unknown, recorded: unknown) {
  if (tool.kind !== "connector") return false;
  let parsed: unknown;
  try {
    parsed = parseWriteInput(tool.connector, tool.spec.id, input);
  } catch {
    return false;
  }
  // Through JSON, as the stored input went: a parsed Date (say) compares as the string stored.
  const asStored = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as unknown;
  return (await hashJson(asStored(asJsonObject(parsed)))) === (await hashJson(asStored(recorded)));
}

/** What a proposed action means for the step now: waiting, refused, or executed once. */
async function settle(
  deps: RuntimeDeps,
  step: StepContext,
  tool: RegisteredTool,
  action: ExternalActionRecord,
): Promise<ToolOutcome> {
  if (step.mode === "test") {
    // DECISION (docs/plan.md §1.94): a test run's write hands later steps the tool's stand-in
    // output, so the rest of the flow runs; the tool's own pure function, never the provider.
    const standIn =
      tool.kind === "connector"
        ? standInOutput(tool.connector, tool.spec.id, action.input)
        : undefined;
    return {
      status: "would_have_done",
      actionId: action.id,
      before: action.before,
      ...(standIn === undefined ? {} : { standIn }),
    };
  }
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
      // Audit 3.2: an earlier try claimed it and may have stopped mid-write. This try never sends
      // it too; the step waits for that claim's lease and runs again (follow-up 1).
      if (r.status === "busy") {
        return { status: "busy", actionId: action.id, leaseEndsAt: r.leaseEndsAt };
      }
      return {
        status: "awaiting_approval",
        actionId: action.id,
        inboxItemId: action.inboxItemId,
        before: action.before,
      };
    }
  }
}

/**
 * A platform write the runtime makes itself, logged as the platform tool that makes it would be
 * (a `tool_call` row on the step run, its input and what it wrote), so the step's log shows it.
 * Best effort: a write that fails is logged as failed and answers null.
 */
async function loggedWrite<T extends JsonObject>(
  deps: RuntimeDeps,
  step: StepContext,
  tool: "memory.write" | "inbox.create",
  input: JsonObject,
  write: () => Promise<T>,
): Promise<T | null> {
  const { log } = deps.ports;
  const started = Date.now();
  const id = await log.startToolCall(step.tenantId, { stepRunId: step.stepRunId, tool, input });
  try {
    const output = await write();
    await log.finishToolCall(step.tenantId, id, {
      status: "succeeded",
      output,
      durationMs: Date.now() - started,
    });
    return output;
  } catch (error) {
    await log.finishToolCall(step.tenantId, id, {
      status: "failed",
      output: { error: errorText(error) },
      durationMs: Date.now() - started,
    });
    return null;
  }
}

/** One platform note in a memory scope, logged on the step run as `memory.write`. */
function writeScopeNote(deps: RuntimeDeps, step: StepContext, scope: string, note: string) {
  return loggedWrite(deps, step, "memory.write", { note, scope }, async () => {
    const saved = await deps.ports.platform.writeMemory(step.tenantId, {
      agentId: step.agent.agentId,
      note,
      scope,
    });
    return { memoryNoteId: saved.id };
  });
}

/**
 * v0.16: once a scoped live skill run finished with an answer, keeps what its scope asks: notes in
 * the scope's own memory scope (`noteScope`) and an operator `review` item (a browsing path that
 * worked twice, offered as a script draft), offered once. Reads the notes itself, whether or not
 * the agent shows memory to its model. Each write is logged on the step run like a platform
 * tool's. A test run keeps nothing: its notes would never be read back (memory reads skip test
 * scopes), and the skill bench never writes.
 */
// DECISION: a draft is an inbox item for the operator, as the owner's proposals are (kind
// `review`), not a new table: scripts are R9's, and the operator reviews the draft there.
// DECISION: offered once without a lock or a unique key (no migration): the run writes the
// offer's note first, reads the notes back, and creates the item only when its note is the
// earliest of them (memoryNotes' order: created, then id). Of two runs that finish together,
// both read back both notes and only the earlier one's run offers it. Should creating the item
// fail, its note stays and the draft is not offered again: the failed `inbox.create` row on the
// step run records it (a missed offer rather than a second one).
export async function finishScope(
  deps: RuntimeDeps,
  step: StepContext,
  scope: ToolCallScope,
): Promise<ScopeEffects> {
  if (!scope.finish || step.mode === "test") return {};
  const { store, platform } = deps.ports;
  const noteScope = scope.noteScope ?? "agent";
  const notes = () => store.memoryNotes(step.tenantId, step.agent.agentId, 50, noteScope);
  const writeNote = (note: string) => writeScopeNote(deps, step, noteScope, note);
  const effects = await scope.finish((await notes()).map((n) => n.note));
  for (const note of effects.memory ?? []) await writeNote(note);
  const item = effects.operatorItem;
  if (!item) return effects;
  if (item.once !== undefined) {
    const mine = await writeNote(item.once);
    if (!mine) return effects;
    // Newest first: the earliest marker read back is the last.
    const earliest = (await notes()).filter((n) => n.note === item.once).at(-1);
    if (earliest?.id !== mine.memoryNoteId) return effects;
  }
  const payload: JsonObject = {
    ...item.payload,
    stepId: step.stepId,
    agentVersionId: step.agent.agentVersionId,
  };
  await loggedWrite(
    deps,
    step,
    "inbox.create",
    { kind: "review", title: item.title, subjectType: item.subjectType, assignee: "operator" },
    async () => {
      const created = await platform.createInboxItem(step.tenantId, {
        kind: "review",
        title: item.title,
        payload,
        agentId: step.agent.agentId,
        runId: step.runId,
        subjectType: item.subjectType,
        assigneeRole: "operator",
      });
      return { inboxItemId: created.id, title: item.title };
    },
  );
  return effects;
}

/** The lead's answer to a browsing skill's help request (the executor's `needsHelp`). */
export interface BrowseHelpAnswer {
  /** `needsHelp.remember`: the help request's tag (connectors' `browseHelpTag`). */
  remember: string;
  question: string;
  answer: string;
}

/**
 * v0.16: keeps the lead's answer to a browsing skill's help request where the next run of the same
 * skill on the same sites gets it as data: a platform note in the browse scope's own memory scope
 * (`browse`), which the model's `memory.write` never reaches, logged on the step run. A test run
 * keeps nothing (its notes are never read back). Throws when the tag isn't a help request's or
 * the note wasn't saved.
 */
// DECISION: the platform's write, not the model's: answers are read back only from the `browse`
// scope, so a note a model saves in its own memory (from a page's text, say) never reads as a
// person's answer (invariant 9).
export async function keepBrowseHelp(
  deps: RuntimeDeps,
  step: StepContext,
  help: BrowseHelpAnswer,
): Promise<{ memoryNoteId: string } | null> {
  if (!isBrowseHelpTag(help.remember)) throw new Error("not a help request's tag");
  if (step.mode === "test") return null;
  const note = browseHelpNote(help.remember, help.question, help.answer);
  const saved = await writeScopeNote(deps, step, BROWSE_NOTE_SCOPE, note);
  if (!saved) throw new Error("the note wasn't saved");
  return saved;
}

/**
 * Signed record saves: whether a live record write waits for a person, and if so its card (or
 * what an earlier try of the same write came to). Null: the write runs now, unsigned.
 */
async function signedRecordSave(
  deps: RuntimeDeps,
  step: StepContext,
  spec: ToolSpec,
  action: "create" | "update",
  input: unknown,
): Promise<ToolOutcome | null> {
  const stage = await deps.ports.store.agentStage(step.tenantId, step.agent.agentId);
  const acts = effectiveMode(step.agent.bundle.definition, stage) === "act";
  // DECISION (review of #696): a step asks only through its own approval check (an approver the
  // operator added), carried from the stored step as `ownApproval`; never the default the executor
  // fills in for a step with none (every skill step's, and a Save output's with no checks).
  const stepAsks = step.ownApproval === true && step.approval?.required === "required";
  if (acts && !stepAsks && step.signAllWrites !== true) return null;
  const why = !acts
    ? stage === "live"
      ? "This agent suggests only: its saves to our records wait for you."
      : `This agent is in its ${stage ?? "bench"} stage: every save waits for you.`
    : "This step asks for an approval before it saves.";
  const records = deps.ports.records;
  if (!records?.propose) {
    return {
      status: "refused",
      reason: `${spec.id} waits for a person, and nothing here can ask one`,
    };
  }
  const parts = recordWriteParts(action, input);
  const key = await recordWriteKey(step, spec.id, input);
  const routing = await deps.ports.store.approvalRouting(step.tenantId);
  const route = routeApproval({
    rules: routing.rules,
    facts: changeFacts({ spec, connector: "records", agentId: step.agent.agentId, input }),
    step: step.approval?.approver,
    agent: [step.agent.bundle.definition.permissions.approver, step.agent.approver],
    client: routing.clientDefault,
    members: routing.members,
  });
  const out = await records.propose(step.tenantId, {
    recordType: spec.record?.type ?? "",
    action,
    ...(parts.id ? { id: parts.id } : {}),
    values: parts.values,
    meta: {
      agentVersionId: step.agent.agentVersionId,
      runId: step.runId,
      stepRunId: step.stepRunId,
      key,
      sources: parts.sources,
      mode: step.mode,
    },
    agentId: step.agent.agentId,
    why,
    assignee: route.assignee,
  });
  if (out.status === "done") return { status: "done", output: out.record };
  if (out.status === "rejected") {
    return { status: "refused", reason: `a person turned this save down (${spec.id})` };
  }
  return {
    status: "awaiting_approval",
    actionId: out.inboxItemId,
    inboxItemId: out.inboxItemId,
    before: null,
    recordSave: true,
  };
}
