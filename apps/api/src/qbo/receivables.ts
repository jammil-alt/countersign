// QuickBooks accounts receivable in the database (ARCHITECTURE §5.5, §6.2 v0.12, docs/plan.md
// §1.41): each Invoice version updates its one `receivable` row (the versions stay in raw_record),
// linked to a directory organization only when one already carries the QuickBooks customer id. New
// and changed receivables raise `receivable.created` / `.updated`, a balance reaching zero
// `receivable.paid`, never during the initial sync (history, not news). Also the synced records
// the qbo tools ask about (ConnectorServices.records): duplicate bills and receivable ids.

import {
  type ConnectionRef,
  normalizeDocNumber,
  type SyncedRecordServices,
} from "@countersign/connectors";
import { dec, mapQboInvoice, QBO_CONNECTOR_ID, type ReceivableInput } from "@countersign/core";
import {
  type Db,
  organization,
  receivable,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import type { emit } from "@countersign/senses";
import { and, eq, inArray, sql } from "drizzle-orm";

type Emit = (e: Parameters<typeof emit>[1]) => Promise<void>;
type ReceivableRow = typeof receivable.$inferSelect;

/** The organization that already has this QuickBooks customer id, or null. */
// DECISION (docs/plan.md §1.41): only an organization whose `external_refs.qbo` is the customer's
// id; names are never matched, and sync never creates an organization (the directory import does).
async function organizationFor(
  tx: Tx,
  tenantId: string,
  customerExternalId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(
      and(
        eq(organization.tenantId, tenantId),
        sql`${organization.externalRefs} ->> ${QBO_CONNECTOR_ID} = ${customerExternalId}`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function money(amount: string, currency: string) {
  return { amount, currency };
}

function payload(row: ReceivableRow) {
  return {
    receivableId: row.id,
    source: row.connector,
    organizationId: row.organizationId,
    total: money(row.total, row.currency),
    balance: money(row.balance, row.currency),
    dueDate: row.dueDate,
    status: row.status,
  };
}

/** What changed between the stored row and the new version, by field name. */
function changes(before: ReceivableRow, after: ReceivableRow): string[] {
  const out: string[] = [];
  if (!dec(before.balance).equals(dec(after.balance))) out.push("balance");
  if (!dec(before.total).equals(dec(after.total)) || before.currency !== after.currency) {
    out.push("total");
  }
  if (before.status !== after.status) out.push("status");
  if (before.dueDate !== after.dueDate) out.push("dueDate");
  if (before.txnDate !== after.txnDate) out.push("txnDate");
  if (before.customerExternalId !== after.customerExternalId) out.push("customer");
  if (before.docNumber !== after.docNumber) out.push("docNumber");
  if (before.privateNote !== after.privateNote) out.push("note");
  return out;
}

/** The columns a version sets (the table's NOT NULL columns get what the invoice lacks). */
// DECISION: an invoice without a number, a customer name or a date (QuickBooks always sends a date)
// is stored with an empty number, its customer's id as the name, and the day it was created.
function columns(r: ReceivableInput, raw: unknown) {
  const created = (raw as { MetaData?: { CreateTime?: string } })?.MetaData?.CreateTime;
  return {
    docNumber: r.docNumber ?? "",
    customerExternalId: r.customerExternalId,
    customerName: r.customerName ?? r.customerExternalId,
    txnDate: r.txnDate ?? (created ? created.slice(0, 10) : new Date().toISOString().slice(0, 10)),
    dueDate: r.dueDate,
    total: r.total,
    balance: r.balance,
    currency: r.currency,
    status: r.status,
    privateNote: r.privateNote,
    ext: r.ext,
  };
}

/** One Invoice version → its receivable; events for news. */
export async function upsertReceivable(
  tx: Tx,
  input: { tenantId: string; connectionId: string; rawId: string; payload: unknown },
  news: Emit,
): Promise<"created" | "updated"> {
  const { tenantId, connectionId } = input;
  const r = mapQboInvoice(input.payload);
  const [existing] = await tx
    .select()
    .from(receivable)
    .where(
      and(
        eq(receivable.tenantId, tenantId),
        eq(receivable.connectionId, connectionId),
        eq(receivable.externalId, r.externalId),
      ),
    )
    .for("update");
  const organizationId =
    existing?.organizationId ?? (await organizationFor(tx, tenantId, r.customerExternalId));
  const fields = {
    ...columns(r, input.payload),
    organizationId,
    sourceRawRecordId: input.rawId,
  };
  if (!existing) {
    const [row] = await tx
      .insert(receivable)
      .values({
        tenantId,
        connectionId,
        connector: QBO_CONNECTOR_ID,
        externalId: r.externalId,
        ...fields,
      })
      .returning();
    if (!row) throw new Error("receivable insert returned nothing");
    await news({
      tenantId,
      type: "receivable.created",
      subjectId: row.id,
      payload: payload(row),
    });
    return "created";
  }
  const [row] = await tx
    .update(receivable)
    .set(fields)
    .where(and(eq(receivable.id, existing.id), eq(receivable.tenantId, tenantId)))
    .returning();
  if (!row) throw new Error("receivable update returned nothing");
  await raiseChange(existing, row, news);
  return "updated";
}

async function raiseChange(before: ReceivableRow, after: ReceivableRow, news: Emit) {
  const changed = changes(before, after);
  if (changed.length === 0) return;
  await news({
    tenantId: after.tenantId,
    type: "receivable.updated",
    subjectId: after.id,
    payload: { ...payload(after), changed },
  });
  // DECISION: `receivable.paid` is raised when an open balance reaches zero (a payment, a credit
  // applied); a void invoice is not paid.
  if (after.status === "paid" && dec(before.balance).greaterThan(0) && before.status === "open") {
    const { status: _status, ...paid } = payload(after);
    await news({
      tenantId: after.tenantId,
      type: "receivable.paid",
      subjectId: after.id,
      payload: paid,
    });
  }
}

/** An invoice deleted in QuickBooks: its receivable is kept, status `deleted`. */
export async function deleteReceivable(
  tx: Tx,
  input: { tenantId: string; connectionId: string; externalId: string; rawId: string },
  news: Emit,
): Promise<void> {
  const [existing] = await tx
    .select()
    .from(receivable)
    .where(
      and(
        eq(receivable.tenantId, input.tenantId),
        eq(receivable.connectionId, input.connectionId),
        eq(receivable.externalId, input.externalId),
      ),
    )
    .for("update");
  if (!existing || existing.status === "deleted") return;
  const [row] = await tx
    .update(receivable)
    .set({ status: "deleted", sourceRawRecordId: input.rawId })
    .where(and(eq(receivable.id, existing.id), eq(receivable.tenantId, input.tenantId)))
    .returning();
  if (row) await raiseChange(existing, row, news);
}

/**
 * What sync stored for one connection, for the qbo tools (ConnectorServices.records): each read in
 * its own transaction for the connection's one client.
 */
export function dbSyncedRecords(
  db: Db,
  conn: Pick<ConnectionRef, "id" | "tenantId">,
): SyncedRecordServices {
  return {
    async syncedBills(q) {
      const want = normalizeDocNumber(q.docNumber);
      if (!want) return [];
      return withTenant(db, conn.tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: transaction.id,
            externalId: transaction.externalId,
            ext: transaction.ext,
          })
          .from(transaction)
          .innerJoin(
            vendor,
            and(eq(vendor.id, transaction.vendorId), eq(vendor.tenantId, transaction.tenantId)),
          )
          .where(
            and(
              eq(transaction.tenantId, conn.tenantId),
              eq(transaction.connector, QBO_CONNECTOR_ID),
              eq(transaction.kind, "bill"),
              sql`${vendor.externalRefs} ->> ${QBO_CONNECTOR_ID} = ${q.vendorExternalId}`,
            ),
          );
        return rows
          .filter((r) => {
            const qbo = (r.ext as { qbo?: { docNumber?: unknown; deleted?: unknown } }).qbo;
            return (
              qbo?.deleted !== true &&
              typeof qbo?.docNumber === "string" &&
              normalizeDocNumber(qbo.docNumber) === want
            );
          })
          .map((r) => ({ transactionId: r.id, externalId: r.externalId }));
      });
    },
    async receivableIds(externalIds) {
      if (externalIds.length === 0) return {};
      const rows = await withTenant(db, conn.tenantId, (tx) =>
        tx
          .select({ id: receivable.id, externalId: receivable.externalId })
          .from(receivable)
          .where(
            and(
              eq(receivable.tenantId, conn.tenantId),
              eq(receivable.connectionId, conn.id),
              inArray(receivable.externalId, externalIds),
            ),
          ),
      );
      return Object.fromEntries(rows.map((r) => [r.externalId, r.id]));
    },
  };
}
