// Storing one page of QuickBooks sync (plan M9): each record as it came, once per
// (connection, entity, id, SyncToken) in raw_record, then mapped by core's mappers: vendors,
// transactions with their lines, attachments as documents (stored once per sha256 and linked to
// their transaction). New and changed transactions raise `transaction.created` / `.updated`, except
// during the initial sync (history, not news). Everything for one page, the cursor included, is
// written in the caller's one transaction for the page's one client.

import {
  type ContentStore,
  findOrCreateVendor,
  findVendor,
  type RawRecordInput,
} from "@countersign/connectors";
import {
  isQboTransactionEntity,
  type JsonObject,
  MapperError,
  mapQboAttachable,
  mapQboTransaction,
  mapQboVendor,
  normalizeVendorName,
  QBO_CONNECTOR_ID,
  qboTransactionExternalId,
  type TransactionInput,
  type VendorInput,
} from "@countersign/core";
import {
  connection,
  event,
  rawRecord,
  type Tx,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { attach, DocumentError, storeDocument } from "@countersign/documents";
import { type EventRow, emit } from "@countersign/senses";
import { and, eq, inArray, sql } from "drizzle-orm";
import { deleteReceivable, upsertReceivable } from "./receivables";
import { cursorKeepingClaim } from "./sync-cursor";

export interface DownloadedFile {
  bytes: Uint8Array;
  mime: string;
  filename: string;
}

export interface StorePageInput {
  tenantId: string;
  connectionId: string;
  records: RawRecordInput[];
  /** Attachment files read before the transaction, by attachable id. */
  files: Map<string, DownloadedFile>;
  /** The cursor to store with this page. */
  cursor: JsonObject;
  initial: boolean;
  now: Date;
}

export interface StorePageResult {
  /** Raw records new to this connection. */
  stored: number;
  transactions: { created: number; updated: number };
  /** v0.12 W1-F: invoices stored as receivables. */
  receivables: { created: number; updated: number };
  documents: number;
  /** Events for dispatch after commit. */
  events: EventRow[];
}

/** Which of these records this connection already has (same entity, id and version). */
export async function knownRecords(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  records: RawRecordInput[],
): Promise<Set<string>> {
  const ids = [...new Set(records.map((r) => r.externalId))];
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({
      entityType: rawRecord.entityType,
      externalId: rawRecord.externalId,
      externalVersion: rawRecord.externalVersion,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        inArray(rawRecord.externalId, ids),
      ),
    );
  return new Set(rows.map((r) => recordKey(r)));
}

export function recordKey(r: {
  entityType: string;
  externalId: string;
  externalVersion: string | null;
}): string {
  return `${r.entityType}:${r.externalId}:${r.externalVersion ?? ""}`;
}

export async function storeQboPage(
  tx: Tx,
  content: ContentStore,
  input: StorePageInput,
): Promise<StorePageResult> {
  const { tenantId, connectionId } = input;
  const out: StorePageResult = {
    stored: 0,
    transactions: { created: 0, updated: 0 },
    receivables: { created: 0, updated: 0 },
    documents: 0,
    events: [],
  };
  const news = async (e: Parameters<typeof emit>[1]) => {
    if (input.initial) return;
    const row = await emit(tx, e);
    if (row) out.events.push(row);
  };
  for (const record of input.records) {
    const [raw] = await tx
      .insert(rawRecord)
      .values({
        tenantId,
        connectionId,
        connector: QBO_CONNECTOR_ID,
        entityType: record.entityType,
        externalId: record.externalId,
        externalVersion: record.externalVersion,
        payload: record.payload,
        isDeleted: record.isDeleted === true,
      })
      .onConflictDoNothing()
      .returning({ id: rawRecord.id });
    if (!raw) continue;
    out.stored += 1;
    try {
      if (record.isDeleted) {
        await deleted(tx, tenantId, connectionId, record, news);
        // v0.12 W1-F: a deleted invoice keeps its receivable, status `deleted`.
        if (record.entityType === "Invoice") {
          await deleteReceivable(
            tx,
            { tenantId, connectionId, externalId: record.externalId, rawId: raw.id },
            news,
          );
        }
      } else if (record.entityType === "Invoice") {
        // v0.12 W1-F: customers and payments stay raw records; a payment moves its invoices'
        // balance through the invoices' own versions.
        const r = await upsertReceivable(
          tx,
          { tenantId, connectionId, rawId: raw.id, payload: record.payload },
          news,
        );
        out.receivables[r] += 1;
      } else if (record.entityType === "Vendor") {
        await upsertVendor(tx, tenantId, mapQboVendor(record.payload));
      } else if (isQboTransactionEntity(record.entityType)) {
        const r = await upsertTransaction(
          tx,
          tenantId,
          raw.id,
          mapQboTransaction(record.entityType, record.payload),
          news,
        );
        out.transactions[r] += 1;
      } else if (record.entityType === "Attachable") {
        const file = input.files.get(record.externalId);
        if (file && (await storeAttachment(tx, content, input, record, file, out))) {
          out.documents += 1;
        }
      }
    } catch (error) {
      // A record our mappers can't read stays in raw_record for a person (or a later mapper);
      // it never holds up the rest of the sync.
      if (error instanceof MapperError) {
        console.warn(`qbo ${record.entityType} ${record.externalId} not mapped: ${error.message}`);
        continue;
      }
      throw error;
    }
  }
  await tx
    .update(connection)
    // v0.12 W1-H: the sync claim (running, pending) stays beside the cursor.
    .set({ syncCursor: cursorKeepingClaim(input.cursor, input.now), lastSyncAt: input.now })
    .where(and(eq(connection.id, connectionId), eq(connection.tenantId, tenantId)));
  return out;
}

/** A record QuickBooks deleted: its raw versions are flagged, a transaction is marked deleted. */
// DECISION: a transaction deleted in QuickBooks is kept (documents and runs point at it) and marked
// `ext.qbo.deleted`, with `transaction.updated` (changed: deleted); its raw versions are flagged.
async function deleted(
  tx: Tx,
  tenantId: string,
  connectionId: string,
  record: RawRecordInput,
  news: (e: Parameters<typeof emit>[1]) => Promise<void>,
) {
  await tx
    .update(rawRecord)
    .set({ isDeleted: true })
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connectionId, connectionId),
        eq(rawRecord.entityType, record.entityType),
        eq(rawRecord.externalId, record.externalId),
      ),
    );
  if (!isQboTransactionEntity(record.entityType)) return;
  const [txn] = await tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.connector, QBO_CONNECTOR_ID),
        eq(transaction.externalId, qboTransactionExternalId(record.entityType, record.externalId)),
      ),
    );
  if (!txn) return;
  const qbo = { ...((txn.ext as { qbo?: object }).qbo ?? {}), deleted: true };
  await tx
    .update(transaction)
    .set({ ext: { ...txn.ext, qbo } })
    .where(and(eq(transaction.id, txn.id), eq(transaction.tenantId, tenantId)));
  await news({
    tenantId,
    type: "transaction.updated",
    subjectId: txn.id,
    payload: {
      transactionId: txn.id,
      source: QBO_CONNECTOR_ID,
      vendorId: txn.vendorId,
      total: { amount: txn.total, currency: txn.currency },
      txnDate: txn.txnDate,
      changed: ["deleted"],
    },
  });
}

