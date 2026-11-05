// The back office's Records page (`GET /api/ops/clients/:id/records`): what a client's connections
// brought in, newest first. Transactions and vendors are the shared records sync maps into
// (`transaction`, `transaction_line`, `vendor`); items stay QuickBooks' own, as raw records, so an
// item is the latest raw version of each QuickBooks Item. Each row says which connection it came
// through: a transaction by the raw record it was made from, a vendor by the raw record its id in
// the tool names. Every query names the client as well as relying on RLS (invariant 1).

import {
  connectionAccountName,
  QBO_CONNECTOR_ID,
  QboItemRaw,
  qboOptionalAmount,
  RECORD_LIST_PAGE,
  type RecordList,
  type RecordListItem,
  type RecordListKind,
  type RecordListTransaction,
  type RecordListVendor,
  type RecordSource,
  toNumeric,
} from "@countersign/core";
import {
  connection,
  document,
  rawRecord,
  type Tx,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import type { Platform } from "../platform";

export interface RecordListQuery {
  kind?: RecordListKind | undefined;
  q?: string | undefined;
  source?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

// DECISION: items are QuickBooks Items only. Other connectors' "Item" entities (a Podio app item)
// are records of another kind, and only QuickBooks syncs a product list today.
const ITEM_ENTITY = "Item";
const VENDOR_ENTITY = "Vendor";

/** A LIKE pattern that matches `q` anywhere, its own `%`, `_` and `\` taken literally. */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The amount a search names (`123.45`, `$1,234.50`), as a numeric string; null when it names none. */
export function searchAmount(q: string): string | null {
  const s = q.replace(/[$,\s]/g, "");
  if (!/^-?\d{1,10}(\.\d{1,4})?$/.test(s)) return null;
  return toNumeric(s);
}

const isoOf = (d: Date | string): string => new Date(d).toISOString();
const isoOrNull = (d: Date | string | null): string | null => (d === null ? null : isoOf(d));

// --- transactions ---------------------------------------------------------------------------

/** The tool's document number, wherever a connector keeps it (`ext.<connector>.docNumber`). */
const txnDocNumber = sql<
  string | null
>`jsonb_path_query_first(${transaction.ext}, '$.*.docNumber') #>> '{}'`;
/** Deleted in the tool it came from (`ext.<connector>.deleted`). */
const txnDeleted = sql<boolean>`jsonb_path_exists(${transaction.ext}, '$.* ? (@.deleted == true)')`;

function transactionConds(tenantId: string, source: string | undefined, q: string | undefined) {
  const conds: (SQL | undefined)[] = [eq(transaction.tenantId, tenantId)];
  if (source) conds.push(eq(rawRecord.connectionId, source));
  if (q) {
    const p = containsPattern(q);
    const amount = searchAmount(q);
    conds.push(
      or(
        ilike(transaction.memo, p),
        sql`${txnDocNumber} ilike ${p}`,
        ilike(vendor.name, p),
        amount === null ? undefined : sql`${transaction.total} = ${amount}::numeric`,
      ),
    );
  }
  return and(...conds);
}

const txnRaw = and(
  eq(rawRecord.id, transaction.sourceRawRecordId),
  eq(rawRecord.tenantId, transaction.tenantId),
);
const txnVendor = and(
  eq(vendor.id, transaction.vendorId),
  eq(vendor.tenantId, transaction.tenantId),
);

async function countTransactions(tx: Tx, where: SQL | undefined): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(transaction)
    .leftJoin(rawRecord, txnRaw)
    .leftJoin(vendor, txnVendor)
    .where(where);
  return row?.n ?? 0;
}

async function transactionRows(
  tx: Tx,
  where: SQL | undefined,
  offset: number,
  limit: number,
): Promise<RecordListTransaction[]> {
  const rows = await tx
    .select({
      id: transaction.id,
      kind: transaction.kind,
      txnDate: transaction.txnDate,
      total: transaction.total,
      currency: transaction.currency,
      memo: transaction.memo,
      createdAt: transaction.createdAt,
      vendorId: vendor.id,
      vendorName: vendor.name,
      sourceId: rawRecord.connectionId,
      syncedAt: rawRecord.syncedAt,
      docNumber: txnDocNumber,
      deleted: txnDeleted,
      lines: sql<number>`(select count(*)::int from ${transactionLine} where ${transactionLine.tenantId} = ${transaction.tenantId} and ${transactionLine.transactionId} = ${transaction.id})`,
      attachments: sql<number>`(select count(*)::int from ${document} where ${document.tenantId} = ${transaction.tenantId} and ${document.transactionId} = ${transaction.id})`,
    })
    .from(transaction)
    .leftJoin(rawRecord, txnRaw)
    .leftJoin(vendor, txnVendor)
    .where(where)
    // DECISION: newest first is by the transaction's own date, then by when it arrived: the order
    // its books keep, with today's sync on top of today's date.
    .orderBy(
      sql`${transaction.txnDate} desc nulls last`,
      sql`coalesce(${rawRecord.syncedAt}, ${transaction.createdAt}) desc`,
      asc(transaction.id),
    )
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.id,
    txnKind: r.kind,
    txnDate: r.txnDate,
    vendor: r.vendorId && r.vendorName ? { id: r.vendorId, name: r.vendorName } : null,
    docNumber: r.docNumber,
    memo: r.memo,
    total: r.total,
    currency: r.currency,
    lines: r.lines,
    attachments: r.attachments,
    syncedAt: isoOf(r.syncedAt ?? r.createdAt),
    sourceId: r.sourceId,
    deleted: r.deleted === true,
  }));
}

