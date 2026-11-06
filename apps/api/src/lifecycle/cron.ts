// The lifecycle's share of the cron (docs/plan.md §1.36): every minute, pauses whose `until` has
// passed are resumed; once an hour (the usage sweep's minute), trials that met both minimums move to
// signoff and the client admin is asked. Each client in its own scope (invariant 1); one client's
// failure never holds up the next.

import { type Db, tenant, withTenant } from "@countersign/db";
import { USAGE_SWEEP_MINUTE } from "../runs/dispatch";
import { resumeEndedPauses } from "./pause";
import { advanceTrials } from "./stages";

export async function lifecycleTick(db: Db, scheduledTime: Date): Promise<void> {
  const hourly = scheduledTime.getUTCMinutes() === USAGE_SWEEP_MINUTE;
  const clients = await db.select({ id: tenant.id }).from(tenant);
  for (const { id } of clients) {
    try {
      await withTenant(db, id, async (tx) => {
        await resumeEndedPauses(tx, id, scheduledTime);
        if (hourly) await advanceTrials(tx, id, scheduledTime);
      });
    } catch (error) {
      console.error(`lifecycle cron for client ${id} failed`, error);
    }
  }
}
