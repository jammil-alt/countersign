// One tool call through the permission gate (ARCHITECTURE §9.5 step 5). Used by agent-mode loops,
// tool-mode skills and the executor's `action` steps alike, so every call is logged and gated the
// same way.

import {
  bindingKeyFor,
  type ConnectionRef,
  captureBefore,
  type RunSessions,
  runReadTool,
  ToolRefused,
} from "@countersign/connectors";
import {
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
  isAlwaysSigned,
  type JsonObject,
  levelFor,
  pickLocalized,
  recipientOf,
  releaseOf,
  releaseSettingProblem,
  routeApproval,
} from "@countersign/core";
import type { RegisteredTool } from "../registry/tools";
import { memoryScope } from "../tools/memory-scope";
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
} from "./context";
import { recordModelCall } from "./model-call";
import type { ExternalActionRecord, ToolCallStatus } from "./ports";

export type ToolOutcome =
  | {
      status: "done";
      output: unknown;
      summary?: string | undefined;
      actionId?: string;
      /** v0.12 W1-E: a retry's write carried from the run retried (`approved_via: retry_of`). */
      carried?: { retryOf: string };
    }
  /** A write waiting for a person: the action and its inbox item. */
  | { status: "awaiting_approval"; actionId: string; inboxItemId: string | null; before: unknown }
  /** Test runs: the write was recorded as proposed and will never run. */
  | { status: "would_have_done"; actionId: string; before: unknown }
  /**
   * The connection needs a person to release it (docs/plan.md §1.26): a code went to them and their
   * inbox item is open. The step waits; once released, it runs again from the start.
   */
  | { status: "awaiting_release"; releaseId: string; inboxItemId: string; connectionId: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; error: string };

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
};