// --- vendors --------------------------------------------------------------------------------

// The outer vendor row, named in full: drizzle writes a single-table select's own columns without
// their table, which inside a correlated subquery would name the subquery's table instead.
const V = {
  id: sql.raw(`"vendor"."id"`),
  tenantId: sql.raw(`"vendor"."tenant_id"`),
  externalRefs: sql.raw(`"vendor"."external_refs"`),
};

/** The vendor's latest raw record from a tool: the one whose id its external refs name. */
function vendorRaw<T>(column: "connection_id" | "external_id" | "synced_at") {
  return sql<T>`(select vr.${sql.identifier(column)} from ${rawRecord} vr where vr.tenant_id = ${V.tenantId} and vr.entity_type = ${VENDOR_ENTITY} and vr.external_id = ${V.externalRefs} ->> vr.connector order by vr.synced_at desc limit 1)`;
}

const vendorSource = vendorRaw<string | null>("connection_id");
const vendorExternalId = vendorRaw<string | null>("external_id");
const vendorSyncedAt = vendorRaw<Date | string | null>("synced_at");

function vendorConds(tenantId: string, source: string | undefined, q: string | undefined) {
  const conds: (SQL | undefined)[] = [eq(vendor.tenantId, tenantId)];
  if (source) {
    // DECISION: a vendor's source is the connection that synced it (its raw Vendor record); a
    // vendor made here from an upload or a document has none, and shows only under all sources.
    conds.push(
      sql`exists (select 1 from ${rawRecord} vr where vr.tenant_id = ${V.tenantId} and vr.entity_type = ${VENDOR_ENTITY} and vr.external_id = ${V.externalRefs} ->> vr.connector and vr.connection_id = ${source})`,
    );
  }
  if (q) {
    const p = containsPattern(q);
    conds.push(
      or(
        ilike(vendor.name, p),
        sql`exists (select 1 from unnest(${vendor.aliases}) as alias where alias ilike ${p})`,
      ),
    );
  }
  return and(...conds);
}

async function countVendors(tx: Tx, where: SQL | undefined): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(vendor).where(where);
  return row?.n ?? 0;
}

