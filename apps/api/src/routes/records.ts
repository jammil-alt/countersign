// Record pages (docs/plan.md §1.16): what a source id names (invariant 10), for the portal (its own
// client) and the back office (one served client at a time), plus the back office's lists of a
// client's records (./record-list) and documents, through the documents routes' views and 5-minute
// links. Every query names
// the client as well as relying on RLS (invariant 1).

import { routes, VENDOR_RECENT_TRANSACTIONS } from "@countersign/core";
import {
  docExtraction,
  document,
  rawRecord,
  type Tx,
  tenant,
  transaction,
  transactionLine,
  vendor,
} from "@countersign/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, iso, mount, notFound } from "../http";
import { documentDetail, recentDocuments } from "./documents";
import { isSandbox } from "./ops-clients";
import { listRecords } from "./record-list";

type TxnRow = typeof transaction.$inferSelect;

function brief(t: TxnRow) {
  return {
    id: t.id,
    txnKind: t.kind,
    txnDate: t.txnDate,
    total: t.total,
    currency: t.currency,
  };
}

async function transactionRecord(tx: Tx, tenantId: string, t: TxnRow) {
  const [v] = t.vendorId
    ? await tx
        .select({ id: vendor.id, name: vendor.name })
        .from(vendor)
        .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, t.vendorId)))
    : [];
  const lines = await tx
    .select()
    .from(transactionLine)
    .where(and(eq(transactionLine.tenantId, tenantId), eq(transactionLine.transactionId, t.id)))
    .orderBy(asc(transactionLine.lineNo));
  const docs = await tx
    .select({ id: document.id, filename: document.filename, status: document.status })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.transactionId, t.id)))
    .orderBy(desc(document.receivedAt));
  return {
    kind: "transaction" as const,
    id: t.id,
    txnKind: t.kind,
    connector: t.connector,
    externalId: t.externalId,
    vendor: v ?? null,
    txnDate: t.txnDate,
    total: t.total,
    currency: t.currency,
    purchaserRef: t.purchaserRef,
    paymentType: t.paymentType,
    memo: t.memo,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    lines: lines.map((l) => ({
      lineNo: l.lineNo,
      detailType: l.detailType,
      accountRef: l.accountRef,
      itemRef: l.itemRef,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: l.amount,
    })),
    documents: docs,
    rawRecordId: t.sourceRawRecordId,
  };
}

/**
 * The record a source id names in one client, or null. Ids are uuids made once per table, so the
 * first table that has it is the one.
 */
// DECISION: a record page covers the platform's shared records (transaction, raw record, document,
// vendor); an extraction id opens its document's page, which shows the reading. Ids of anything
// else (a pack's rows, runs, inbox items) answer 404: the platform never special-cases a pack.
export async function findRecord(tx: Tx, tenantId: string, id: string) {
  const [t] = await tx
    .select()
    .from(transaction)
    .where(and(eq(transaction.tenantId, tenantId), eq(transaction.id, id)));
  if (t) return transactionRecord(tx, tenantId, t);

  const [d] = await tx
    .select()
    .from(document)
    .where(and(eq(document.tenantId, tenantId), eq(document.id, id)));
  const [x] = d
    ? []
    : await tx
        .select({ documentId: docExtraction.documentId })
        .from(docExtraction)
        .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.id, id)));
  const doc =
    d ??
    (x
      ? (
          await tx
            .select()
            .from(document)
            .where(and(eq(document.tenantId, tenantId), eq(document.id, x.documentId)))
        )[0]
      : undefined);
  if (doc) {
    return {
      kind: "document" as const,
      id,
      documentId: doc.id,
      filename: doc.filename,
      status: doc.status,
      source: doc.source,
      receivedAt: doc.receivedAt.toISOString(),
    };
  }

  const [r] = await tx
    .select()
    .from(rawRecord)
    .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.id, id)));
  if (r) {
    const made = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, tenantId), eq(transaction.sourceRawRecordId, r.id)))
      .orderBy(desc(transaction.createdAt));
    return {
      kind: "raw_record" as const,
      id: r.id,
      connector: r.connector,
      entityType: r.entityType,
      externalId: r.externalId,
      externalVersion: r.externalVersion,
      syncedAt: r.syncedAt.toISOString(),
      isDeleted: r.isDeleted,
      payload: r.payload,
      transactions: made.map(brief),
    };
  }

  const [v] = await tx
    .select()
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, id)));
  if (v) {
    const recent = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.tenantId, tenantId), eq(transaction.vendorId, v.id)))
      .orderBy(desc(transaction.txnDate), desc(transaction.createdAt))
      .limit(VENDOR_RECENT_TRANSACTIONS);
    return {
      kind: "vendor" as const,
      id: v.id,
      name: v.name,
      aliases: v.aliases,
      createdAt: iso(v.createdAt) as string,
      transactions: recent.map(brief),
    };
  }
  return null;
}

export function recordRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalRecord, async ({ tx, tenantIds, params }) => {
    const record = await findRecord(tx, tenantIds[0] as string, params.id);
    if (!record) throw notFound("record");
    return { record };
  });

  mount(app, routes.opsClientRecord, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const record = await findRecord(ctx.tx, ctx.params.id, ctx.params.recordId);
    if (!record) throw notFound("record");
    return { record };
  });

  // v0.12 W1-H: the portal's list of the client's own records (docs/plan.md §1.43): the back
  // office's list, in the portal's one-client transaction, naming the client in every query.
  mount(app, routes.portalRecords, async ({ tx, tenantIds, services, query }) =>
    listRecords(tx, services.platform, tenantIds[0] as string, query),
  );

  mount(app, routes.opsClientRecords, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return listRecords(ctx.tx, ctx.services.platform, ctx.params.id, ctx.query);
  });

  mount(app, routes.opsClientDocuments, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const [t] = await ctx.tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, ctx.params.id));
    if (!t) throw notFound("client");
    return {
      documents: await recentDocuments(ctx.tx, ctx.params.id, ctx.query.limit ?? 50),
      sandbox: isSandbox(t.settings),
    };
  });

  mount(app, routes.opsClientDocument, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    return documentDetail(ctx, ctx.params.id, ctx.params.documentId);
  });
}
