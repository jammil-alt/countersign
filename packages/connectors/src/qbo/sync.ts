// What QuickBooks sync reads, one page at a time (ARCHITECTURE §6.2): first an initial sync of each
// entity with paging, then change data capture (CDC) from where it left off. Each page answers the
// raw records it read and the cursor to store with them, so the caller writes both in one
// transaction and a crash or a second sync starts from the stored cursor. Writing is the caller's
// (apps/api): this file only reads QuickBooks.
//
// Attachments (audit 2.3) are read apart from the rest, in small pages by when they last changed,
// so their files can be downloaded a few at a time: CDC goes first and keeps business data coming
// while the attachments' history catches up, one attachment page between two CDC reads. A CDC
// answer at the cap (audit 2.5) is not trusted: each entity is read on its own, by CDC and, where
// one entity alone reaches the cap, by paged queries, before the CDC point moves on.

import {
  isQboArEntity,
  isQboTransactionEntity,
  QBO_SYNCED_ENTITIES,
  type QboEntity,
} from "@countersign/core";
import { z } from "zod";
import type { RawRecordInput } from "../connector";
import { type QboClient, qboLiteral } from "./api";

/** A place in a list read in order of last change: from `since`, the first `skip` rows done. */
const TimeCursor = z.object({
  /** A QBO time literal (UTC, `Z`, whole seconds). */
  since: z.string(),
  /** Rows of the second `since` already read: only when that second filled whole pages. */
  skip: z.number().int().min(0),
});

/** Where the attachments stand (audit 2.3). */
const AttachmentsCursor = TimeCursor.extend({
  /** Attachments changed before this time are the initial sync's history (no events). */
  historyUntil: z.string().optional(),
  /** More attachments are waiting (a backfill, or a page cut short). */
  more: z.boolean().optional(),
  /**
   * Failed tries to download a file, by attachment id: how many, and when the last was counted
   * (at most one counts in ten minutes, so a step's quick retries count once).
   */
  failures: z
    .record(z.string(), z.object({ n: z.number().int().min(1), at: z.string() }))
    .optional(),
  /**
   * Attachments stored without their file after failed tries, and when each was last tried: each
   * is tried again once a day (`history`: it came as the initial sync's history).
   */
  skipped: z
    .array(z.object({ id: z.string(), at: z.string(), history: z.boolean().optional() }))
    .max(50)
    .optional(),
});

export const QboSyncCursor = z.discriminatedUnion("phase", [
  z.object({
    v: z.literal(1),
    phase: z.literal("initial"),
    entity: z.enum(QBO_SYNCED_ENTITIES),
    /** QBO's STARTPOSITION, 1-based. */
    start: z.number().int().min(1),
    /** Transactions dated on or after this day (yyyy-mm-dd) come in. */
    sinceDate: z.string(),
    /**
     * Invoices and payments dated on or after this day come in (v0.12); absent in a cursor stored
     * before, which then reads them from `sinceDate`.
     */
    arSinceDate: z.string().optional(),
    /** Where CDC picks up once the initial sync is done: when it started, less a margin. */
    changedSince: z.string(),
    /** The entities this initial read walks, in order (absent: all of them). */
    entities: z.array(z.enum(QBO_SYNCED_ENTITIES)).min(1).optional(),
    /** A backfill's: the attachments' place, kept for the CDC it returns to. */
    attachments: AttachmentsCursor.optional(),
  }),
  z.object({
    v: z.literal(1),
    phase: z.literal("cdc"),
    changedSince: z.string(),
    /** v0.12: the accounts receivable entities have had their initial read. */
    ar: z.boolean().optional(),
    /** B-2 (docs/plan.md §1.79): the ledger (accounts, classes, locations) has had its initial read. */
    ledger: z.boolean().optional(),
    /** Audit 2.3: the attachments' place (absent: from `changedSince`). */
    attachments: AttachmentsCursor.optional(),
    /** The next page reads attachments, not CDC. */
    turn: z.literal("attachments").optional(),
    /**
     * Audit 2.5: a CDC answer reached the cap, so these entities are read one at a time from
     * `changedSince` (`query`: the one in hand reached the cap on its own and is paged by query);
     * `changedSince` moves to `until` once every one is read.
     */
    catchUp: z
      .object({
        entities: z.array(z.enum(QBO_SYNCED_ENTITIES)).min(1),
        until: z.string(),
        query: TimeCursor.optional(),
      })
      .optional(),
  }),
]);