async function vendorRows(
  tx: Tx,
  where: SQL | undefined,
  offset: number,
  limit: number,
): Promise<RecordListVendor[]> {
  const rows = await tx
    .select({
      id: vendor.id,
      name: vendor.name,
      aliases: vendor.aliases,
      createdAt: vendor.createdAt,
      sourceId: vendorSource,
      externalId: vendorExternalId,
      syncedAt: vendorSyncedAt,
      transactions: sql<number>`(select count(*)::int from ${transaction} vt where vt.tenant_id = ${V.tenantId} and vt.vendor_id = ${V.id})`,
    })
    .from(vendor)
    .where(where)
    .orderBy(
      sql`coalesce(${vendorSyncedAt}, ${vendor.createdAt}) desc`,
      desc(vendor.createdAt),
      asc(vendor.id),
    )
    .limit(limit)
    .offset(offset);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases,
    transactions: r.transactions,
    externalId: r.externalId,
    sourceId: r.sourceId,
    syncedAt: isoOrNull(r.syncedAt),
    createdAt: isoOf(r.createdAt),
  }));
}

// --- items ----------------------------------------------------------------------------------

/** Each QuickBooks Item's latest version, per connection. */
function latestItems(tx: Tx, tenantId: string, source: string | undefined) {
  return tx
    .selectDistinctOn([rawRecord.connectionId, rawRecord.externalId], {
      id: rawRecord.id,
      connectionId: rawRecord.connectionId,
      externalId: rawRecord.externalId,
      payload: rawRecord.payload,
      syncedAt: rawRecord.syncedAt,
      isDeleted: rawRecord.isDeleted,
    })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        eq(rawRecord.connector, QBO_CONNECTOR_ID),
        eq(rawRecord.entityType, ITEM_ENTITY),
        source ? eq(rawRecord.connectionId, source) : undefined,
      ),
    )
    .orderBy(
      rawRecord.connectionId,
      rawRecord.externalId,
      desc(rawRecord.syncedAt),
      desc(rawRecord.id),
    )
    .as("item");
}

type LatestItems = ReturnType<typeof latestItems>;

function itemSearch(item: LatestItems, q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const p = containsPattern(q);
  const amount = searchAmount(q);
  const cost = (field: string) =>
    sql`case when jsonb_typeof(${item.payload} -> ${field}) = 'number' then (${item.payload} ->> ${field})::numeric end = ${amount}::numeric`;
  return or(
    sql`${item.payload} ->> 'Name' ilike ${p}`,
    sql`${item.payload} ->> 'Sku' ilike ${p}`,
    sql`${item.payload} ->> 'Description' ilike ${p}`,
    sql`${item.payload} ->> 'PurchaseDesc' ilike ${p}`,
    amount === null ? undefined : cost("PurchaseCost"),
    amount === null ? undefined : cost("UnitPrice"),
  );
}

async function countItems(tx: Tx, item: LatestItems, where: SQL | undefined): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(item).where(where);
  return row?.n ?? 0;
}

function toItemRow(r: {
  id: string;
  connectionId: string;
  externalId: string;
  payload: unknown;
  syncedAt: Date;
  isDeleted: boolean;
}): RecordListItem {
  const parsed = QboItemRaw.safeParse(r.payload);
  const i = parsed.success ? parsed.data : null;
  let purchaseCost: string | null = null;
  try {
    purchaseCost = qboOptionalAmount(i?.PurchaseCost);
  } catch {
    // An amount QuickBooks sent that isn't one: the raw record shows it as it came.
  }
  return {
    id: r.id,
    externalId: r.externalId,
    name: i?.Name || `Item ${r.externalId}`,
    sku: i?.Sku || null,
    type: i?.Type ?? null,
    description: i?.PurchaseDesc || i?.Description || null,
    purchaseCost,
    active: i?.Active !== false,
    deleted: r.isDeleted,
    sourceId: r.connectionId,
    syncedAt: isoOf(r.syncedAt),
  };
}

