// The cron's part in notifications (docs/plan.md §1.37): every minute each client's Weekly Table
// is checked (Friday 17:00 draft, Monday 7:00 send, in its time zone); every 5 minutes the pass
// scans the client's rows for candidates, inserts them by dedupe key and sends what is queued.
// One withTenant per client (invariant 1); one client's failure never holds up the next.

import { type FetchLike, globalFetch } from "@countersign/connectors";
import { NOTIFY_PASS_MINUTES } from "@countersign/core";
import { type Db, tenant, withTenant } from "@countersign/db";
import { isNull } from "drizzle-orm";
import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";
import type { Platform } from "../platform";
import { weeklyTick } from "../weekly/tables";
import { mailerFromEnv, texterFromEnv } from "./mailer";
import { enqueue, type NotifyDeps, originOf, type SendSummary, sendQueued } from "./outbox";
import { clientPeople, tenantRow } from "./people";
import { scanCandidates } from "./scan";

export function notifyDepsFromEnv(env: Bindings, fetch?: FetchLike): NotifyDeps {
  const f = fetch ?? globalFetch();
  return { mailer: mailerFromEnv(env, f), texter: texterFromEnv(env, f), origin: originOf(env) };
}

/** One client's pass: candidates found by scanning, inserted, then the queue sent. */
export async function notifyPass(
  db: Db,
  deps: NotifyDeps,
  tenantId: string,
  now: Date,
): Promise<SendSummary | null> {
  return withTenant(db, tenantId, async (tx) => {
    const t = await tenantRow(tx, tenantId);
    if (!t || t.retiredAt) return null;
    const people = await clientPeople(tx, t);
    await enqueue(tx, t.id, deps.origin, await scanCandidates(tx, t, people, now), now);
    return sendQueued(tx, deps, t, now);
  });
}

/** Sends one client's queue now (e.g. after the operator's reminder). */
export async function sendNow(db: Db, deps: NotifyDeps, tenantId: string, now: Date) {
  return withTenant(db, tenantId, async (tx) => {
    const t = await tenantRow(tx, tenantId);
    return t && !t.retiredAt ? sendQueued(tx, deps, t, now) : null;
  });
}

/** The minute cron's call: the Weekly Table for every client, and the pass every 5 minutes. */
export async function notifyTick(
  db: Db,
  deps: NotifyDeps,
  platform: Platform,
  scheduledTime: Date,
): Promise<void> {
  const now = new Date(Math.floor(scheduledTime.getTime() / 60_000) * 60_000);
  const pass = now.getUTCMinutes() % NOTIFY_PASS_MINUTES === 0;
  const clients = await db.select({ id: tenant.id }).from(tenant).where(isNull(tenant.retiredAt));
  for (const client of clients) {
    try {
      const queued = await withTenant(db, client.id, async (tx) => {
        const t = await tenantRow(tx, client.id);
        return t ? weeklyTick(tx, t, platform, now, deps.origin) : false;
      });
      if (pass) await notifyPass(db, deps, client.id, now);
      else if (queued) await sendNow(db, deps, client.id, now);
    } catch (error) {
      reportHandled(`notifications for client ${client.id} failed`, error, {
        job: "notify",
        client: client.id,
      });
    }
  }
}
