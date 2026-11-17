// QuickBooks sync for one connection (plan M9): one page per durable step. Each step reads the
// stored cursor, reads the next page from QuickBooks (./store.ts writes it), downloads the files of
// attachments it hasn't seen, and stores records, documents and the next cursor in one transaction
// for the connection's one client. A sync that dies part way starts again from the stored cursor;
// raw records make a page read twice harmless. Webhooks, the cron and the operator only start one.

import { dbConnectionAttention } from "@countersign/agents";
import {
  type AttachmentRef,
  attentionReasonOf,
  type ConnectionRef,
  type ContentStore,
  type CredentialsAccessor,
  noopLogger,
  QBO_CONNECTOR_ID,
  QboApiError,
  type QboConnector,
  qboAttachmentFailures,
  qboNoteAttachmentFailure,
  qboSyncPage,
  type RawRecordInput,
  ReconnectRequiredError,
  readQboSyncCursor,
} from "@countersign/connectors";
import { mapQboAttachable } from "@countersign/core";
import { connection, type Db, withTenant } from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { and, eq } from "drizzle-orm";
import { reportProblem } from "../observability/report";
import type { Platform } from "../platform";
import { senseEmitter } from "../runs/dispatch";
import type { QboSyncParams } from "./instances";
import { type DownloadedFile, knownRecords, recordKey, storeQboPage } from "./store";
import { cursorKeepingClaim } from "./sync-cursor";

export interface QboSyncDeps {
  db: Db;
  platform: Platform;
  content: ContentStore;
  /** One connection's credentials, each read and write in its own transaction (refreshes stick). */
  credentials: (conn: ConnectionRef) => CredentialsAccessor;
  now?: () => Date;
  /** Attachment bytes one step downloads at most (tests set a small one). */
  attachmentBytesPerStep?: number;
}

export interface QboSyncStepResult {
  done: boolean;
  stored: number;
  documents: number;
  /** Why nothing was read (not connected, needs a new sign-in). */
  skipped?: string;
  /** Attachments stored without their file: it failed to download too many times. */
  skippedFiles?: number;
  /** Event ids raised by this page, dispatched by the caller after the step. */
  eventIds: string[];
}

/** Attachments larger than our documents may be are not downloaded. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
// DECISION (audit 2.3): one step downloads at most 16 MB of attachments (plus the one file that
// crosses it, at most 32 MB), well inside a Worker's 128 MB and a step's 5 minutes; what is left
// of the page is stored by the next steps, so a retry never downloads what a step stored.
export const ATTACHMENT_BYTES_PER_STEP = 16 * 1024 * 1024;
// DECISION (audit 2.3 review): a file that fails to download three times (a timeout, QuickBooks'
// storage answering 5xx), each try a step of its own, is skipped: its attachment is stored without
// a document, so one file can never stop the sync.
export const ATTACHMENT_TRIES = 3;

/** A file failed to download, before anything else of its step was downloaded. */
class AttachmentFailed extends Error {
  constructor(
    readonly attachableId: string,
    readonly error: unknown,
  ) {
    super(`attachment ${attachableId} failed to download`);
  }
}

export function qboConnectorOf(platform: Platform): QboConnector | null {
  const c = platform.connectors.get(QBO_CONNECTOR_ID) as QboConnector | undefined;
  return c && typeof c.client === "function" ? c : null;
}

function refOf(row: typeof connection.$inferSelect): ConnectionRef {
  return {
    id: row.id,
    tenantId: row.tenantId,
    connector: row.connector,
    status: row.status,
    externalAccountId: row.externalAccountId,
    config: row.config as ConnectionRef["config"],
    permissions: row.permissions,
  };
}

