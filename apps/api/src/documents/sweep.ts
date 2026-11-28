// The reading sweep: an uploaded, forwarded or captured document is read after
// the response, in a waitUntil the platform cancels 30 seconds later, one document after another.
// A reading cut off there leaves the document `stored` or `extracting` with no event, and the
// agents that start on `document.extracted` never hear of it. Every few minutes the cron takes a
// few of each client's documents left unread for 10 minutes and reads them again through the same
// path (extractInBackground: the same HIPAA model guard, linking and dispatch); after
// READING_ATTEMPTS readings that never finished, the document is marked failed with
// `document.extraction_failed`, so a person sees it.

import { activeClient, tenant, withTenant } from "@countersign/db";
import { claimUnreadDocuments, giveUpReading, READING_ATTEMPTS } from "@countersign/documents";
import { EmittedEvents } from "@countersign/senses";
import { type SQL, sql } from "drizzle-orm";
import { readsDocuments } from "../compliance/models";
import { MESSAGE_MEDIA_ENTITY } from "../conversations/capture";
import type { Services } from "../http";
import { reportHandled, reportProblem } from "../observability/report";
import { extractInBackground } from "../routes/documents";
import { dispatchAfterCommit } from "../runs/dispatch";

/** The sweep runs every this many minutes… */
export const READING_SWEEP_EVERY_MINUTES = 5;
/** …at this minute of each period (apart from the run reconciler's 4). */
export const READING_SWEEP_MINUTE = 1;
/** Documents received longer ago than this are not read late: they are marked failed. */
// DECISION: a week. A document left unread for longer would start its agents' work on something
// long gone by; a person decides (the failure event) instead.
export const READING_LOOKBACK_MS = 7 * 86_400_000;
/** At most this many documents per client per pass… */
export const READINGS_PER_CLIENT = 3;
/** …and this many per pass in all, so a pass stays short. */
export const READINGS_PER_PASS = 10;

/** A pass stops taking clients once its readings have run this long. */
export const READING_SWEEP_BUDGET_MS = 60_000;

export interface ReadingSweepResult {
  read: number;
  failed: number;
  /** Of `failed`, those marked without an event (received more than READING_LOOKBACK_MS ago). */
  quiet: number;
}

/**
 * A captured message's document while its capture job is still going: an attachment of the
 * message has no outcome yet (conversations/cron.ts restarts such jobs for 3 days). The job reads
 * its documents itself once every attachment is done.
 */
const capturePending: SQL = sql`not ("document"."source" = 'message' and exists (
  select 1 from raw_record m
  where m.tenant_id = "document"."tenant_id"
    and m.id::text = "document"."meta"->>'rawRecordId'
    and m.synced_at > now() - interval '3 days'
    and exists (
      select 1 from jsonb_array_elements_text(coalesce(m.payload->'capture'->'wanted', '[]'::jsonb)) w(i)
      where not exists (
        select 1 from raw_record o
        where o.tenant_id = m.tenant_id and o.connection_id = m.connection_id
          and o.entity_type = ${MESSAGE_MEDIA_ENTITY} and o.external_id = m.external_id || ':' || w.i
      )
    )
))`;

/**
 * One client's share: claims its documents left unread, gives up on those read too often (or too
 * old), and reads the rest, one at a time until `deadline`. Returns what it did.
 */
export async function sweepClientReadings(
  services: Pick<Services, "db" | "env" | "deps">,
  tenantId: string,
  at: Date,
  options: { limit?: number; deadline?: number } = {},
): Promise<ReadingSweepResult> {
  const { db } = services;
  const claim = crypto.randomUUID();
  const claimed = await withTenant(db, tenantId, (tx) =>
    claimUnreadDocuments(tx, {
      tenantId,
      claim,
      limit: options.limit ?? READINGS_PER_CLIENT,
      where: capturePending,
    }),
  );
  const out: ReadingSweepResult = { read: 0, failed: 0, quiet: 0 };
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
    // DECISION: a document received more than a week ago is marked failed quietly (no event, one
    // report per pass for all of them): on the first deploy, documents left unread long ago would
    // otherwise each start a person's work at once.
    const gaveUp = await giveUpReading(db, {
      tenantId,
      documentId: d.id,
      message,
      collect,
      quiet: tooOld,
    });
    if (gaveUp) {
      out.failed++;
      if (tooOld) out.quiet++;
    }
    await dispatchAfterCommit(dispatch, tenantId, collect);
  }
  // One at a time, so a pass out of time leaves the rest claimed; the next pass takes them once the
  // claim is stale. A claim this pass no longer holds is skipped (`not_due`).
  for (const id of toRead) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    await extractInBackground(services, tenantId, [id], { claim });
    out.read++;
  }
  return out;
}

/** The cron's call: every READING_SWEEP_EVERY_MINUTES minutes, each client in its own scope. */
// DECISION: clients are taken in a random order each pass, so the pass's cap and time budget fall
// on every client in turn, not on the first ones listed.
export async function readingSweep(
  services: Pick<Services, "db" | "env" | "deps">,
  at: Date,
): Promise<ReadingSweepResult> {
  const out: ReadingSweepResult = { read: 0, failed: 0, quiet: 0 };
  if (at.getUTCMinutes() % READING_SWEEP_EVERY_MINUTES !== READING_SWEEP_MINUTE) return out;
  // Without a model key nothing is read on arrival either: documents wait for an agent's reading.
  if (!readsDocuments(services)) return out;
  const deadline = Date.now() + READING_SWEEP_BUDGET_MS;
  const clients = await services.db
    .select({ id: tenant.id })
    .from(tenant)
    .where(activeClient())
    .orderBy(sql`random()`);
  for (const client of clients) {
    const left = READINGS_PER_PASS - out.read - out.failed;
    if (left <= 0 || Date.now() >= deadline) break;
    try {
      const done = await sweepClientReadings(services, client.id, at, {
        limit: Math.min(READINGS_PER_CLIENT, left),
        deadline,
      });
      out.read += done.read;
      out.failed += done.failed;
      out.quiet += done.quiet;
    } catch (error) {
      reportHandled(`reading sweep for client ${client.id} failed`, error, {
        job: "reading_sweep",
        client: client.id,
      });
    }
  }
  if (out.quiet > 0) {
    reportProblem("documents left unread for over a week were marked failed without an event", {
      job: "reading_sweep",
      count: String(out.quiet),
    });
  }
  return out;
}
