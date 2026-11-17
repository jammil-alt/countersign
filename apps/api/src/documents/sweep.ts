// The reading sweep: an uploaded, forwarded or captured document is read after
// the response, in a waitUntil the platform cancels 30 seconds later, one document after another.
// A reading cut off there leaves the document `stored` or `extracting` with no event, and the
// agents that start on `document.extracted` never hear of it. Every few minutes the cron takes a
// few of each client's documents left unread for 10 minutes and reads them again through the same
// path (extractInBackground: the same HIPAA model guard, linking and dispatch); after
// READING_ATTEMPTS readings that never finished, the document is marked failed with
// `document.extraction_failed`, so a person sees it.

import { tenant, withTenant } from "@countersign/db";
import { claimUnreadDocuments, giveUpReading, READING_ATTEMPTS } from "@countersign/documents";
import { EmittedEvents } from "@countersign/senses";
import { isNull } from "drizzle-orm";
import type { Services } from "../http";
import { reportHandled } from "../observability/report";
import { extractInBackground } from "../routes/documents";
import { dispatchAfterCommit } from "../runs/dispatch";

/** The sweep runs every this many minutes… */
export const READING_SWEEP_EVERY_MINUTES = 5;
/** …at this minute of each period (apart from the run reconciler's 4). */
export const READING_SWEEP_MINUTE = 1;
/** A reading not started, or not finished, this long after it should have been is left. */
export const READING_STALE_MS = 10 * 60_000;
/** Documents received longer ago than this are not read late: they are marked failed. */
// DECISION: a week. A document left unread for longer would start its agents' work on something
// long gone by; a person decides (the failure event) instead.
export const READING_LOOKBACK_MS = 7 * 86_400_000;
/** At most this many documents per client per pass… */
export const READINGS_PER_CLIENT = 3;
/** …and this many per pass in all, so a pass stays short. */
export const READINGS_PER_PASS = 10;

export interface ReadingSweepResult {
  read: number;
  failed: number;
}

/**
 * One client's share: claims its documents left unread, gives up on those read too often (or too
 * old), and reads the rest. Returns what it did.
 */
export async function sweepClientReadings(
  services: Pick<Services, "db" | "env" | "deps">,
  tenantId: string,
  at: Date,
  limit = READINGS_PER_CLIENT,
): Promise<ReadingSweepResult> {
  const { db } = services;
  const claimed = await withTenant(db, tenantId, (tx) =>
    claimUnreadDocuments(tx, {
      tenantId,
      staleBefore: new Date(at.getTime() - READING_STALE_MS),
      now: at,
      limit,
    }),
  );
  const out: ReadingSweepResult = { read: 0, failed: 0 };
  const oldest = at.getTime() - READING_LOOKBACK_MS;
  const toRead: string[] = [];
  const dispatch = { db, instances: services.deps.instances(services.env) };
  for (const d of claimed) {
    const tooOld = d.receivedAt.getTime() < oldest;
    if (d.attempts < READING_ATTEMPTS && !tooOld) {
      toRead.push(d.id);
      continue;
    }
    const collect = new EmittedEvents();
    const message = tooOld
      ? "we did not read this document when it arrived"
      : `we could not finish reading this document after ${READING_ATTEMPTS} tries`;
    if (await giveUpReading(db, { tenantId, documentId: d.id, message, collect })) out.failed++;
    await dispatchAfterCommit(dispatch, tenantId, collect);
  }
  if (toRead.length > 0) {
    await extractInBackground(services, tenantId, toRead);
    out.read += toRead.length;
  }
  return out;
}

/** The cron's call: every READING_SWEEP_EVERY_MINUTES minutes, each client in its own scope. */
export async function readingSweep(
  services: Pick<Services, "db" | "env" | "deps">,
  at: Date,
): Promise<ReadingSweepResult> {
  const out: ReadingSweepResult = { read: 0, failed: 0 };
  if (at.getUTCMinutes() % READING_SWEEP_EVERY_MINUTES !== READING_SWEEP_MINUTE) return out;
  // Without a model key nothing is read on arrival either: documents wait for an agent's reading.
  if (!services.deps.extractionTransport(services.env)) return out;
  const clients = await services.db
    .select({ id: tenant.id })
    .from(tenant)
    .where(isNull(tenant.retiredAt));
  for (const client of clients) {
    const left = READINGS_PER_PASS - out.read - out.failed;
    if (left <= 0) break;
    try {
      const done = await sweepClientReadings(
        services,
        client.id,
        at,
        Math.min(READINGS_PER_CLIENT, left),
      );
      out.read += done.read;
      out.failed += done.failed;
    } catch (error) {
      reportHandled(`reading sweep for client ${client.id} failed`, error, {
        job: "reading_sweep",
        client: client.id,
      });
    }
  }
  return out;
}
