// The import (docs/plan.md §1.79): the bank feed's raw records, after where it got to, into one
// `bank_txn` per transaction at its latest version, and one `bank_account_link` per account seen
// (off until a person links it). Safe to run again and alongside the feed's own sync: it takes a
// share lock on the connection, so a sync in progress commits first and nothing is read half-way.

import {
  BANKFEED_CONNECTOR_ID,
  BANKFEED_TRANSACTION_ENTITY,
  BankfeedTransaction,
} from "@countersign/connectors";
import { dec, toNumeric } from "@countersign/core";
import { connection, rawRecord, type Tx } from "@countersign/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { payeeKey } from "./payee";
import {
  type BankTxnStatus,
  bankAccountLink,
  bankFeedCursor,
  bankTxn,
  booking,
  type LinkKind,
} from "./schema";

/** At most this many raw records in one pass; more: the next pass carries on. */
export const IMPORT_BATCH = 2000;

const Removed = z.object({
  id: z.string(),
  accountId: z.string().nullable().optional(),
  removed: z.literal(true),
});

export interface ImportResult {
  connections: number;
  /** Raw records read. */
  read: number;
  accounts: number;
  added: number;
  updated: number;
  removed: number;
  /** Whether a feed has more after this pass. */
  more: boolean;
}

/** Statuses a newer version of the bank's record may still change. */
const OPEN: readonly BankTxnStatus[] = ["pending", "new", "proposed", "needs_review", "skipped"];

function kindOf(type: string | null): LinkKind {
  if (type === "credit") return "card";
  if (type === "depository") return "bank";
  return "other";
}

/** Every bank feed of the client, or one. Inside the client's transaction. */
export async function importFeeds(
  tx: Tx,
  tenantId: string,
  opts: { connectionId?: string; batch?: number } = {},
): Promise<ImportResult> {
  const feeds = await tx
    .select({ id: connection.id })
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        eq(connection.connector, BANKFEED_CONNECTOR_ID),
        ...(opts.connectionId ? [eq(connection.id, opts.connectionId)] : []),
      ),
    )
    .orderBy(asc(connection.id));
  const result: ImportResult = {
    connections: 0,
    read: 0,
    accounts: 0,
    added: 0,
    updated: 0,
    removed: 0,
    more: false,
  };
  for (const feed of feeds) {
    await importFeed(tx, tenantId, feed.id, opts.batch ?? IMPORT_BATCH, result);
    result.connections += 1;
  }
  return result;
}

async function importFeed(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  batch: number,
  result: ImportResult,
): Promise<void> {
  // The feed's sync holds the connection `for update` until it commits; waiting here for a share
  // lock means every raw record of that sync is committed before we read.
  await tx.execute(
    sql`select 1 from ${connection} where ${connection.id} = ${connectionId} and ${connection.tenantId} = ${tenantId} for share`,
  );
  const [cursor] = await tx
    .select()
    .from(bankFeedCursor)
    .where(
      and(eq(bankFeedCursor.tenantId, tenantId), eq(bankFeedCursor.connectionId, connectionId)),
    );
  // DECISION: raw record ids are uuid v7, given at insert and committed in order under the
  // connection's lock, so the last one read is a sound place to carry on from.
  const rows = await tx
    .select()
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        eq(rawRecord.entityType, BANKFEED_TRANSACTION_ENTITY),
        ...(cursor ? [gt(rawRecord.id, cursor.lastRawRecordId)] : []),
      ),
    )
    .orderBy(asc(rawRecord.id))
    .limit(batch + 1);
  if (rows.length > batch) result.more = true;
  const page = rows.slice(0, batch);
  const links = new Map<string, string>();
  for (const row of page) {
    result.read += 1;
    const gone = Removed.safeParse(row.payload);
    if (row.isDeleted && gone.success) {
      if (await removeTxn(tx, tenantId, connectionId, gone.data.id, row.id)) result.removed += 1;
      continue;
    }
    const parsed = BankfeedTransaction.safeParse(row.payload);
    // A version we can't read stays a raw record for a person; it never holds up the rest.
    if (!parsed.success) continue;
    const t = parsed.data;
    let linkId = links.get(t.account.id);
    if (!linkId) {
      const made = await ensureLink(tx, tenantId, connectionId, t);
      if (made.created) result.accounts += 1;
      linkId = made.id;
      links.set(t.account.id, linkId);
    }
    const outcome = await upsertTxn(tx, tenantId, connectionId, linkId, row.id, t);
    if (outcome === "added") result.added += 1;
    else if (outcome === "updated") result.updated += 1;
    // A posted transaction replaces the pending one it came from.
    if (t.pendingTransactionId) {
      if (await removeTxn(tx, tenantId, connectionId, t.pendingTransactionId, row.id, t.id)) {
        result.removed += 1;
      }
    }
  }
  const last = page.at(-1);
  if (last) {
    await tx
      .insert(bankFeedCursor)
      .values({ tenantId, connectionId, lastRawRecordId: last.id })
      .onConflictDoUpdate({
        target: [bankFeedCursor.tenantId, bankFeedCursor.connectionId],
        set: { lastRawRecordId: last.id, updatedAt: sql`now()` },
      });
  }
}