async function itemRows(
  tx: Tx,
  item: LatestItems,
  where: SQL | undefined,
  offset: number,
  limit: number,
): Promise<RecordListItem[]> {
  const rows = await tx
    .select()
    .from(item)
    .where(where)
    .orderBy(desc(item.syncedAt), asc(item.id))
    .limit(limit)
    .offset(offset);
  return rows.map(toItemRow);
}

// --- sources --------------------------------------------------------------------------------

/**
 * The client's connections that brought in a listed record, and any that sync (have synced at
 * least once, even if nothing came yet).
 */
async function sourcesOf(tx: Tx, platform: Platform, tenantId: string): Promise<RecordSource[]> {
  const fromTransactions = await tx
    .selectDistinct({ id: rawRecord.connectionId })
    .from(transaction)
    .innerJoin(rawRecord, txnRaw)
    .where(eq(transaction.tenantId, tenantId));
  const fromRaw = await tx
    .selectDistinct({ id: rawRecord.connectionId })
    .from(rawRecord)
    .where(
      and(
        eq(rawRecord.tenantId, tenantId),
        or(
          eq(rawRecord.entityType, VENDOR_ENTITY),
          and(eq(rawRecord.connector, QBO_CONNECTOR_ID), eq(rawRecord.entityType, ITEM_ENTITY)),
        ),
      ),
    );
  const used = [...new Set([...fromTransactions, ...fromRaw].map((r) => r.id))];
  const rows = await tx
    .select()
    .from(connection)
    .where(
      and(
        eq(connection.tenantId, tenantId),
        used.length > 0
          ? or(inArray(connection.id, used), isNotNull(connection.lastSyncAt))
          : isNotNull(connection.lastSyncAt),
      ),
    )
    .orderBy(connection.connector, connection.createdAt);
  return rows.map((c) => ({
    id: c.id,
    connector: c.connector,
    connectorName: platform.connectors.get(c.connector)?.manifest.name ?? c.connector,
    accountName: connectionAccountName(c.config),
    externalAccountId: c.externalAccountId,
    status: c.status,
    lastSyncAt: c.lastSyncAt ? c.lastSyncAt.toISOString() : null,
  }));
}

// --- the page -------------------------------------------------------------------------------

export async function listRecords(
  tx: Tx,
  platform: Platform,
  tenantId: string,
  query: RecordListQuery,
): Promise<RecordList> {
  const kind = query.kind ?? "transactions";
  const q = query.q?.trim() || undefined;
  const { source } = query;
  const offset = query.offset ?? 0;
  const limit = query.limit ?? RECORD_LIST_PAGE;

  const items = latestItems(tx, tenantId, source);
  const counts = {
    transactions: await countTransactions(tx, transactionConds(tenantId, source, undefined)),
    vendors: await countVendors(tx, vendorConds(tenantId, source, undefined)),
    items: await countItems(tx, items, undefined),
  };

  let total: number;
  let page: RecordList["page"];
  if (kind === "transactions") {
    const where = transactionConds(tenantId, source, q);
    total = q ? await countTransactions(tx, where) : counts.transactions;
    page = { kind, rows: await transactionRows(tx, where, offset, limit) };
  } else if (kind === "vendors") {
    const where = vendorConds(tenantId, source, q);
    total = q ? await countVendors(tx, where) : counts.vendors;
    page = { kind, rows: await vendorRows(tx, where, offset, limit) };
  } else {
    const where = itemSearch(items, q);
    total = q ? await countItems(tx, items, where) : counts.items;
    page = { kind, rows: await itemRows(tx, items, where, offset, limit) };
  }

  const sources = await sourcesOf(tx, platform, tenantId);
  const counted = source ? sources.filter((s) => s.id === source) : sources;
  const lastSyncAt =
    counted
      .map((s) => s.lastSyncAt)
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1) ?? null;

  return { counts, lastSyncAt, sources, total, offset, limit, page };
}
