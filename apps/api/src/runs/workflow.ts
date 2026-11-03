// RunWorkflow: the one Workflow class that runs any workflow of any client agent (ARCHITECTURE
// §10.3). The instance id is the run id. Everything it does is in ./execute.ts, against the
// StepRunner adapter, so Node tests drive the same code with a fake step.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb } from "@countersign/db";
import type { Bindings } from "../env";
import { platformFor } from "../platform";
import { executeRun, runDepsFromEnv } from "./execute";
import { type RunParams, workflowInstances } from "./instances";
import { cloudflareStepRunner, type WorkflowStepLike } from "./step-runner";

export class RunWorkflow extends WorkflowEntrypoint<Bindings, RunParams> {
  override async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    // A run touches exactly one client: every transaction in executeRun is withTenant(params.tenantId).
    const db = createDb(this.env.HYPERDRIVE.connectionString, { max: 2 });
    try {
      const deps = runDepsFromEnv(this.env, {
        db,
        platform: platformFor(this.env),
        instances: workflowInstances(this.env.RUN_WORKFLOW),
      });
      // `step.do` types results as Rpc.Serializable; our step results are plain JSON, so the
      // structural adapter type stands in for it here and nowhere else.
      const runner = cloudflareStepRunner(step as unknown as WorkflowStepLike);
      return await executeRun(deps, event.payload, runner);
    } finally {
      this.ctx.waitUntil(db.$client.end());
    }
  }
}