type VendorRow = typeof vendor.$inferSelect;

async function vendorByRef(tx: Tx, tenantId: string, id: string): Promise<VendorRow | null> {
  const [row] = await tx
    .select()
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), sql`${vendor.externalRefs} ->> 'qbo' = ${id}`))
    .limit(1);
  return row ?? null;
}

/**
 * The client's vendor for a QuickBooks vendor: the one already linked by id, else the one with this
 * name (or alias), else a new one; linked by id and given the other names as aliases.
 */
async function upsertVendor(tx: Tx, tenantId: string, v: VendorInput): Promise<VendorRow | null> {
  let row =
    (await vendorByRef(tx, tenantId, v.externalId)) ?? (await findVendor(tx, tenantId, v.name));
  if (!row) {
    const key = normalizeVendorName(v.name);
    if (!key) return null;
    await tx
      .insert(vendor)
      .values({ tenantId, name: v.name, normalizedName: key })
      .onConflictDoNothing({ target: [vendor.tenantId, vendor.normalizedName] });
    row = await findVendor(tx, tenantId, v.name);
    if (!row) return null;
  }
  const aliases = new Set(row.aliases);
  for (const name of [v.name, ...v.aliases]) {
    const key = normalizeVendorName(name);
    if (key && key !== row.normalizedName) aliases.add(key);
  }
  const refs = row.externalRefs as Record<string, unknown>;
  if (refs.qbo !== v.externalId || aliases.size !== row.aliases.length) {
    await tx
      .update(vendor)
      .set({ externalRefs: { ...refs, qbo: v.externalId }, aliases: [...aliases] })
      .where(and(eq(vendor.id, row.id), eq(vendor.tenantId, tenantId)));
  }
  return row;
}

