// QboSyncWorkflow: one instance per QuickBooks sync of one connection (plan M9, ARCHITECTURE §6.2:
// webhooks start a sync for the realm, never process inline). Each page is a durable step with
// retries; everything it does is in ./sync.ts, so Node tests drive the same code inline.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ContentStore, credentialKeysFromEnv, R2ObjectStore } from "@countersign/connectors";
import { createDb } from "@countersign/db";
import type { Bindings } from "../env";
import { platformFor } from "../platform";
import { credentialsFor } from "../runs/execute";
import { workflowInstances } from "../runs/instances";
import { type QboSyncParams, qboSyncInstances } from "./instances";
import { dispatchByIds } from "./sync";
import { runQboSyncInstance } from "./sync-now";

// DECISION: a page step retries 3 times with backoff (a busy or throttled QuickBooks) and gives
// up after 5 minutes; the next cron tick starts again from the stored cursor.
const PAGE_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

export class QboSyncWorkflow extends WorkflowEntrypoint<Bindings, QboSyncParams> {
  override async run(event: Readonly<WorkflowEvent<QboSyncParams>>, step: WorkflowStep) {
    if (!this.env.ENCRYPTION_KEY) return { skipped: "no ENCRYPTION_KEY" };
    const db = createDb(this.env.HYPERDRIVE.connectionString, { max: 2 });
    try {
      const deps = {
        db,
        platform: platformFor(this.env),
        content: new ContentStore(new R2ObjectStore(this.env.ARTIFACTS)),
        credentials: credentialsFor(db, credentialKeysFromEnv(this.env)),
      };
      const instances = workflowInstances(this.env.RUN_WORKFLOW);
      // v0.12 W1-H: the sync holds its connection, and its last step starts the sync asked for
      // while it ran ("sync now", ARCHITECTURE §6.2).
      return await runQboSyncInstance(
        { ...deps, instances: this.env.QBO_SYNC ? qboSyncInstances(this.env.QBO_SYNC) : null },
        event.payload,
        event.instanceId,
        {
          // Step results are plain JSON; the structural cast stands in for Rpc.Serializable.
          do: <T>(name: string, fn: () => Promise<T>) =>
            step.do(name, PAGE_STEP, fn as never) as Promise<T>,
        },
        (ids) => dispatchByIds({ db, instances }, event.payload.tenantId, ids),
      );
    } finally {
      this.ctx.waitUntil(db.$client.end());
    }
  }
}
