// v0.14 capture: the cron's restart of captures left pending (docs/plan.md §1.55). Every 10 minutes,
// each client's WhatsApp messages from the last 3 days, older than 10 minutes, whose wanted
// attachments have no outcome yet are started again (a job that died, or Twilio down past its
// retries). A job finds outcomes already written and does nothing for them.

import { TWILIO_MESSAGE_ENTITY } from "@countersign/connectors";
import { type Db, rawRecord, tenant, withTenant } from "@countersign/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { reportHandled } from "../observability/report";
import { mediaOutcomes, storedCaptureOf } from "./capture";
import type { CaptureJobs } from "./instances";

/** The cron's minute within each 10 (2, 12, 22, …). */
export const CAPTURE_CRON_MINUTE = 2;
const PENDING_AFTER_MS = 10 * 60 * 1000;
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export async function captureCronTick(db: Db, jobs: CaptureJobs, at: Date): Promise<number> {
  if (at.getUTCMinutes() % 10 !== CAPTURE_CRON_MINUTE) return 0;
  let started = 0;
  const clients = await db.select({ id: tenant.id }).from(tenant);
  for (const client of clients) {
    try {
      const pending = await withTenant(db, client.id, async (tx) => {
        const rows = await tx
          .select({
            id: rawRecord.id,
            connectionId: rawRecord.connectionId,
            sid: rawRecord.externalId,
            payload: rawRecord.payload,
          })
          .from(rawRecord)
          .where(
            and(
              eq(rawRecord.tenantId, client.id),
              eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
              gte(rawRecord.syncedAt, new Date(at.getTime() - GIVE_UP_AFTER_MS)),
              lte(rawRecord.syncedAt, new Date(at.getTime() - PENDING_AFTER_MS)),
              sql`jsonb_array_length(coalesce(${rawRecord.payload}->'capture'->'wanted', '[]'::jsonb)) > 0`,
            ),
          )
          .limit(500);
        const out: { id: string; connectionId: string; sid: string; indexes: number[] }[] = [];
        for (const r of rows) {
          const wanted = storedCaptureOf(r.payload)?.wanted ?? [];
          const outcomes = await mediaOutcomes(tx, client.id, r.connectionId, [r.sid]);
          const indexes = wanted.filter((i) => !outcomes.has(`${r.sid}:${i}`));
          if (indexes.length > 0) {
            out.push({ id: r.id, connectionId: r.connectionId, sid: r.sid, indexes });
          }
        }
        return out;
      });
      for (const p of pending) {
        const r = await jobs.start({
          tenantId: client.id,
          connectionId: p.connectionId,
          rawRecordId: p.id,
          messageSid: p.sid,
          indexes: p.indexes,
          reason: "restart",
        });
        if (r === "started") started += 1;
      }
    } catch (error) {
      reportHandled("capture restart failed", error, { kind: "capture" });
    }
  }
  return started;
}