async function vendorFor(tx: Tx, tenantId: string, t: TransactionInput): Promise<string | null> {
  if (!t.vendorName && !t.vendorExternalId) return null;
  if (t.vendorExternalId) {
    const byRef = await vendorByRef(tx, tenantId, t.vendorExternalId);
    if (byRef) return byRef.id;
    if (t.vendorName) {
      const row = await upsertVendor(tx, tenantId, {
        externalId: t.vendorExternalId,
        name: t.vendorName,
        aliases: [],
        active: true,
        email: null,
      });
      return row?.id ?? null;
    }
    return null;
  }
  return (await findOrCreateVendor(tx, tenantId, t.vendorName as string))?.id ?? null;
}

async function upsertTransaction(
  tx: Tx,
  tenantId: string,
  rawId: string,
  t: TransactionInput,
  news: (e: Parameters<typeof emit>[1]) => Promise<void>,
): Promise<"created" | "updated"> {
  const vendorId = await vendorFor(tx, tenantId, t);
  const [existing] = await tx
    .select()
    .from(transaction)
    .where(
      and(
        eq(transaction.tenantId, tenantId),
        eq(transaction.connector, QBO_CONNECTOR_ID),
        eq(transaction.externalId, t.externalId),
      ),
    )
    .for("update");
  const fields = {
    kind: t.kind,
    vendorId,
    txnDate: t.txnDate,
    total: t.total,
    currency: t.currency,
    purchaserRef: t.purchaserRef,
    paymentType: t.paymentType,
    memo: t.memo,
    sourceRawRecordId: rawId,
  };
  const payload = (id: string) => ({
    transactionId: id,
    source: QBO_CONNECTOR_ID,
    vendorId,
    total: { amount: t.total, currency: t.currency },
    txnDate: t.txnDate,
  });
  if (!existing) {
    const [row] = await tx
      .insert(transaction)
      .values({
        tenantId,
        connector: QBO_CONNECTOR_ID,
        externalId: t.externalId,
        ...fields,
        ext: t.ext ?? {},
      })
      .returning();
    if (!row) throw new Error("transaction insert returned nothing");
    await writeLines(tx, tenantId, row.id, t);
    await news({
      tenantId,
      type: "transaction.created",
      subjectId: row.id,
      payload: payload(row.id),
    });
    return "created";
  }
  const before = await tx
    .select()
    .from(transactionLine)
    .where(
      and(eq(transactionLine.tenantId, tenantId), eq(transactionLine.transactionId, existing.id)),
    )
    .orderBy(transactionLine.lineNo);
  const changed: string[] = [];
  if (existing.total !== t.total || existing.currency !== t.currency) changed.push("total");
  if (existing.vendorId !== vendorId) changed.push("vendor");
  if (existing.txnDate !== t.txnDate) changed.push("txnDate");
  if (existing.memo !== t.memo) changed.push("memo");
  if (linesKey(before) !== linesKey(t.lines ?? [])) changed.push("lines");
  await tx
    .update(transaction)
    .set({ ...fields, ext: { ...existing.ext, ...(t.ext ?? {}) } })
    .where(and(eq(transaction.id, existing.id), eq(transaction.tenantId, tenantId)));
  if (changed.includes("lines")) {
    await tx
      .delete(transactionLine)
      .where(
        and(eq(transactionLine.tenantId, tenantId), eq(transactionLine.transactionId, existing.id)),
      );
    await writeLines(tx, tenantId, existing.id, t);
  }
  if (changed.length > 0) {
    await news({
      tenantId,
      type: "transaction.updated",
      subjectId: existing.id,
      payload: { ...payload(existing.id), changed },
    });
  }
  return "updated";
}

