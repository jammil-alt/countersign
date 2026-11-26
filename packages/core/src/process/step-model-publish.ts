// The step model (docs/step-model-plan.md §13a; stream A, publish checks): what a client agent's v5
// workflow is held to at publish, as a v4 process is (`checkApproval`, `checkActionLoose`). Each Do
// step's Change or Send action, and each write or save output's, must resolve to a connection the
// agent is bound to (merged actions included, resolved as the run resolves them), with the verb on
// in the client's matrix and the action switched on on its connector. A step or output whose
// approval is loosened (`not_required`, `when`, going ahead when nobody answers) is held to that
// connection allowing `auto` for the verb and the agent acting (invariant 8).
//
// Pure: the bound matrices, the agent's channels and the actions switched off come in the context.

import { levelFor } from "../permissions/decide";
import { bindingConnector } from "../permissions/grants";
import type { AgentDefinition } from "../schemas/agent";
import type { PermissionMatrix, Verb } from "../schemas/permissions";
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import { mergedAction } from "../steps/catalog";
import type { Workflow as StepWorkflow } from "../steps/schema";
import { eachStep } from "../steps/walk";
import {
  type CheckSink,
  checkEntityOff,
  type ValidationContext,
  VERB_NOUN,
} from "../workflow/validate";
import {
  ACCOUNTING_CONNECTORS,
  type ActionBindings,
  actionBindingsFromMatrices,
  actionTool,
  resolveActionConnector,
  type WriteAction,
} from "./actions";
import type { ProcessValidationCode, ProcessValidationContext } from "./validate";
import { approvalLoosenings, type Loosening } from "./validate";

/**
 * Merged actions that are today's write actions: they resolve from the agent's bindings or its
 * channel exactly as an action write step does (`STEP_MODEL_WRITE_ACTIONS` in the executor).
 */
const WRITE_ACTIONS: Readonly<Record<string, WriteAction>> = {
  "email.send": "send_email",
  "sms.send": "send_text",
  "accounting.bill.create": "create_bill",
  "accounting.vendor.create": "create_vendor",
};

const LOOSENED: Record<Loosening["what"], string> = {
  not_required: "",
  when: ": on every run, not only when conditions hold",
  proceed: ": a write can't go ahead without an answer",
  within_goal: ": every message needs a person's yes",
};

export interface StepModelPublishError {
  stepId: string;
  field: string;
  code: ProcessValidationCode;
  message: string;
}

type Matrix = Partial<PermissionMatrix> | undefined;

/** Where an action runs for this agent, or why it can't. */
type Resolved =
  | { ok: true; tool: string; connector: string; matrix: Matrix; spec: ToolSpec | undefined }
  | { ok: false; code: ProcessValidationCode; message: string }
  /** Which connection runs it is known only at the call (the agent's channel wasn't passed). */
  | { ok: "unknown" };

type Ctx = Pick<ValidationContext, "tools" | "publish"> & Pick<ProcessValidationContext, "actions">;

/**
 * The publish errors of one v5 workflow (empty unless `ctx.publish` is set: templates and drafts
 * aren't held to a client's connections).
 */
// DECISION: a Do step that another agent runs (`agent`) is that agent's, under its own bindings, and
// is not checked here; outputs are checked whether or not an End delivers them (one no End delivers
// is already a step-model issue).
export function stepModelPublishErrors(
  workflow: StepWorkflow,
  ctx: Ctx,
  agent: Pick<AgentDefinition, "permissions"> | undefined,
): StepModelPublishError[] {
  const publish = ctx.publish;
  if (!publish) return [];
  const errors: StepModelPublishError[] = [];
  const sink = {
    ctx,
    add: (stepId: string, field: string, code: ProcessValidationCode, message: string) =>
      errors.push({ stepId, field, code, message }),
  };
  // `checkEntityOff` reports v3's codes, which v4's include.
  const entitySink = sink as unknown as CheckSink & { ctx: Ctx };
  const check = (
    at: string,
    action: string,
    input: Record<string, unknown> | undefined,
    approval: Parameters<typeof approvalLoosenings>[0],
    field: string,
  ) => {
    const loose = approvalLoosenings(approval, "checks.approval");
    const r = resolve(action, ctx);
    if (r === null) return; // Not a Change or Send: nothing to hold to a connection.
    const spec = r.ok === true ? r.spec : ctx.tools?.[action];
    if (spec && isAlwaysSigned(spec)) {
      for (const l of loose) {
        sink.add(at, l.field, "approval_always", `"${spec.id}" always needs a person to sign it`);
      }
    }
    if (r.ok === "unknown") {
      for (const l of loose) {
        sink.add(
          at,
          l.field,
          "approval_required_by_connection",
          "which connection sends it is known only when it runs: approval stays on",
        );
      }
    } else if (r.ok === false) {
      sink.add(at, field, r.code, r.message);
    } else {
      const verb: Verb = r.spec?.verb ?? "create";
      const level = levelFor(r.matrix, verb);
      if (level === "off") {
        sink.add(
          at,
          field,
          "verb_off",
          `this connection doesn't allow ${VERB_NOUN[verb]} ("${r.tool}")`,
        );
      } else if (r.spec && checkEntityOff(entitySink, at, r.spec, r.connector, input, field)) {
        // Reported there.
      } else if (level !== "auto") {
        for (const l of loose) {
          sink.add(
            at,
            l.field,
            "approval_required_by_connection",
            `this connection requires approval for ${VERB_NOUN[verb]}${LOOSENED[l.what]}`,
          );
        }
      }
    }
    const mode = agent?.permissions?.mode;
    if (mode !== undefined && mode !== "act") {
      for (const l of loose) {
        sink.add(
          at,
          l.field,
          "approval_needs_act",
          "the agent only suggests: set its mode to act before a write runs without approval",
        );
      }
    }
  };

  eachStep(workflow.steps, ({ step }) => {
    if (step.kind !== "do" || step.agent !== undefined || step.uses?.type !== "action") return;
    if (step.doneBy !== "rules") return;
    check(step.id, step.uses.action, step.input, step.checks?.approval, "uses.action");
  });
  for (const o of workflow.outputs) {
    if ((o.kind !== "write" && o.kind !== "save") || !o.action) continue;
    check(o.id, o.action.action, o.action.input, o.checks?.approval, "action.action");
  }
  return errors;
}

