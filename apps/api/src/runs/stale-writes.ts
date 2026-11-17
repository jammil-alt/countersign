// Follow-up 1b (audit 3.2): writes left `executing` that nothing will take over (an undo, a signed
// write, a write of a run that has ended) go to the operator as unconfirmed writes, once each, so
// a person checks the client's tool and settles them (packages/agents' `sweepStaleExecutions`).

import { type Emit, sweepStaleExecutions } from "@countersign/agents";
import { type Db, tenant } from "@countersign/db";
import { reportHandled } from "../observability/report";

// DECISION: every ten minutes, at minute 3 of each ten, so it never shares a tick with the run
// reconciler (minute 8 of each ten, runs/reconcile.ts). A row waits at most ten more minutes.
/** The minute of each ten the sweep runs at. */
export const STALE_WRITES_MINUTE = 3;
export const STALE_WRITES_EVERY_MINUTES = 10;
/** Writes turned over per client and pass; the rest wait for the next pass. */
const PER_CLIENT = 20;

/** Every ten minutes, each client's writes left executing that no run will take over. */
export async function staleWritesTick(db: Db, at: Date, emit?: Emit): Promise<number> {
  if (at.getUTCMinutes() % STALE_WRITES_EVERY_MINUTES !== STALE_WRITES_MINUTE) return 0;
  const clients = await db.select({ id: tenant.id }).from(tenant);
  let turned = 0;
  for (const { id } of clients) {
    try {
      turned += await sweepStaleExecutions(db, id, {
        limit: PER_CLIENT,
        ...(emit ? { emit } : {}),
      });
    } catch (error) {
      reportHandled(`stale writes sweep for client ${id} failed`, error, {
        job: "stale_writes",
        client: id,
      });
    }
  }
  return turned;
}