async function ensureLink(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  t: BankfeedTransaction,
): Promise<{ id: string; created: boolean }> {
  const [made] = await tx
    .insert(bankAccountLink)
    .values({
      tenantId,
      connectionId,
      externalAccountId: t.account.id,
      name: t.account.name,
      mask: t.account.mask,
      kind: kindOf(t.account.type),
    })
    .onConflictDoNothing({
      target: [
        bankAccountLink.tenantId,
        bankAccountLink.connectionId,
        bankAccountLink.externalAccountId,
      ],
    })
    .returning({ id: bankAccountLink.id });
  if (made) return { id: made.id, created: true };
  const [found] = await tx
    .select({ id: bankAccountLink.id })
    .from(bankAccountLink)
    .where(
      and(
        eq(bankAccountLink.tenantId, tenantId),
        eq(bankAccountLink.connectionId, connectionId),
        eq(bankAccountLink.externalAccountId, t.account.id),
      ),
    );
  if (!found) throw new Error("bank account link vanished");
  return { id: found.id, created: false };
}

async function upsertTxn(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  accountLinkId: string,
  rawRecordId: string,
  t: BankfeedTransaction,
): Promise<"added" | "updated" | "kept"> {
  const payee = t.merchantName?.trim() || t.description?.trim() || null;
  const fields = {
    accountLinkId,
    rawRecordId,
    txnDate: t.date,
    amount: toNumeric(dec(t.amount.amount).abs()),
    currency: t.amount.currency,
    direction: t.direction,
    payee,
    payeeKey: payeeKey(payee) || null,
    description: t.description,
    bankCategory: t.category,
  };
  const [existing] = await tx
    .select()
    .from(bankTxn)
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        eq(bankTxn.connectionId, connectionId),
        eq(bankTxn.externalId, t.id),
      ),
    );
  if (!existing) {
    await tx.insert(bankTxn).values({
      tenantId,
      connectionId,
      externalId: t.id,
      ...fields,
      status: t.pending ? "pending" : "new",
    });
    return "added";
  }
  // DECISION: once approved, posted, matched, excluded or removed, the bank's later versions are
  // kept as raw records only: what was decided stands, and a person sees the change there.
  if (!OPEN.includes(existing.status)) return "kept";
  const changed =
    existing.amount !== fields.amount ||
    existing.direction !== fields.direction ||
    existing.txnDate !== fields.txnDate ||
    existing.accountLinkId !== accountLinkId;
  // A changed amount, date or account undoes a proposal made on the old one.
  if (changed) await supersedeLive(tx, tenantId, existing.id);
  const status: BankTxnStatus = t.pending
    ? "pending"
    : existing.status === "pending" || changed
      ? "new"
      : existing.status;
  await tx
    .update(bankTxn)
    .set({ ...fields, status, updatedAt: sql`now()` })
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, existing.id)));
  return "updated";
}

/**
 * The bank dropped a transaction (or it posted under a new id): `removed`, its proposal
 * superseded. If it was already approved or posted, it stays and a person is told by the flag.
 */
async function removeTxn(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  externalId: string,
  rawRecordId: string,
  postedAs?: string,
): Promise<boolean> {
  const [existing] = await tx
    .select()
    .from(bankTxn)
    .where(
      and(
        eq(bankTxn.tenantId, tenantId),
        eq(bankTxn.connectionId, connectionId),
        eq(bankTxn.externalId, externalId),
      ),
    );
  if (!existing || existing.status === "removed") return false;
  if (!OPEN.includes(existing.status)) {
    if (postedAs) return false;
    await tx
      .update(bankTxn)
      .set({ ext: { ...existing.ext, removedAfterPosting: true }, updatedAt: sql`now()` })
      .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, existing.id)));
    return false;
  }
  await supersedeLive(tx, tenantId, existing.id);
  await tx
    .update(bankTxn)
    .set({
      status: "removed",
      rawRecordId,
      ext: { ...existing.ext, ...(postedAs ? { postedAs } : {}) },
      updatedAt: sql`now()`,
    })
    .where(and(eq(bankTxn.tenantId, tenantId), eq(bankTxn.id, existing.id)));
  return true;
}

/** A proposal that no longer stands (the transaction changed or went): `superseded`. */
export async function supersedeLive(tx: Tx, tenantId: string, bankTxnId: string): Promise<void> {
  await tx
    .update(booking)
    .set({ status: "superseded", decidedAt: sql`now()` })
    .where(
      and(
        eq(booking.tenantId, tenantId),
        eq(booking.bankTxnId, bankTxnId),
        inArray(booking.status, ["proposed"]),
      ),
    );
}