/** The connector names a refusal says. */
function connectorList(connectors: readonly string[]): string {
  return connectors.join(" and ");
}

/**
 * Where a Change or Send action runs for this agent, as the run resolves it: a tool on its own
 * connector; a write action (Email, Text, Accounting) from the agent's channel or its accounting
 * binding; another merged action on the first of its connectors the agent is bound to with it on.
 * An action switched off on its connector never runs (the gate refuses it), so it is passed over
 * where the run passes it over, and is an issue where nothing else runs it. Null: a Get, or an
 * action that writes only Mezonas' own records (a Save on an area), which no connection carries.
 */
function resolve(action: string, ctx: Ctx): Resolved | null {
  const publish = ctx.publish;
  if (!publish) return null;
  const off = publish.actionsOff ?? new Set<string>();
  const keyFor = (connector: string) =>
    Object.keys(publish.matrices).find((k) => bindingConnector(k) === connector);
  const bound = [...new Set(Object.keys(publish.matrices).map(bindingConnector))];
  const at = (tool: string, connector: string, matrix: Matrix): Resolved => ({
    ok: true,
    tool,
    connector,
    matrix,
    spec: ctx.tools?.[tool],
  });
  const switchedOff = (label: string, connectors: readonly string[]): Resolved => ({
    ok: false,
    code: "action_off",
    message: `${label} is switched off for ${connectorList(connectors)}: switch it on on the connector's page, or change the step`,
  });

  const write = WRITE_ACTIONS[action];
  if (write) {
    const merged = mergedAction(action);
    const label = merged?.label ?? action;
    if (write === "send_email" || write === "send_text") {
      const bindings: ActionBindings = ctx.actions ?? actionBindingsFromMatrices(publish.matrices);
      const r = resolveActionConnector(write, undefined, bindings);
      if (r === undefined) return { ok: "unknown" };
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      const line = r.channel ? bindings.channels?.[r.channel] : null;
      if (!off.has(r.tool)) return at(r.tool, r.connector, line?.matrix);
      // The channel's tool is off: another bound connector that sends it, with it on, runs it.
      for (const c of bound) {
        if (c === r.connector) continue;
        const tool = actionTool(write, c);
        if (tool && !off.has(tool)) return at(tool, c, publish.matrices[keyFor(c) ?? c]);
      }
      return switchedOff(label, [r.connector]);
    }
    const accounting = bound.filter((c) =>
      (ACCOUNTING_CONNECTORS as readonly string[]).includes(c),
    );
    const on = accounting.filter((c) => {
      const tool = actionTool(write, c);
      return !tool || !off.has(tool);
    });
    if (accounting.length > 0 && on.length === 0) return switchedOff(label, accounting);
    const r = resolveActionConnector(write, undefined, { bound: on });
    if (r === undefined) return { ok: "unknown" };
    if (!r.ok) {
      return {
        ok: false,
        code: r.code === "action_no_connection" ? "connection_missing" : r.code,
        message: r.message,
      };
    }
    return at(r.tool, r.connector, publish.matrices[keyFor(r.connector) ?? r.connector]);
  }

  const merged = mergedAction(action);
  if (merged) {
    const first = Object.values(merged.tools)
      .map((t) => ctx.tools?.[t])
      .find(Boolean);
    if (first && first.sideEffect !== "external") return null;
    const offFor: string[] = [];
    for (const [connector, tool] of Object.entries(merged.tools)) {
      if (!bound.includes(connector)) continue;
      if (!off.has(tool)) return at(tool, connector, publish.matrices[keyFor(connector) ?? ""]);
      offFor.push(connector);
    }
    if (offFor.length > 0) return switchedOff(merged.label, offFor);
    return {
      ok: false,
      code: "connection_missing",
      message: `${merged.label} needs one of ${connectorList(Object.keys(merged.tools))} bound`,
    };
  }

  const spec = ctx.tools?.[action];
  // DECISION: an action the registries don't know is the step model's own issue (unknown action),
  // not a connection's; it is left to that check.
  if (spec?.sideEffect !== "external") return null;
  const connector = spec.connector ?? spec.source;
  const key = keyFor(connector);
  if (key === undefined) {
    return {
      ok: false,
      code: "connection_missing",
      message: `no ${connector} connection is bound for "${spec.id}"`,
    };
  }
  if (off.has(spec.id)) return switchedOff(`"${spec.id}"`, [connector]);
  return at(spec.id, connector, publish.matrices[key]);
}