export interface CallToolInput {
  toolId: string;
  input: unknown;
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
   * Once the skill run finished with an answer: what to keep, given the agent's live notes in
   * `noteScope` (applied by `finishScope`).
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

/** What a scope asks the platform to keep after a skill run (`finishScope` applies it). */
export interface ScopeEffects {
  /** Notes in the scope's `noteScope` (a test run's stay in the run's own scope). */
  memory?: string[] | undefined;
  /**
   * An operator `review` item, such as a script draft; never from a test run. With `once`, a note
   * that marks it offered: written first, and the item is created only by the run whose note is
   * the earliest such one, so two runs finishing together offer it once.
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
        : await dispatch(deps, step, resolved, input, call.scope?.sessions);
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
  const actionId = "actionId" in outcome ? outcome.actionId : undefined;
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
): Promise<ToolOutcome> {
  // A retry finds its first try's action before any check, the fixed-input check included.
  if (tool.kind === "connector" && tool.spec.sideEffect === "external") {
    const resumed = await resumeProposed(deps, step, tool);
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
      documents: deps.ports.documents,
      // P-1: a pack tool's settings and services (docs/plan.md §1.63).
      settings: step.settings ?? {},
      ...(deps.packServices ? { packServices: deps.packServices } : {}),
      knowledge: deps.ports.knowledge,
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
      ask: step.ask,
      language: step.language,
      now: deps.now,
      recordUsage: (usage) =>
        deps.ports.log.addUsage(
          step.tenantId,
          { runId: step.runId, stepRunId: step.stepRunId },
          usage,
        ),
      // v0.12 W1-E: a tool's own model call (a document read) is the step's `model_call` too.
      recordModelCall: (record, exchange) =>
        recordModelCall(
          deps.ports.modelCalls,
          step.tenantId,
          {
            runId: step.runId,
            stepRunId: step.stepRunId,
            agentVersionId: step.agent.agentVersionId,
          },
          record,
          exchange,
        ),
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
  const decision = decideToolCall({
    sideEffect: tool.spec.sideEffect,
    verb: tool.spec.verb,
    matrix: conn.permissions,
    grant,
    stepApproval: step.approval?.required,
    agentMode: mode,
    ceilings: autonomy ? [autonomy] : undefined,
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
  const ctx = connectionContext(deps, step.tenantId, conn);
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
  const captured = await captureBefore(tool.connector, tool.spec.id, input, ctx);
  // v0.12 W1-E: a retry carries the run retried's approved, not-done write with the same input,
  // under its original key; the gate above (stage included) has just allowed the write again.
  const carried = await carryApproval(deps, step, tool.spec.id, captured.input, decision);
  if (carried) return carried;
  const key = idempotencyKey(step);
  const test = step.mode === "test";
  const automatic = decision === "run" && !test;
  // Who approves (never whether: that was decided above, invariant 8). Read fresh for each
  // proposal, so a client's tightening applies to the next approval at once.
  let approver: ReturnType<typeof routeApproval> | null = null;
  let revision = 0;
  if (!automatic && !test) {
    const routing = await deps.ports.store.approvalRouting(step.tenantId);
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
            onReject: step.approval?.onReject ?? "stop",
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
            }) as JsonObject,
          },
          // v0.12 W1-D: the items one step proposes are signed together.
          batchKey: batchKeyOf(step.runId, step.stepId),
        }
      : null,
  });
  return settle(deps, step, action);
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
async function resumeProposed(
  deps: RuntimeDeps,
  step: StepContext,
  tool: RegisteredTool,
): Promise<ToolOutcome | null> {
  const existing = await deps.ports.actions.byKey(step.tenantId, nextIdempotencyKey(step));
  if (!existing) return null;
  idempotencyKey(step); // taken, as proposing would have
  if (existing.tool !== tool.spec.id) {
    return {
      status: "failed",
      error: `this step's change ${existing.idempotencyKey} was proposed for ${existing.tool}`,
    };
  }
  return settle(deps, step, existing);
}

/** What a proposed action means for the step now: waiting, refused, or executed once. */
async function settle(
  deps: RuntimeDeps,
  step: StepContext,
  action: ExternalActionRecord,
): Promise<ToolOutcome> {
  if (step.mode === "test") {
    return { status: "would_have_done", actionId: action.id, before: action.before };
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

/**
 * v0.16: once a scoped skill run finished with an answer, keeps what its scope asks: notes in the
 * scope's own memory scope (`noteScope`; a test run's stay in the run's own scope, which no live
 * run reads) and, from a live run only, an operator `review` item (a browsing path that worked
 * twice, offered as a script draft), offered once. Reads the notes itself, whether or not the
 * agent shows memory to its model. Each write is logged on the step run like a platform tool's.
 */
// DECISION: a draft is an inbox item for the operator, as the owner's proposals are (kind
// `review`), not a new table: scripts are R9's, and the operator reviews the draft there.
// DECISION: offered once without a lock or a unique key (no migration): the run writes the
// offer's note first, reads the notes back, and creates the item only when its note is the only
// one. Of two runs that finish together, the later reader always sees the other's note, so they
// never both offer; at worst both step back and the draft is not offered.
export async function finishScope(
  deps: RuntimeDeps,
  step: StepContext,
  scope: ToolCallScope,
): Promise<ScopeEffects> {
  if (!scope.finish) return {};
  const { store, platform } = deps.ports;
  const noteScope = scope.noteScope ?? "agent";
  const test = step.mode === "test";
  const notes = () => store.memoryNotes(step.tenantId, step.agent.agentId, 50, noteScope);
  const writeNote = (note: string) =>
    loggedWrite(deps, step, "memory.write", { note, scope: noteScope }, async () => {
      const saved = await platform.writeMemory(step.tenantId, {
        agentId: step.agent.agentId,
        note,
        scope: test ? memoryScope(step.mode, step.runId) : noteScope,
      });
      return { memoryNoteId: saved.id };
    });
  const effects = await scope.finish((await notes()).map((n) => n.note));
  for (const note of effects.memory ?? []) await writeNote(note);
  const item = effects.operatorItem;
  if (!item || test) return effects;
  if (item.once !== undefined) {
    const mine = await writeNote(item.once);
    if (!mine) return effects;
    const marks = (await notes()).filter((n) => n.note === item.once);
    if (marks.length !== 1 || marks[0]?.id !== mine.memoryNoteId) return effects;
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