/** Reads and stores the next page for one connection. */
export async function qboSyncStep(
  deps: QboSyncDeps,
  params: Pick<QboSyncParams, "tenantId" | "connectionId">,
  /** `first`: the sync's first page, which reads CDC whatever the cursor's turn. */
  opts: { first?: boolean } = {},
): Promise<QboSyncStepResult & { events: EventRow[] }> {
  const now = deps.now ?? (() => new Date());
  const { tenantId, connectionId } = params;
  const skip = (why: string) => ({
    done: true,
    stored: 0,
    documents: 0,
    skipped: why,
    eventIds: [],
    events: [],
  });
  const connector = qboConnectorOf(deps.platform);
  if (!connector) return skip("QuickBooks is not registered here");
  const row = await withTenant(deps.db, tenantId, async (tx) => {
    const [r] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
    return r;
  });
  if (!row || row.connector !== QBO_CONNECTOR_ID) return skip("no such QuickBooks connection");
  if (row.status !== "connected") return skip(`the connection is ${row.status}`);
  const ref = refOf(row);
  const ctx = {
    tenantId,
    connection: ref,
    credentials: deps.credentials(ref),
    logger: noopLogger,
    now,
  };
  let page: Awaited<ReturnType<typeof qboSyncPage>>;
  let files: Map<string, DownloadedFile>;
  let records: RawRecordInput[];
  let cursor: object;
  let done: boolean;
  let skippedFiles: string[] = [];
  const stored = readQboSyncCursor(row.syncCursor);
  try {
    const client = await connector.client(ctx);
    page = await qboSyncPage(client, stored, { now: now(), cdcFirst: opts.first === true });
    if (page.deletionsMayBeMissed) {
      // Audit 2.5: one entity alone reached CDC's cap; its deletions past the cut can't be read.
      reportProblem("qbo CDC cap: deletions may be missed", {
        connector: QBO_CONNECTOR_ID,
        entity: page.deletionsMayBeMissed,
        connectionId,
      });
    }
    const known = await withTenant(deps.db, tenantId, (tx) =>
      knownRecords(tx, tenantId, connectionId, page.records),
    );
    const got = await downloads(
      page.records,
      known,
      (ref) => connector.downloadAttachment?.(ctx, ref) ?? Promise.resolve(null),
      page.resumeAfter ? (deps.attachmentBytesPerStep ?? ATTACHMENT_BYTES_PER_STEP) : Infinity,
      qboAttachmentFailures(stored),
    );
    files = got.files;
    skippedFiles = got.skipped;
    // The budget ran out part way: the records before it are stored now, the rest next step.
    const resume = got.kept < page.records.length ? page.resumeAfter : undefined;
    records = resume ? page.records.slice(0, got.kept) : page.records;
    cursor = resume ? resume(got.kept) : page.next;
    done = resume ? false : page.done;
  } catch (error) {
    if (error instanceof AttachmentFailed) {
      // Counted where the next try finds it; the step fails, so its retry waits.
      const noted = qboNoteAttachmentFailure(stored, error.attachableId);
      if (noted) {
        await withTenant(deps.db, tenantId, (tx) =>
          tx
            .update(connection)
            .set({ syncCursor: cursorKeepingClaim(noted, now()) })
            .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId))),
        );
      }
      throw error.error;
    }
    if (error instanceof ReconnectRequiredError) {
      // The client must sign in again (`signin_expired`), or renewing our access has failed for a
      // day (`refresh_failing`: the connection stays connected and the next sync tries again):
      // the connection needs attention (both surfaces show it).
      // v0.12 W1-H: its event is dispatched after the step, with the pages'.
      const reason = attentionReasonOf(error);
      const collect: EventRow[] = [];
      const emit = senseEmitter(deps.platform.events, { collect });
      await dbConnectionAttention(deps.db, { emit }).needsAttention(tenantId, {
        connectionId,
        reason,
        detail: error.message,
      });
      return {
        ...skip(
          reason === "refresh_failing"
            ? "we can't reach QuickBooks right now and are looking into it"
            : "the client needs to sign in to QuickBooks again",
        ),
        eventIds: collect.map((e) => e.id),
        events: collect,
      };
    }
    throw error;
  }
  const result = await withTenant(deps.db, tenantId, (tx) =>
    storeQboPage(tx, deps.content, {
      tenantId,
      connectionId,
      records,
      files,
      cursor: cursor as Record<string, never>,
      initial: page.initial,
      now: now(),
      externalAccountId: row.externalAccountId,
    }),
  );
  if (result.dropped) return skip("the connection was signed in to another company");
  for (const id of skippedFiles) {
    // No content: the attachment's id and the connection only.
    console.warn("qbo attachment stored without its file", {
      connectionId,
      attachableId: id,
      tries: ATTACHMENT_TRIES,
    });
  }
  return {
    done,
    ...(skippedFiles.length > 0 ? { skippedFiles: skippedFiles.length } : {}),
    stored: result.stored,
    documents: result.documents,
    eventIds: result.events.map((e) => e.id),
    events: result.events,
  };
}

type Download = (
  ref: AttachmentRef,
) => Promise<{ bytes: Uint8Array; mime: string; filename: string } | null>;

