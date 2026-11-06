// ExportWorkflow: one instance per client data export (docs/plan.md §1.36). Each table page and
// document batch is a durable step with retries; the work is in ./client-data.ts, so Node tests
// drive the same code with a fake step.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { R2ObjectStore } from "@countersign/connectors";
import { createDb } from "@countersign/db";
import type { Bindings } from "../env";
import { type ExportParams, runClientExport } from "./client-data";
import type { ExportStorage } from "./store";

// DECISION: a page step retries 3 times with backoff and gives up after 10 minutes; the final
// step, which copies every piece into the ZIP, gets 30 minutes (it is I/O, not CPU).
const PAGE_STEP = {
  retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
  timeout: "10 minutes",
} as const;
const ZIP_STEP = { ...PAGE_STEP, timeout: "30 minutes" } as const;

/** R2 with streamed writes: a FixedLengthStream of the ZIP's planned size. */
export function r2ExportStorage(bucket: R2Bucket): ExportStorage {
  return {
    objects: new R2ObjectStore(bucket),
    async putStream(key, size, pieces, contentType) {
      const { readable, writable } = new FixedLengthStream(size);
      const put = bucket.put(key, readable, { httpMetadata: { contentType } });
      const writer = writable.getWriter();
      try {
        for await (const piece of pieces) await writer.write(piece);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        await put.catch(() => undefined);
        throw error;
      }
      await put;
    },
  };
}

export class ExportWorkflow extends WorkflowEntrypoint<Bindings, ExportParams> {
  override async run(event: Readonly<WorkflowEvent<ExportParams>>, step: WorkflowStep) {
    const db = createDb(this.env.HYPERDRIVE.connectionString, { max: 2 });
    try {
      return await runClientExport(
        { db, storage: r2ExportStorage(this.env.ARTIFACTS), now: () => new Date() },
        event.payload,
        {
          // Step results are plain JSON; the structural cast stands in for Rpc.Serializable.
          do: <T>(name: string, fn: () => Promise<T>) =>
            step.do(name, name === "zip" ? ZIP_STEP : PAGE_STEP, fn as never) as Promise<T>,
        },
      );
    } finally {
      this.ctx.waitUntil(db.$client.end());
    }
  }
}
