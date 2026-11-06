// v0.12 W2-C: TestSuiteWorkflow, one instance per suite run (docs/plan.md §1.46). One case per
// durable step, then the totals; the work is in ./suite.ts, so Node tests drive the same code with
// an inline runner.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb } from "@countersign/db";
import type { Bindings } from "../env";
import { platformFor } from "../platform";
import { runDepsFromEnv } from "../runs/execute";
import { executeSuite, type SuiteParams } from "./suite";

// DECISION: a case's step is not retried: a case that fails is a result (`error`), recorded by the
// step itself, and a template case retried would start a second test run. 15 minutes per case.
const CASE_STEP = { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" } as const;

export class TestSuiteWorkflow extends WorkflowEntrypoint<Bindings, SuiteParams> {
  override async run(event: Readonly<WorkflowEvent<SuiteParams>>, step: WorkflowStep) {
    const db = createDb(this.env.HYPERDRIVE.connectionString, { max: 2 });
    try {
      // No instances: a template case's test run is run to its end inside its case's step.
      const deps = runDepsFromEnv(this.env, { db, platform: platformFor(this.env) });
      return await executeSuite(deps, event.payload, {
        // Step results are plain JSON; the structural cast stands in for Rpc.Serializable.
        do: <T>(name: string, fn: () => Promise<T>) =>
          step.do(name, CASE_STEP, fn as never) as Promise<T>,
      });
    } finally {
      this.ctx.waitUntil(db.$client.end());
    }
  }
}
