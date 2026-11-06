// The Workers tests' entry point: the real Worker (default export and RunWorkflow) plus
// ProbeWorkflow, which runs packages/workflows' executor through the same StepRunner adapter as
// RunWorkflow, against in-memory ports, so the engine's waitForEvent, sendEvent and timeouts are
// exercised without a database or a model. Never deployed (wrangler.jsonc's main is src/index.ts).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  type ExternalActionRecord,
  executeAction,
  type RuntimeDeps,
  ToolRegistry,
} from "@countersign/agents";
import {
  ConnectorRegistry,
  createTestkitConnector,
  TESTKIT_UPDATE_TOOL,
  TestkitBackend,
} from "@countersign/connectors";
import type { Workflow as WorkflowDef } from "@countersign/core";
import {
  type ExecutorContext,
  executeWorkflow,
  type InboxResolution,
  type RunResult,
} from "@countersign/workflows";
import type { Bindings } from "./env";
import { cloudflareStepRunner, type WorkflowStepLike } from "./runs/step-runner";

export {
  default,
  ExportWorkflow,
  QboSyncWorkflow,
  RunWorkflow,
  TestSuiteWorkflow,
} from "./index";

export interface ProbeParams {
  workflow: WorkflowDef;
}

/** The id the probe gives the inbox item of a person step: predictable for the test. */
export const probeItemId = (nodeId: string) => `item-${nodeId}`;

export class ProbeWorkflow extends WorkflowEntrypoint<Bindings, ProbeParams> {
  override async run(event: Readonly<WorkflowEvent<ProbeParams>>, step: WorkflowStep) {
    const runner = cloudflareStepRunner(step as unknown as WorkflowStepLike);
    const resolutions = new Map<string, InboxResolution>();
    const ctx: ExecutorContext = {
      run: {
        id: "probe",
        tenantId: "probe",
        agentId: "probe",
        agentVersionId: "probe",
        workflowSlug: "probe",
        mode: "live",
      },
      agent: {
        runSkill: async ({ input }) => ({ kind: "done", output: input }),
        runAction: async ({ input }) => ({ kind: "done", output: input }),
        resume: async () => ({ kind: "done", output: null }),
      },
      inbox: {
        createForPerson: async (item) => ({ id: probeItemId(item.nodeId) }),
        resolution: async (id) => resolutions.get(id) ?? null,
        expire: async () => {},
        received: async () => {},
      },
      notify: { send: async () => {}, notifyOperator: async () => {} },
      log: { start: async (e) => `sr-${e.nodeId}`, update: async () => {} },
    };
    const result: RunResult = await executeWorkflow(runner, ctx, event.payload.workflow, {});
    return result;
  }
}

// ── v0.12 W1-D: the undo window under the Workflows engine (ARCHITECTURE §11.1) ──────────────────

export interface DeskProbeParams {
  workflow: WorkflowDef;
  /** When the approval's undo window ends (ms since the epoch); the database's role is played here. */
  heldUntil: number;
}

export const DESK_PROBE_TENANT = "probe-tenant";
export const DESK_PROBE_CONNECTION = "probe-connection";

/**
 * Runs an action step whose change a person approved inside its undo window. The real executor
 * waits on the item; the real `executeAction` runs the change through the testkit connector once
 * the run is told, over an in-memory action store whose claim, like the database's, skips an
 * action still inside its window. The check before waiting sees no resolution inside the window.
 */
export class DeskProbeWorkflow extends WorkflowEntrypoint<Bindings, DeskProbeParams> {
  override async run(event: Readonly<WorkflowEvent<DeskProbeParams>>, step: WorkflowStep) {
    const { heldUntil } = event.payload;
    const runner = cloudflareStepRunner(step as unknown as WorkflowStepLike);
    const testkit = createTestkitConnector(
      new TestkitBackend().seed(DESK_PROBE_CONNECTION, [
        { id: "R-1", name: "Plywood", amount: "10.0000" },
      ]),
    );
    const action: ExternalActionRecord = {
      id: "action-1",
      tenantId: DESK_PROBE_TENANT,
      connectionId: DESK_PROBE_CONNECTION,
      tool: TESTKIT_UPDATE_TOOL,
      runId: "probe",
      stepRunId: "sr-send",
      agentVersionId: "probe",
      input: { id: "R-1", amount: "12.0000" },
      idempotencyKey: "probe:send:0",
      // Approved by a person, inside the window until `heldUntil`.
      status: "approved",
      inboxItemId: probeItemId("send"),
      approvedBy: "user-1",
      result: null,
      error: null,
      before: null,
    };
    const held = () => Date.now() < heldUntil;
    const actions = {
      get: async () => ({ ...action }),
      byKey: async () => ({ ...action }),
      propose: async () => ({ action: { ...action }, created: false }),
      claim: async () => {
        if (action.status !== "approved" || held())
          return { action: { ...action }, claimed: false };
        action.status = "executing";
        return { action: { ...action }, claimed: true };
      },
      complete: async (_t: string, _id: string, r: { output: unknown; before: unknown }) => {
        Object.assign(action, { status: "done", result: r.output, before: r.before });
        return { ...action };
      },
      fail: async (_t: string, _id: string, error: unknown) => {
        Object.assign(action, { status: "failed", error });
        return { ...action };
      },
    };
    const connection = {
      id: DESK_PROBE_CONNECTION,
      tenantId: DESK_PROBE_TENANT,
      connector: "testkit",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: {},
    };
    const runtime = {
      ports: {
        actions,
        store: {
          run: async () => ({ mode: "live", agentId: "probe" }),
          connection: async () => connection,
        },
      },
      tools: new ToolRegistry({ connectors: new ConnectorRegistry([testkit]) }),
    } as unknown as RuntimeDeps;

    const ctx: ExecutorContext = {
      run: {
        id: "probe",
        tenantId: DESK_PROBE_TENANT,
        agentId: "probe",
        agentVersionId: "probe",
        workflowSlug: "probe",
        mode: "live",
      },
      agent: {
        runSkill: async ({ input }) => ({ kind: "done", output: input }),
        // The change was proposed and its item approved: the step waits on the item.
        runAction: async ({ nodeId }) => ({
          kind: "approval",
          pending: { inboxItemId: probeItemId(nodeId), state: null },
        }),
        resume: async ({ resolution }) => {
          if (resolution.approved !== true) return { kind: "done", output: { written: false } };
          const r = await executeAction(runtime, {
            tenantId: DESK_PROBE_TENANT,
            actionId: action.id,
          });
          if (r.status === "done") return { kind: "done", output: { written: true } };
          return { kind: "failed", error: `not written: ${r.status}` };
        },
      },
      inbox: {
        createForPerson: async (item) => ({ id: probeItemId(item.nodeId) }),
        // Like `resolution()` over the database: inside its window an approval is not the run's.
        resolution: async () => (held() ? null : { approved: true, answer: null, by: "user-1" }),
        expire: async () => {},
        received: async () => {},
      },
      notify: { send: async () => {}, notifyOperator: async () => {} },
      log: { start: async (e) => `sr-${e.nodeId}`, update: async () => {} },
    };
    const result: RunResult = await executeWorkflow(runner, ctx, event.payload.workflow, {});
    return result;
  }
}