/**
 * Downloads the files of new attachments (notes have none), in order, until `budget` bytes are
 * downloaded; `kept` is how many records lead up to where it stopped (all of them when it didn't).
 * A file that fails stops the step there when others were downloaded (they are kept, and it is
 * tried first next step); as the step's first file it fails the step (`AttachmentFailed`), and
 * after `ATTACHMENT_TRIES` tries it is skipped (`skipped`).
 */
async function downloads(
  records: RawRecordInput[],
  known: Set<string>,
  download: Download,
  budget: number,
  failures: Record<string, number> = {},
): Promise<{ files: Map<string, DownloadedFile>; kept: number; skipped: string[] }> {
  const files = new Map<string, DownloadedFile>();
  const skipped: string[] = [];
  let bytes = 0;
  for (const [i, r] of records.entries()) {
    if (r.entityType !== "Attachable" || r.isDeleted || known.has(recordKey(r))) continue;
    const a = mapQboAttachable(r.payload);
    if (!a.fileName || (a.size !== null && a.size > MAX_ATTACHMENT_BYTES)) continue;
    // At least one file a step, however large; then only while the budget holds.
    if (bytes > 0 && bytes + (a.size ?? 0) > budget) return { files, kept: i, skipped };
    if (bytes >= budget) return { files, kept: i, skipped };
    try {
      const file = await download({
        externalId: a.externalId,
        filename: a.fileName,
        mime: a.contentType ?? "application/octet-stream",
        ...(a.size !== null ? { size: a.size } : {}),
      });
      if (file) {
        files.set(a.externalId, { bytes: file.bytes, mime: file.mime, filename: file.filename });
        bytes += file.bytes.length;
      }
    } catch (error) {
      // A file QuickBooks can't give (gone, refused) is skipped; a busy QuickBooks fails the
      // step, which retries the page.
      if (error instanceof QboApiError && !error.retryable) {
        console.warn(`qbo attachment ${a.externalId} not downloaded: ${error.message}`);
        continue;
      }
      if (error instanceof ReconnectRequiredError) throw error;
      if (files.size > 0 && Number.isFinite(budget)) return { files, kept: i, skipped };
      if ((failures[a.externalId] ?? 0) + 1 >= ATTACHMENT_TRIES) {
        skipped.push(a.externalId);
        continue;
      }
      throw new AttachmentFailed(a.externalId, error);
    }
  }
  return { files, kept: records.length, skipped };
}

/** The durable part of a Workflow step, as the sync uses it (tests pass an inline runner). */
export interface SyncStepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** At most this many pages per sync instance; the next sync goes on from the stored cursor. */
export const MAX_SYNC_PAGES = 100;

/**
 * A whole sync: pages until caught up (or MAX_SYNC_PAGES). `dispatch` sends each page's events
 * after its step committed; the cron re-sends any it misses.
 */
export async function runQboSync(
  deps: QboSyncDeps,
  params: QboSyncParams,
  runner: SyncStepRunner,
  dispatch: (eventIds: string[]) => Promise<unknown> = async () => {},
): Promise<{
  pages: number;
  stored: number;
  documents: number;
  skipped?: string;
  skippedFiles?: number;
}> {
  let stored = 0;
  let documents = 0;
  let skippedFiles = 0;
  const totals = () => ({
    stored,
    documents,
    ...(skippedFiles > 0 ? { skippedFiles } : {}),
  });
  for (let i = 0; i < MAX_SYNC_PAGES; i++) {
    const step = await runner.do(`page-${i}`, async () => {
      const { events: _events, ...r } = await qboSyncStep(deps, params, { first: i === 0 });
      return r;
    });
    stored += step.stored;
    documents += step.documents;
    skippedFiles += step.skippedFiles ?? 0;
    if (step.eventIds.length > 0) {
      await runner.do(`dispatch-${i}`, async () => {
        await dispatch(step.eventIds);
        return null;
      });
    }
    if (step.skipped) return { pages: i + 1, ...totals(), skipped: step.skipped };
    if (step.done) return { pages: i + 1, ...totals() };
  }
  return { pages: MAX_SYNC_PAGES, ...totals() };
}

// v0.12 W1-H: a page's events are dispatched by id after its step committed, under the claim
// (runs/dispatch.ts), so the sweep and this never take one twice.
export { dispatchByIds } from "../runs/dispatch";
