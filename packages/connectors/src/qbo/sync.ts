// What QuickBooks sync reads, one page at a time (ARCHITECTURE §6.2): first an initial sync of each
// entity with paging, then change data capture (CDC) from where it left off. Each page answers the
// raw records it read and the cursor to store with them, so the caller writes both in one
// transaction and a crash or a second sync starts from the stored cursor. Writing is the caller's
// (apps/api): this file only reads QuickBooks.

import {
  isQboArEntity,
  isQboTransactionEntity,
  QBO_SYNCED_ENTITIES,
  type QboEntity,
} from "@countersign/core";
import { z } from "zod";
import type { RawRecordInput } from "../connector";
import { type QboClient, qboLiteral } from "./api";

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
  }),
  z.object({
    v: z.literal(1),
    phase: z.literal("cdc"),
    changedSince: z.string(),
    /** v0.12: the accounts receivable entities have had their initial read. */
    ar: z.boolean().optional(),
    /** B-2 (docs/plan.md §1.79): the chart of accounts has had its initial read. */
    accounts: z.boolean().optional(),
  }),
]);

/** The v0.12 entities a connection made before them reads once, from its CDC point. */
export const QBO_AR_BACKFILL = ["Customer", "Invoice", "Payment"] as const satisfies QboEntity[];
/** B-2: the chart of accounts, read once by a connection made before it was synced. */
export const QBO_ACCOUNTS_BACKFILL = ["Account"] as const satisfies QboEntity[];
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
}

export interface QboSyncPage {
  records: RawRecordInput[];
  /** The cursor to store with these records. */
  next: QboSyncCursor;
  /** No more pages for now (CDC is caught up). */
  done: boolean;
  /** These records come from the initial sync (history, not news: no events). */
  initial: boolean;
}

// DECISION: an initial sync reads 90 days of transactions and attachments (by transaction date,
// and by last change for attachments), and every vendor and item; it raises no events, so
// connecting QuickBooks doesn't start a run for every old bill. Changes after it are news.
export const QBO_INITIAL_DAYS = 90;
// v0.12 W1-F (ARCHITECTURE §6.2): invoices and payments for 365 days; customers whole.
export const QBO_AR_INITIAL_DAYS = 365;
export const QBO_PAGE_SIZE = 200;
/** QBO's CDC looks back at most 30 days; past that, sync starts over. */
// UNCHECKED (NOTES.md): the 30-day limit and the 1000-object cap per entity per CDC answer.
export const QBO_CDC_MAX_DAYS = 30;
export const QBO_CDC_CAP = 1000;
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
    entity: QBO_SYNCED_ENTITIES[0],
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
      : entity === "Attachable"
        ? ` where Metadata.LastUpdatedTime >= ${qboLiteral(`${sinceDate}T00:00:00Z`)}`
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
  if (
    c.phase === "cdc" &&
    opts.now.getTime() - Date.parse(c.changedSince) > (QBO_CDC_MAX_DAYS - 1) * DAY_MS
  ) {
    // Too long since the last read for CDC: read everything again (raw records dedupe it).
    c = startQboSync(opts);
  }
  if (c.phase === "cdc" && (c.ar !== true || c.accounts !== true)) c = backfill(c, opts);
  if (c.phase === "initial") return initialPage(client, c, opts);
  return cdcPage(client, c, opts);
}

async function initialPage(
  client: QboClient,
  c: Extract<QboSyncCursor, { phase: "initial" }>,
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
  const order: readonly QboEntity[] = c.entities ?? QBO_SYNCED_ENTITIES;
  const i = order.indexOf(c.entity);
  const nextEntity = order[i + 1];
  if (nextEntity) {
    return { records, next: { ...c, entity: nextEntity, start: 1 }, done: false, initial: true };
  }
  // B-2: a read that walked the chart of accounts (a whole initial read, or a backfill that
  // included it) has done it; an older backfill of the AR entities alone leaves it for the next.
  const accounts = c.entities === undefined || c.entities.includes("Account");
  return {
    records,
    next: { v: 1, phase: "cdc", changedSince: c.changedSince, ar: true, accounts },
    done: false,
    initial: true,
  };
}

/**
 * A connection whose CDC began before v0.12 reads customers, invoices and payments once (as
 * history: no events), then carries on with CDC from where it was, so nothing else is read twice.
 */
// DECISION: the backfill keeps the stored CDC point, so changes to bills and purchases since then
// still come by CDC with their events; only the AR entities' history is new.
// B-2: the chart of accounts is read once the same way, after the AR entities if both are due.
function backfill(c: Extract<QboSyncCursor, { phase: "cdc" }>, opts: QboSyncOptions) {
  const start = startQboSync(opts);
  if (start.phase !== "initial") throw new Error("unreachable");
  const entities: QboEntity[] = [
    ...(c.ar === true ? [] : QBO_AR_BACKFILL),
    ...(c.accounts === true ? [] : QBO_ACCOUNTS_BACKFILL),
  ];
  const [first] = entities;
  if (!first) throw new Error("unreachable");
  return {
    ...start,
    entity: first,
    entities,
    changedSince: c.changedSince,
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

async function cdcPage(
  client: QboClient,
  c: Extract<QboSyncCursor, { phase: "cdc" }>,
  opts: QboSyncOptions,
): Promise<QboSyncPage> {
  const startedAt = opts.now;
  const body = CdcAnswer.parse(
    await client.get("/cdc", {
      entities: QBO_SYNCED_ENTITIES.join(","),
      changedSince: c.changedSince,
    }),
  );
  const records: RawRecordInput[] = [];
  /** For each entity that hit the cap: the latest change it returned. */
  const capped: string[] = [];
  for (const block of body.CDCResponse ?? []) {
    for (const qr of block.QueryResponse ?? []) {
      for (const [entity, rows] of Object.entries(qr)) {
        if (!Array.isArray(rows) || !(QBO_SYNCED_ENTITIES as readonly string[]).includes(entity)) {
          continue;
        }
        let latest = "";
        for (const row of rows) {
          const rec = qboRawRecord(entity, row);
          if (!rec) continue;
          records.push(rec);
          const t = Row.safeParse(row);
          const at = t.success ? (t.data.MetaData?.LastUpdatedTime ?? "") : "";
          if (at && Date.parse(at) > Date.parse(latest || "1970-01-01T00:00:00Z")) latest = at;
        }
        if (rows.length >= QBO_CDC_CAP && latest) capped.push(latest);
      }
    }
  }
  if (capped.length > 0) {
    // DECISION: CDC has no paging. When an entity hits the cap, the next read starts at the
    // earliest of the capped entities' latest changes; rows read twice are deduplicated.
    const earliest = capped.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
    // A cap that doesn't move time on (over a thousand changes in one instant) would read the
    // same answer forever: then the read moves on to now, like an uncapped one.
    if (Date.parse(earliest) <= Date.parse(c.changedSince)) {
      return {
        records,
        next: {
          v: 1,
          phase: "cdc",
          ar: true,
          accounts: true,
          changedSince: new Date(startedAt.getTime() - OVERLAP_MS).toISOString(),
        },
        done: true,
        initial: false,
      };
    }
    return {
      records,
      next: {
        v: 1,
        phase: "cdc",
        ar: true,
        accounts: true,
        changedSince: new Date(Date.parse(earliest)).toISOString(),
      },
      done: false,
      initial: false,
    };
  }
  return {
    records,
    next: {
      v: 1,
      phase: "cdc",
      ar: true,
      accounts: true,
      changedSince: new Date(startedAt.getTime() - OVERLAP_MS).toISOString(),
    },
    done: true,
    initial: false,
  };
}
