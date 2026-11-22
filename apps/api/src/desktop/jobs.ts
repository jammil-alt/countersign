// The computer's side of its jobs (docs/plan.md §1.151, §1.204; migration 0080): it takes them on
// a long poll (`takeJobs`) and answers each once (`answerJob`). `services.desktop` queues them and
// waits for the answers (desktop/services.ts). Nothing holds a transaction while it waits.

import {
  DESKTOP_POLL_SEC,
  type DesktopJob,
  type DesktopJobRequest,
  DesktopJobResult,
} from "@countersign/core";
import { type Db, desktopDevice, desktopJob, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { HttpError, notFound } from "../http";
import { deviceConnection, platformFolders, type SignedDevice } from "./devices";
import { defaultSleep, EVERY_MS, type JobTiming } from "./services";

/** The most jobs one answer to the computer carries (core's DesktopJobsResponse). */
const JOBS_PER_ANSWER = 20;

/** The computer's jobs not yet handed out (and not expired), marked handed out. */
async function claimJobs(tx: Tx, signed: SignedDevice, at: Date): Promise<DesktopJob[]> {
  const rows = await tx
    .select()
    .from(desktopJob)
    .where(
      and(
        eq(desktopJob.tenantId, signed.tenantId),
        eq(desktopJob.deviceId, signed.device.id),
        isNull(desktopJob.sentAt),
        gt(desktopJob.expiresAt, at),
      ),
    )
    .orderBy(asc(desktopJob.issuedAt))
    .limit(JOBS_PER_ANSWER)
    .for("update", { skipLocked: true });
  if (rows.length === 0) return [];
  await tx
    .update(desktopJob)
    .set({ sentAt: at })
    .where(
      and(
        eq(desktopJob.tenantId, signed.tenantId),
        sql`${desktopJob.id} in (${sql.join(
          rows.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )})`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    issuedAt: r.issuedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    request: r.request as DesktopJobRequest,
  }));
}

/**
 * The long poll: waits up to `waitSec` (at most DESKTOP_POLL_SEC) for jobs, then answers them with
 * the folders the platform has for this computer. A computer removed while it waits gets nothing
 * more.
 */
export async function takeJobs(
  db: Db,
  signed: SignedDevice,
  waitSec: number,
  timing: JobTiming = {},
): Promise<{ jobs: DesktopJob[]; folders: ReturnType<typeof platformFolders> }> {
  const now = timing.now ?? (() => new Date());
  const sleep = timing.sleep ?? defaultSleep;
  const every = timing.everyMs ?? EVERY_MS;
  const until = now().getTime() + Math.min(Math.max(waitSec, 0), DESKTOP_POLL_SEC) * 1000;
  for (;;) {
    const round = await withTenant(db, signed.tenantId, async (tx) => {
      const [device] = await tx
        .select({ revokedAt: desktopDevice.revokedAt })
        .from(desktopDevice)
        .where(
          and(eq(desktopDevice.tenantId, signed.tenantId), eq(desktopDevice.id, signed.device.id)),
        );
      if (!device || device.revokedAt) return null;
      const jobs = await claimJobs(tx, signed, now());
      const folders = platformFolders(await deviceConnection(tx, signed.device));
      return { jobs, folders };
    });
    if (!round)
      throw new HttpError(401, "device_refused", "this computer isn't paired with Mezonas");
    if (round.jobs.length > 0 || now().getTime() >= until) return round;
    await sleep(every);
  }
}

/**
 * A job's answer from the computer it was handed to: kept once. A job of another computer or
 * client is 404; one already answered, or never handed out, is 409.
 */
export async function answerJob(
  tx: Tx,
  signed: SignedDevice,
  jobId: string,
  body: unknown,
  at: Date,
): Promise<{ kind: string; ok: boolean }> {
  const parsed = DesktopJobResult.safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid_result", "not a job result");
  const [job] = await tx
    .select()
    .from(desktopJob)
    .where(
      and(
        eq(desktopJob.tenantId, signed.tenantId),
        eq(desktopJob.id, jobId),
        eq(desktopJob.deviceId, signed.device.id),
      ),
    )
    .for("update");
  if (!job) throw notFound("job");
  if (!job.sentAt) throw new HttpError(409, "not_sent", "this job wasn't handed to this computer");
  if (job.answeredAt) throw new HttpError(409, "already_answered", "this job was answered");
  await tx
    .update(desktopJob)
    .set({ answeredAt: at, result: parsed.data })
    .where(and(eq(desktopJob.tenantId, signed.tenantId), eq(desktopJob.id, jobId)));
  return { kind: job.kind, ok: parsed.data.ok };
}