function linesKey(
  lines: readonly {
    detailType: string;
    accountRef: string | null;
    itemRef: string | null;
    description: string | null;
    qty: string | null;
    unitPrice: string | null;
    amount: string;
  }[],
): string {
  return JSON.stringify(
    lines.map((l) => [
      l.detailType,
      l.accountRef,
      l.itemRef,
      l.description,
      l.qty,
      l.unitPrice,
      l.amount,
    ]),
  );
}

async function writeLines(tx: Tx, tenantId: string, transactionId: string, t: TransactionInput) {
  const lines = t.lines ?? [];
  if (lines.length === 0) return;
  await tx.insert(transactionLine).values(
    lines.map((l) => ({
      tenantId,
      transactionId,
      lineNo: l.lineNo,
      detailType: l.detailType,
      accountRef: l.accountRef,
      itemRef: l.itemRef,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
  );
}

/**
 * An attachment's file as a document (source `connector`), linked to the transaction it hangs on.
 * Returns whether a new document was stored.
 */
async function storeAttachment(
  tx: Tx,
  content: ContentStore,
  input: StorePageInput,
  record: RawRecordInput,
  file: DownloadedFile,
  out: StorePageResult,
): Promise<boolean> {
  const a = mapQboAttachable(record.payload);
  let stored: Awaited<ReturnType<typeof storeDocument>>;
  try {
    stored = await storeDocument(tx, content, {
      tenantId: input.tenantId,
      source: "connector",
      connectionId: input.connectionId,
      bytes: file.bytes,
      filename: a.fileName ?? file.filename,
      mimeType: file.mime,
      meta: { via: QBO_CONNECTOR_ID, attachableId: a.externalId, refs: a.refs },
    });
  } catch (error) {
    // Not a PDF or image, or too large: QuickBooks keeps it; we don't.
    if (error instanceof DocumentError) {
      console.warn(`qbo attachment ${a.externalId} not stored: ${error.message}`);
      return false;
    }
    throw error;
  }
  if (stored.event) {
    if (input.initial) {
      // History: the event is kept, as already handled, so it starts nothing.
      await tx
        .update(event)
        .set({ dispatchedAt: input.now })
        .where(and(eq(event.id, stored.event.id), eq(event.tenantId, input.tenantId)));
    } else {
      out.events.push(stored.event);
    }
  }
  for (const ref of a.refs) {
    if (!isQboTransactionEntity(ref.entity)) continue;
    const [txn] = await tx
      .select()
      .from(transaction)
      .where(
        and(
          eq(transaction.tenantId, input.tenantId),
          eq(transaction.connector, QBO_CONNECTOR_ID),
          eq(transaction.externalId, qboTransactionExternalId(ref.entity, ref.id)),
        ),
      );
    if (txn && stored.document.transactionId === null) {
      await attach(tx, input.tenantId, stored.document, txn, { testRun: input.initial });
      break;
    }
  }
  return stored.created;
}
