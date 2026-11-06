// Delivering an inbox item's resolution to the run that waits on it (docs/plan.md §1.5 "Approval
// resume"). Resolving an item sends its event once the transaction commits; that send may fail, or
// reach an instance that does not exist yet. So the delivery is durable: a resolved item with a
// run is pending until the run records that it took the resolution (`run_received_at`, written by
// the executor through InboxPort.received), and the every-minute cron re-sends the event of every
// pending item whose run is still going. Sending again is safe: each item's event type is waited on
// at most once, and the run checks the item before it waits, so a duplicate is never read twice.
//
// v0.12 W1-D (ARCHITECTURE §11.1): an approval inside its undo window (`deliver_after`) is not sent
// when it is resolved; this pass sends it once the window has passed, so the write runs 60 to 120
// seconds after signing with the default window.

import { type Db, inboxItem, run, withTenant } from "@countersign/db";
import { inboxEventType } from "@countersign/workflows";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { toRunResolution } from "../inbox";
import type { RunInstances } from "./instances";

/** How long the after-commit send gets before the cron sends again. */
export const REDELIVER_AFTER_MS = 60_000;
// DECISION: the cron re-sends for a day after the resolution. A run that takes longer to reach its
// wait does not need the event: it reads the resolution in its check before waiting.
export const REDELIVER_WINDOW_MS = 24 * 60 * 60_000;

const GOING = ["queued", "running", "waiting"] as const;

export interface RedeliverDeps {
  db: Db;
  instances: RunInstances;
}

/**
 * Re-sends the event of each of one client's resolved items whose run is still going and has not
 * taken it. Failures are logged and left pending for the next tick.
 */
export async function redeliverResolutions(
  deps: RedeliverDeps,
  tenantId: string,
  now: Date,
): Promise<{ sent: number; failed: number }> {
  const pending = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select({
        id: inboxItem.id,
        runId: inboxItem.runId,
        resolution: inboxItem.resolution,
        resolvedBy: inboxItem.resolvedBy,
      })
      .from(inboxItem)
      .innerJoin(run, and(eq(run.id, inboxItem.runId), eq(run.tenantId, inboxItem.tenantId)))
      .where(
        and(
          eq(inboxItem.tenantId, tenantId),
          eq(inboxItem.status, "resolved"),
          isNotNull(inboxItem.runId),
          isNull(inboxItem.runReceivedAt),
          // v0.12 W1-D: an approval inside its undo window is delivered only once the window
          // has passed (the database's clock, as in undo and in claiming the action); after
          // that, at every tick until the run takes it. Others: a minute after the resolution.
          or(
            and(
              isNull(inboxItem.deliverAfter),
              lte(inboxItem.resolvedAt, new Date(now.getTime() - REDELIVER_AFTER_MS)),
            ),
            lte(inboxItem.deliverAfter, sql`now()`),
          ),
          gt(inboxItem.resolvedAt, new Date(now.getTime() - REDELIVER_WINDOW_MS)),
          inArray(run.status, [...GOING]),
        ),
      )
      .limit(500),
  );
  let sent = 0;
  let failed = 0;
  for (const item of pending) {
    if (!item.runId) continue;
    try {
      await deps.instances.sendEvent(item.runId, {
        type: inboxEventType(item.id),
        payload: toRunResolution(item),
      });
      sent++;
    } catch (error) {
      failed++;
      console.error(`re-sending inbox item ${item.id} to run ${item.runId} failed`, error);
    }
  }
  return { sent, failed };
}
