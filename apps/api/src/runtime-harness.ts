// The Workers tests' entry point: the real Worker (default export and RunWorkflow) plus
// ProbeWorkflow, which runs packages/workflows' executor through the same StepRunner adapter as
// RunWorkflow, against in-memory ports, so the engine's waitForEvent, sendEvent and timeouts are
// exercised without a database or a model. Never deployed (wrangler.jsonc's main is src/index.ts).

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Workflow as WorkflowDef } from "@countersign/core";
import {
  type ExecutorContext,
  executeWorkflow,
  type InboxResolution,
  type RunResult,
} from "@countersign/workflows";
import type { Bindings } from "./env";
import { cloudflareStepRunner, type WorkflowStepLike } from "./runs/step-runner";

export { default, QboSyncWorkflow, RunWorkflow } from "./index";

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