/** The v0.12 entities a connection made before them reads once, from its CDC point. */
export const QBO_AR_BACKFILL = ["Customer", "Invoice", "Payment"] as const satisfies QboEntity[];
/** B-2: the ledger, read once by a connection made before it was synced. */
export const QBO_LEDGER_BACKFILL = [
  "Account",
  "Class",
  "Department",
] as const satisfies QboEntity[];
export type QboSyncCursor = z.infer<typeof QboSyncCursor>;

/** The stored cursor, or null when there is none or it can't be read (a fresh initial sync). */
export function readQboSyncCursor(stored: unknown): QboSyncCursor | null {
  const parsed = QboSyncCursor.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export interface QboSyncOptions {
  now: Date;
  /** How far back an initial sync reads transactions and attachments. */
  initialDays?: number;
  /** How far back an initial sync reads invoices and payments. */
  arInitialDays?: number;
  /** Rows per initial page (QBO allows up to 1000). */
  pageSize?: number;
  /**
   * The first page of a sync: CDC reads whatever the stored cursor's turn says, so a failing
   * attachment page never holds business data up (the attachments come next).
   */
  cdcFirst?: boolean;
}

export interface QboSyncPage {
  records: RawRecordInput[];
  /** The cursor to store with these records. */
  next: QboSyncCursor;
  /** No more pages for now (CDC is caught up). */
  done: boolean;
  /** These records come from the initial sync (history, not news: no events). */
  initial: boolean;
  /**
   * Attachment pages (audit 2.3): the cursor to store when only the first `kept` records are
   * stored (the step's download budget ran out); more pages follow.
   */
  resumeAfter?: (kept: number) => QboSyncCursor;
  /**
   * Audit 2.5: this entity alone reached CDC's cap, so its deletions past the cut may not be seen
   * (the caller reports it).
   */
  deletionsMayBeMissed?: QboEntity;
}

// DECISION: an initial sync reads 90 days of transactions and attachments (by transaction date,
// and by last change for attachments), and every vendor and item; it raises no events, so
// connecting QuickBooks doesn't start a run for every old bill. Changes after it are news.
export const QBO_INITIAL_DAYS = 90;
// v0.12 W1-F (ARCHITECTURE §6.2): invoices and payments for 365 days; customers whole.
export const QBO_AR_INITIAL_DAYS = 365;
export const QBO_PAGE_SIZE = 200;
// DECISION (audit 2.3): attachments come 25 to a page; the caller downloads their files within a
// byte budget per step and stores the rest of the page in a later one.
export const QBO_ATTACHMENT_PAGE_SIZE = 25;
/** Rows per query when a CDC answer reached the cap (QBO's most). */
export const QBO_QUERY_MAX = 1000;
/** QBO's CDC looks back at most 30 days; past that, sync starts over. */
// UNCHECKED (NOTES.md): the 30-day limit, and whether the 1000-object cap is per answer or per
// entity (read as either: audit 2.5).
export const QBO_CDC_MAX_DAYS = 30;
export const QBO_CDC_CAP = 1000;
/** What an initial sync reads entity by entity: everything but attachments, read on their own. */
const INITIAL_ENTITIES = QBO_SYNCED_ENTITIES.filter((e) => e !== "Attachable");
/** Changes are read from a minute before the last read started, to cover clock drift. */
const OVERLAP_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** A fresh initial sync. */
export function startQboSync(opts: QboSyncOptions): QboSyncCursor {
  const days = opts.initialDays ?? QBO_INITIAL_DAYS;
  return {
    v: 1,
    phase: "initial",
    entity: INITIAL_ENTITIES[0] as QboEntity,
    start: 1,
    sinceDate: isoDay(new Date(opts.now.getTime() - days * DAY_MS)),
    arSinceDate: isoDay(
      new Date(opts.now.getTime() - (opts.arInitialDays ?? QBO_AR_INITIAL_DAYS) * DAY_MS),
    ),
    changedSince: new Date(opts.now.getTime() - OVERLAP_MS).toISOString(),
  };
}

function initialQuery(
  entity: QboEntity,
  sinceDate: string,
  start: number,
  size: number,
  arSinceDate: string = sinceDate,
): string {
  // DECISION: vendors, items and customers come in whole (active ones: QBO's default for name
  // lists).
  const where = isQboTransactionEntity(entity)
    ? ` where TxnDate >= ${qboLiteral(sinceDate)}`
    : isQboArEntity(entity)
      ? ` where TxnDate >= ${qboLiteral(arSinceDate)}`
      : "";
  return `select * from ${entity}${where} orderby Metadata.LastUpdatedTime startposition ${start} maxresults ${size}`;
}

const Row = z.looseObject({
  Id: z.union([z.string(), z.number()]).transform(String),
  SyncToken: z.union([z.string(), z.number()]).transform(String).optional(),
  status: z.string().optional(),
  MetaData: z.looseObject({ LastUpdatedTime: z.string().optional() }).optional(),
});

/** One row as QBO sent it → a raw record (deleted rows from CDC included). */
export function qboRawRecord(entity: string, row: unknown): RawRecordInput | null {
  const r = Row.safeParse(row);
  if (!r.success) return null;
  const deleted = r.data.status === "Deleted";
  return {
    entityType: entity,
    externalId: r.data.Id,
    // DECISION: a deletion is stored once as its own version, `deleted`, flagged is_deleted.
    externalVersion: deleted ? "deleted" : (r.data.SyncToken ?? null),
    payload: row as RawRecordInput["payload"],
    ...(deleted ? { isDeleted: true } : {}),
  };
}

/** Reads the next page for `cursor` (null: start an initial sync). */
export async function qboSyncPage(
  client: QboClient,
  cursor: QboSyncCursor | null,
  opts: QboSyncOptions,
): Promise<QboSyncPage> {
  let c = cursor ?? startQboSync(opts);
  // A cursor stored while an initial sync read attachments with everything else goes on with
  // them as the attachments' own read, from the same place, after CDC.
  if (c.phase === "initial" && c.entity === "Attachable") c = afterInitial(c, c.start - 1);
  if (
    c.phase === "cdc" &&
    opts.now.getTime() - Date.parse(c.changedSince) > (QBO_CDC_MAX_DAYS - 1) * DAY_MS
  ) {
    // Too long since the last read for CDC: read everything again (raw records dedupe it).
    c = startQboSync(opts);
  }
  if (c.phase === "cdc" && (c.ar !== true || c.ledger !== true)) c = backfill(c, opts);
  if (c.phase === "initial") return initialPage(client, c, opts);
  if (c.catchUp) return catchUpPage(client, c, c.catchUp);
  if (c.turn === "attachments" && opts.cdcFirst !== true) return attachmentPage(client, c);
  return cdcPage(client, c, opts);
}

type CdcCursor = Extract<QboSyncCursor, { phase: "cdc" }>;
type InitialCursor = Extract<QboSyncCursor, { phase: "initial" }>;
type AttachmentsPlace = z.infer<typeof AttachmentsCursor>;
type TimePlace = z.infer<typeof TimeCursor>;

/**
 * The CDC cursor an initial read hands on to. `attachmentsDone`: how many attachments a cursor
 * stored by an earlier initial read had already read.
 */
function afterInitial(c: InitialCursor, attachmentsDone = 0): CdcCursor {
  // B-2: a read that walked the ledger (a whole initial read, or a backfill that included it) has
  // done it; an older backfill of the AR entities alone leaves it for the next.
  const ledger =
    c.entities === undefined || QBO_LEDGER_BACKFILL.every((e) => c.entities?.includes(e));
  // A whole initial read leaves the attachments' history to read, after CDC; a backfill keeps the
  // attachments' place it came with.
  const attachments: AttachmentsPlace | undefined =
    c.entities === undefined
      ? {
          since: `${c.sinceDate}T00:00:00Z`,
          skip: attachmentsDone,
          historyUntil: c.changedSince,
          more: true,
        }
      : c.attachments;
  return {
    v: 1,
    phase: "cdc",
    changedSince: c.changedSince,
    ar: true,
    ledger,
    ...(attachments ? { attachments } : {}),
  };
}

async function initialPage(
  client: QboClient,
  c: InitialCursor,
  opts: QboSyncOptions,
): Promise<QboSyncPage> {
  const size = opts.pageSize ?? QBO_PAGE_SIZE;
  const { rows } = await client.query(
    initialQuery(c.entity, c.sinceDate, c.start, size, c.arSinceDate),
    c.entity,
  );
  const records = rows
    .map((r) => qboRawRecord(c.entity, r))
    .filter((r): r is RawRecordInput => r !== null);
  if (rows.length >= size) {
    return { records, next: { ...c, start: c.start + rows.length }, done: false, initial: true };
  }
  const order: readonly QboEntity[] = c.entities ?? INITIAL_ENTITIES;
  const i = order.indexOf(c.entity);
  const nextEntity = order[i + 1];
  if (nextEntity) {
    return { records, next: { ...c, entity: nextEntity, start: 1 }, done: false, initial: true };
  }
  return { records, next: afterInitial(c), done: false, initial: true };
}

/**
 * A connection whose CDC began before v0.12 reads customers, invoices and payments once (as
 * history: no events), then carries on with CDC from where it was, so nothing else is read twice.
 */
// DECISION: the backfill keeps the stored CDC point, so changes to bills and purchases since then
// still come by CDC with their events; only the AR entities' history is new.
// B-2: the ledger is read once the same way, after the AR entities if both are due.
function backfill(c: CdcCursor, opts: QboSyncOptions) {
  const start = startQboSync(opts);
  if (start.phase !== "initial") throw new Error("unreachable");
  const entities: QboEntity[] = [
    ...(c.ar === true ? [] : QBO_AR_BACKFILL),
    ...(c.ledger === true ? [] : QBO_LEDGER_BACKFILL),
  ];
  const [first] = entities;
  if (!first) throw new Error("unreachable");
  return {
    ...start,
    entity: first,
    entities,
    changedSince: c.changedSince,
    ...(c.attachments ? { attachments: c.attachments } : {}),
  } satisfies QboSyncCursor;
}

const CdcAnswer = z.looseObject({
  CDCResponse: z
    .array(
      z.looseObject({
        QueryResponse: z.array(z.record(z.string(), z.unknown())).optional(),
      }),
    )
    .optional(),
});

/** One CDC read: each synced entity's rows as QBO sent them, and how many objects in all. */
async function readCdc(
  client: QboClient,
  entities: readonly QboEntity[],
  changedSince: string,
): Promise<{ blocks: Map<QboEntity, unknown[]>; total: number }> {
  const body = CdcAnswer.parse(
    // Floored to whole seconds like a query's times: it only reads a little more.
    await client.get("/cdc", { entities: entities.join(","), changedSince: qboTime(changedSince) }),
  );
  const blocks = new Map<QboEntity, unknown[]>();
  let total = 0;
  for (const block of body.CDCResponse ?? []) {
    for (const qr of block.QueryResponse ?? []) {
      for (const [entity, rows] of Object.entries(qr)) {
        if (!Array.isArray(rows) || !(entities as readonly string[]).includes(entity)) continue;
        const key = entity as QboEntity;
        blocks.set(key, [...(blocks.get(key) ?? []), ...rows]);
        total += rows.length;
      }
    }
  }
  return { blocks, total };
}

/**
 * The raw records of CDC rows. Attachments that are there (not deleted) are left to the
 * attachments' own read, which downloads their files (`attachments`: whether there were any).
 */
function cdcRecords(blocks: Map<QboEntity, unknown[]>): {
  records: RawRecordInput[];
  attachments: boolean;
} {
  const records: RawRecordInput[] = [];
  let attachments = false;
  for (const [entity, rows] of blocks) {
    for (const row of rows) {
      const rec = qboRawRecord(entity, row);
      if (!rec) continue;
      if (entity === "Attachable" && !rec.isDeleted) {
        attachments = true;
        continue;
      }
      records.push(rec);
    }
  }
  return { records, attachments };
}

/** The attachments' place for a CDC cursor (absent: from its CDC point). */
function attachmentsOf(c: CdcCursor): AttachmentsPlace {
  return c.attachments ?? { since: qboTime(c.changedSince), skip: 0 };
}

/**
 * The CDC cursor after a read that saw every change up to `startedAt`; the attachments' read is
 * next when CDC named attachments or some are still waiting.
 */
function caughtUp(c: CdcCursor, startedAt: Date, attachments: boolean): CdcCursor {
  const { catchUp: _c, turn: _t, ...rest } = c;
  const due =
    attachments ||
    c.attachments?.more === true ||
    c.turn === "attachments" ||
    // A file given up on is due its daily try.
    qboAttachmentRetryDue(c, startedAt) !== null;
  return {
    ...rest,
    ar: true,
    ledger: true,
    changedSince: new Date(startedAt.getTime() - OVERLAP_MS).toISOString(),
    // The attachments' place is fixed before the CDC point moves on, so none is missed.
    ...(due ? { attachments: attachmentsOf(c), turn: "attachments" as const } : {}),
  };
}

async function cdcPage(
  client: QboClient,
  c: CdcCursor,
  opts: QboSyncOptions,
): Promise<QboSyncPage> {
  const startedAt = opts.now;
  const { blocks, total } = await readCdc(client, QBO_SYNCED_ENTITIES, c.changedSince);
  const capped =
    total >= QBO_CDC_CAP || [...blocks.values()].some((rows) => rows.length >= QBO_CDC_CAP);
  if (capped) {
    // DECISION (audit 2.5): an answer at the cap may be cut anywhere (Intuit's docs speak of
    // 1,000 objects per answer, with deletions after the rest), so none of it is kept: each
    // entity is read on its own from the same point, and the CDC point moves only once all are.
    return {
      records: [],
      next: {
        ...c,
        catchUp: { entities: [...QBO_SYNCED_ENTITIES], until: startedAt.toISOString() },
      },
      done: false,
      initial: false,
    };
  }
  const { records, attachments } = cdcRecords(blocks);
  const next = caughtUp(c, startedAt, attachments);
  return { records, next, done: next.turn === undefined, initial: false };
}

/** One entity of the catch-up after a CDC answer at the cap (audit 2.5). */
async function catchUpPage(
  client: QboClient,
  c: CdcCursor,
  cu: NonNullable<CdcCursor["catchUp"]>,
): Promise<QboSyncPage> {
  const [entity, ...rest] = cu.entities as [QboEntity, ...QboEntity[]];
  const onward = (records: RawRecordInput[]): QboSyncPage => {
    if (rest.length > 0) {
      return {
        records,
        next: { ...c, catchUp: { entities: rest, until: cu.until } },
        done: false,
        initial: false,
      };
    }
    // Every entity is read up to when the catch-up began: CDC goes on from there, after a look at
    // the attachments.
    return {
      records,
      next: caughtUp(c, new Date(cu.until), true),
      done: false,
      initial: false,
    };
  };
  if (cu.query) {
    // DECISION (audit 2.5): name lists bring their inactive records too: making a record inactive
    // is how QuickBooks deletes a vendor, customer, item or account.
    const active = QBO_NAME_LISTS.has(entity) ? " and Active in (true, false)" : "";
    const sql = `select * from ${entity} where Metadata.LastUpdatedTime >= ${qboLiteral(qboTime(cu.query.since))}${active} orderby Metadata.LastUpdatedTime startposition ${cu.query.skip + 1} maxresults ${QBO_QUERY_MAX}`;
    const { rows } = await client.query(sql, entity);
    const records = rows
      .map((r) => qboRawRecord(entity, r))
      .filter((r): r is RawRecordInput => r !== null);
    if (rows.length < QBO_QUERY_MAX) return onward(records);
    return {
      records,
      next: { ...c, catchUp: { ...cu, query: advance(cu.query, rows, true) } },
      done: false,
      initial: false,
    };
  }
  const { blocks } = await readCdc(client, [entity], c.changedSince);
  const rows = blocks.get(entity) ?? [];
  const { records } = cdcRecords(blocks);
  // Under the cap on its own, an entity's answer is whole, deletions included. (Attachments that
  // are there come by their own read whatever CDC says.)
  if (rows.length < QBO_CDC_CAP || entity === "Attachable") return onward(records);
  // DECISION (audit 2.5): an entity at the cap on its own is paged by query from the CDC point. A
  // query can't see deletions: those this answer carries are kept; any it cut off are not seen
  // (NOTES.md "To verify").
  return {
    records: records.filter((r) => r.isDeleted),
    next: { ...c, catchUp: { ...cu, query: { since: qboTime(c.changedSince), skip: 0 } } },
    done: false,
    initial: false,
    deletionsMayBeMissed: entity,
  };
}

/**
 * One page of attachments in order of last change (audit 2.3). The caller downloads their files;
 * when its budget runs out it stores the first ones and `resumeAfter` them. Between two attachment
 * pages CDC reads once, so business data keeps coming while a backlog of files catches up.
 */
async function attachmentPage(client: QboClient, c: CdcCursor): Promise<QboSyncPage> {
  const a = attachmentsOf(c);
  const sql = `select * from Attachable where Metadata.LastUpdatedTime >= ${qboLiteral(qboTime(a.since))} orderby Metadata.LastUpdatedTime startposition ${a.skip + 1} maxresults ${QBO_ATTACHMENT_PAGE_SIZE}`;
  const { rows } = await client.query(sql, "Attachable");
  let taken = rows;
  let initial = false;
  let historyUntil = a.historyUntil;
  if (historyUntil) {
    // The initial sync's history comes as history (no events) and news as news: a page is one or
    // the other.
    const history = leadingBefore(rows, Date.parse(historyUntil));
    if (history > 0) {
      taken = rows.slice(0, history);
      initial = true;
    } else if (rows.length > 0) {
      historyUntil = undefined;
    }
  }
  const records: RawRecordInput[] = [];
  /** Where each record's row is in `taken`. */
  const at: number[] = [];
  for (const [i, row] of taken.entries()) {
    const rec = qboRawRecord("Attachable", row);
    if (rec) {
      records.push(rec);
      at.push(i);
    }
  }
  const more = rows.length >= QBO_ATTACHMENT_PAGE_SIZE || taken.length < rows.length;
  /** The cursor once the first `kept` records are stored (all of them: the whole page). */
  const after = (kept: number, left: boolean): QboSyncCursor => {
    const { turn: _t, attachments: _a, ...rest } = c;
    const read = taken.slice(0, at[kept] ?? taken.length);
    // Failure counts and skipped files stay (the caller settles them with what it downloaded).
    const { failures, skipped } = a;
    // The page stopped where the history ends, and all of it is stored: the news start at that
    // time (rows of its second read again are known, so they raise nothing).
    const historyDone =
      initial &&
      a.historyUntil !== undefined &&
      taken.length < rows.length &&
      read.length === taken.length;
    return {
      ...rest,
      attachments: {
        ...(historyDone
          ? { since: qboTime(a.historyUntil as string), skip: 0 }
          : advance(a, read, left && read.length === QBO_ATTACHMENT_PAGE_SIZE)),
        ...(historyUntil && !historyDone ? { historyUntil } : {}),
        ...(left ? { more: true } : {}),
        ...(failures && Object.keys(failures).length > 0 ? { failures } : {}),
        ...(skipped && skipped.length > 0 ? { skipped } : {}),
      },
    };
  };
  return {
    records,
    next: after(taken.length, more),
    done: !more,
    initial,
    resumeAfter: (kept) => after(kept, true),
  };
}

/** How many rows at the head of the list last changed before `until`. */
function leadingBefore(rows: unknown[], until: number): number {
  let n = 0;
  for (const r of rows) {
    const t = timeOf(r);
    if (t === null || t >= until) break;
    n += 1;
  }
  return n;
}

/** A row's last change, in ms; null when it has none. */
function timeOf(row: unknown): number | null {
  const r = Row.safeParse(row);
  const at = r.success ? r.data.MetaData?.LastUpdatedTime : undefined;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** A time as a QBO literal: UTC with `Z`, floored to whole seconds. */
// DECISION (audit 2.5 review): Intuit's query docs show times without fractions of a second (and
// an error 300, "Time value is incorrect"), so a time is floored: with `>=` that reads a little
// more, never less. UNCHECKED (NOTES.md): the literal's exact form.
export function qboTime(t: string | number): string {
  const ms = typeof t === "number" ? t : Date.parse(t);
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

/**
 * The place after reading `rows`, in order of last change, from `at`. The next read starts at the
 * second the rows reached, whole (`skip: 0`): rows read again are known by their version and
 * stored once, and a row of that second that changed or went meanwhile can't shift the read past
 * another. Only a full page (`pageFull`) wholly inside one second counts its rows into that second
 * (`skip`), since reading the second again would only bring the same page back: QuickBooks has no
 * later key to order by, so a row changed between two such pages may be missed (NOTES.md).
 */
function advance(at: TimePlace, rows: unknown[], pageFull: boolean): TimePlace {
  const since = qboTime(at.since);
  const last = rows.length > 0 ? timeOf(rows[rows.length - 1]) : null;
  if (last !== null && Date.parse(qboTime(last)) > Date.parse(since)) {
    return { since: qboTime(last), skip: 0 };
  }
  return { since, skip: pageFull ? at.skip + rows.length : 0 };
}

/** Name lists: QuickBooks deletes their records by making them inactive. */
const QBO_NAME_LISTS = new Set<string>([
  "Account",
  "Class",
  "Department",
  "Vendor",
  "Item",
  "Customer",
]);

/** Failed tries a file may have before its attachment is stored without it. */
export const QBO_ATTACHMENT_TRIES = 3;
/** Failures closer together than this count once (a step's own retries). */
const FAILURE_SPACING_MS = 10 * 60_000;
/** A skipped file is tried again this long after its last try. */
const SKIPPED_RETRY_MS = DAY_MS;

type AttachmentFailures = NonNullable<AttachmentsPlace["failures"]>;

/** Each attachment's failed tries (a cursor's own count). */
export function qboAttachmentFailures(cursor: QboSyncCursor | null): AttachmentFailures {
  return cursor?.phase === "cdc" ? (cursor.attachments?.failures ?? {}) : {};
}

/**
 * Whether one more failure of this file now is its last try: it counts (none counted in the last
 * ten minutes) and reaches `QBO_ATTACHMENT_TRIES`.
 */
export function qboAttachmentGivesUp(
  failures: AttachmentFailures,
  attachableId: string,
  now: Date,
): boolean {
  const f = failures[attachableId];
  if (!f) return QBO_ATTACHMENT_TRIES <= 1;
  return now.getTime() - Date.parse(f.at) >= FAILURE_SPACING_MS && f.n + 1 >= QBO_ATTACHMENT_TRIES;
}

/** A cursor with this file's failure counted (once in ten minutes at most). */
export function qboNoteAttachmentFailure(
  cursor: QboSyncCursor | null,
  attachableId: string,
  now: Date,
): QboSyncCursor | null {
  if (cursor?.phase !== "cdc") return cursor;
  const a = attachmentsOf(cursor);
  const failures = { ...(a.failures ?? {}) };
  const f = failures[attachableId];
  if (f && now.getTime() - Date.parse(f.at) < FAILURE_SPACING_MS) return cursor;
  failures[attachableId] = { n: (f?.n ?? 0) + 1, at: now.toISOString() };
  // A handful at most: the oldest go first.
  const kept = Object.fromEntries(Object.entries(failures).slice(-20));
  return { ...cursor, attachments: { ...a, failures: kept } };
}

/** The skipped file due for its daily try, if any. */
export function qboAttachmentRetryDue(
  cursor: QboSyncCursor | null,
  now: Date,
): { id: string; history: boolean } | null {
  if (cursor?.phase !== "cdc") return null;
  const due = cursor.attachments?.skipped?.find(
    (s) => now.getTime() - Date.parse(s.at) >= SKIPPED_RETRY_MS,
  );
  return due ? { id: due.id, history: due.history === true } : null;
}

/**
 * The cursor to store after a page's downloads: counts go for files downloaded or given up on;
 * files given up on join `skipped`; the daily try of a skipped file leaves it there with a new
 * time if it failed again, and takes it out if it came.
 */
export function qboSettleAttachments(
  cursor: QboSyncCursor,
  outcome: {
    downloaded: string[];
    skipped: { id: string; history: boolean }[];
    retried?: { id: string; ok: boolean };
    now: Date;
  },
): QboSyncCursor {
  if (cursor.phase !== "cdc" || !cursor.attachments) return cursor;
  const a = cursor.attachments;
  const done = new Set([...outcome.downloaded, ...outcome.skipped.map((s) => s.id)]);
  const failures = Object.fromEntries(
    Object.entries(a.failures ?? {}).filter(([id]) => !done.has(id)),
  );
  const at = outcome.now.toISOString();
  let skipped = (a.skipped ?? []).filter((s) => !done.has(s.id));
  if (outcome.retried) {
    const { id, ok } = outcome.retried;
    skipped = ok
      ? skipped.filter((s) => s.id !== id)
      : skipped.map((s) => (s.id === id ? { ...s, at } : s));
  }
  skipped = [
    ...skipped,
    ...outcome.skipped.map((s) => ({ id: s.id, at, ...(s.history ? { history: true } : {}) })),
  ].slice(-50);
  const { failures: _f, skipped: _s, ...rest } = a;
  return {
    ...cursor,
    attachments: {
      ...rest,
      ...(Object.keys(failures).length > 0 ? { failures } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
    },
  };
}
