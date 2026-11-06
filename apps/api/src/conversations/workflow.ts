// v0.14 capture: CaptureWorkflow, one instance per message (docs/plan.md §1.55). One durable step
// per attachment, retried with backoff when Twilio is busy or down; then the agent, then the
// reading. The work is in ./media.ts, so Node tests drive the same code with an inline runner.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb } from "@countersign/db";
import type { Bindings } from "../env";
import { defaultDeps } from "../http";
import { platformFor } from "../platform";
import { type CaptureParams, runCapture } from "./media";
import { captureDepsFor } from "./start";

// DECISION: five tries a minute apart, then the step fails and the message stays pending for the
// cron's restart (within 3 days). Two minutes per try is ample for 32 MB.
const MEDIA_STEP = {
  retries: { limit: 5, delay: "1 minute", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

export class CaptureWorkflow extends WorkflowEntrypoint<Bindings, CaptureParams> {
  override async run(event: Readonly<WorkflowEvent<CaptureParams>>, step: WorkflowStep) {
    const db = createDb(this.env.HYPERDRIVE.connectionString, { max: 2 });
    try {
      const deps = captureDepsFor({
        db,
        env: this.env,
        deps: defaultDeps,
        platform: platformFor(this.env),
      });
      const results = await runCapture(deps, event.payload, {
        // Step results are plain JSON; the structural cast stands in for Rpc.Serializable.
        do: <T>(name: string, fn: () => Promise<T>) =>
          step.do(name, MEDIA_STEP, fn as never) as Promise<T>,
      });
      return results.map((r) => ({ index: r.index, status: r.status }));
    } finally {
      this.ctx.waitUntil(db.$client.end());
    }
  }
}
