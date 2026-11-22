// `services.desktop` (docs/plan.md §1.151, §1.204; migration 0080): the `desktop` connector's
// tools hand one job at a time to it; it queues a `desktop_job` row for the connection's paired
// computer and waits for the answer the computer posts (desktop/jobs.ts, routes/desktop.ts).
// Nothing holds a transaction while it waits: a Worker's database has one pooled connection, so
// the wait is a run of short transactions in the job's one client. Imports nothing from the HTTP
// layer: the runtime (runs/execute.ts) builds it.

import {
  type ConnectionRef,
  DesktopConfig,
  DesktopJobError,
  type DesktopServices,
  DesktopUnavailableError,
} from "@countersign/connectors";
import { DESKTOP_JOB_TTL_SEC, type DesktopJobRequest, DesktopJobResult } from "@countersign/core";
import { type Db, desktopDevice, desktopJob, withTenant } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";

export interface JobTiming {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How often a wait looks again. */
  everyMs?: number;
}

export const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// DECISION: a wait looks at the database once a second: a computer's answer reaches the step
// within about a second, and a step waiting its full two minutes makes 120 small reads.
export const EVERY_MS = 1000;

/**
 * `services.desktop` for one connection: each job queued for the connection's paired computer,
 * then waited for. Not picked up before it expires: DesktopUnavailableError (nothing was done).
 * Picked up but not answered within DESKTOP_JOB_TTL_SEC more: DesktopJobError `failed` (a write
 * may have happened; the retry carries the same idempotency key, so the computer answers
 * `alreadyDone` rather than write twice).
 */
export function dbDesktopServices(
  db: Db,
  conn: ConnectionRef,
  timing: JobTiming = {},
): DesktopServices {
  const now = timing.now ?? (() => new Date());
  const sleep = timing.sleep ?? defaultSleep;
  const every = timing.everyMs ?? EVERY_MS;
  const computer = () => {
    const parsed = DesktopConfig.safeParse(conn.config);
    return parsed.success ? parsed.data.name : "The computer";
  };
  return {
    async run(connectionId: string, request: DesktopJobRequest) {
      // Only ever the call's own connection (its client and computer).
      if (connectionId !== conn.id) throw new DesktopUnavailableError(computer());
      const issued = now();
      const expires = new Date(issued.getTime() + DESKTOP_JOB_TTL_SEC * 1000);
      const jobId = await withTenant(db, conn.tenantId, async (tx) => {
        const [device] = await tx
          .select({ id: desktopDevice.id })
          .from(desktopDevice)
          .where(
            and(
              eq(desktopDevice.tenantId, conn.tenantId),
              eq(desktopDevice.connectionId, conn.id),
              isNull(desktopDevice.revokedAt),
            ),
          );
        if (!device) return null;
        const [job] = await tx
          .insert(desktopJob)
          .values({
            tenantId: conn.tenantId,
            deviceId: device.id,
            kind: request.kind,
            request,
            issuedAt: issued,
            expiresAt: expires,
          })
          .returning({ id: desktopJob.id });
        return job?.id ?? null;
      });
      if (!jobId) throw new DesktopUnavailableError(computer());
      for (;;) {
        const [row] = await withTenant(db, conn.tenantId, (tx) =>
          tx
            .select({
              sentAt: desktopJob.sentAt,
              answeredAt: desktopJob.answeredAt,
              result: desktopJob.result,
            })
            .from(desktopJob)
            .where(and(eq(desktopJob.tenantId, conn.tenantId), eq(desktopJob.id, jobId))),
        );
        if (row?.answeredAt) {
          // Checked again here (invariant 5): the route checked it, but this is what a step gets.
          const parsed = DesktopJobResult.safeParse(row.result);
          if (!parsed.success) {
            throw new DesktopJobError(
              "failed",
              "the computer's answer wasn't in the expected shape",
            );
          }
          return parsed.data;
        }
        const at = now().getTime();
        if (!row?.sentAt && at >= expires.getTime()) throw new DesktopUnavailableError(computer());
        if (row?.sentAt && at >= row.sentAt.getTime() + DESKTOP_JOB_TTL_SEC * 1000) {
          throw new DesktopJobError(
            "failed",
            `${computer()} took the job but didn't answer in time; check its Activity before trying again`,
          );
        }
        await sleep(every);
      }
    },
  };
}
