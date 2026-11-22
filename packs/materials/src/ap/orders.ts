// The purchase orders a bill may be against (Plan entry §1.233): the Purchasing area's ordered
// purchase requests (P-5, P-9), each order with its vendor, the references a bill may print (the
// PO document's reference, the order's id in the client's tool), its lines as quoted and ordered,
// and what has been received. Read only; amounts in decimal (invariant 6).

import { dec, toNumeric } from "@countersign/core";
import { document, type Tx, vendor } from "@countersign/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { cents } from "../purchasing/po";
import { quoteLines } from "../purchasing/quotes";
import { ordersOf } from "../purchasing/requests";
import { purchaseRequest, purchaseRequestLine, quoteRequest } from "../schema";
import { apReceipt } from "./schema";

export interface OrderLine {
  requestLineId: string;
  lineNo: number;
  catalogItemId: string | null;
  qty: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
}

export interface Order {
  purchaseRequestId: string;
  quoteRequestId: string;
  vendorId: string;
  vendorName: string;
  /** Every reference a bill may name it by; the first is shown. */
  references: string[];
  /** yyyy-mm-dd: the day it was ordered. */
  date: string;
  currency: string;
  total: string;
  lines: OrderLine[];
}

/**
 * The client's orders placed on or after `since`, each one vendor's (a split order is one per
 * vendor), with the lines the vendor quoted at a price.
 */
// DECISION: an order whose quote isn't named (an order before P-9) is the request's one received
// quote; with several received, it can't be priced, so it isn't offered (a person matches it).
export async function ordersSince(tx: Tx, tenantId: string, since: Date): Promise<Order[]> {
  const requests = await tx
    .select()
    .from(purchaseRequest)
    .where(
      and(
        eq(purchaseRequest.tenantId, tenantId),
        inArray(purchaseRequest.status, ["ordered", "closed"]),
        gte(sql`coalesce(${purchaseRequest.orderedAt}, ${purchaseRequest.updatedAt})`, since),
      ),
    )
    .orderBy(asc(purchaseRequest.createdAt));
  if (requests.length === 0) return [];
  const ids = requests.map((r) => r.id);
  const quotes = await tx
    .select({ q: quoteRequest, vendorName: vendor.name })
    .from(quoteRequest)
    .innerJoin(
      vendor,
      and(eq(vendor.id, quoteRequest.vendorId), eq(vendor.tenantId, quoteRequest.tenantId)),
    )
    .where(and(eq(quoteRequest.tenantId, tenantId), inArray(quoteRequest.purchaseRequestId, ids)));
  const lines = await tx
    .select()
    .from(purchaseRequestLine)
    .where(
      and(
        eq(purchaseRequestLine.tenantId, tenantId),
        inArray(purchaseRequestLine.purchaseRequestId, ids),
      ),
    )
    .orderBy(asc(purchaseRequestLine.lineNo));
  const quoted = await quoteLines(
    tx,
    tenantId,
    quotes.map((q) => q.q.id),
  );
  const docs = await tx
    .select({ meta: document.meta })
    .from(document)
    .where(
      and(
        eq(document.tenantId, tenantId),
        eq(document.source, "generated"),
        sql`${document.meta}->>'kind' = 'purchase_order'`,
        sql`${document.meta}->>'purchaseRequestId' in (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );
  const poRefs = (requestId: string, quoteId: string) =>
    docs
      .map(
        (d) =>
          d.meta as { reference?: unknown; purchaseRequestId?: unknown; quoteRequestId?: unknown },
      )
      .filter((m) => m.purchaseRequestId === requestId && m.quoteRequestId === quoteId)
      .map((m) => (typeof m.reference === "string" ? m.reference : null))
      .filter((r): r is string => r !== null);

  const out: Order[] = [];
  for (const r of requests) {
    const mine = quotes.filter((q) => q.q.purchaseRequestId === r.id);
    for (const o of ordersOf(r)) {
      const received = mine.filter((q) => q.q.status === "received");
      const q = o.quoteRequestId
        ? mine.find((x) => x.q.id === o.quoteRequestId)
        : received.length === 1
          ? received[0]
          : undefined;
      if (!q) continue;
      const orderLines: OrderLine[] = [];
      let total = dec("0");
      for (const row of lines.filter((l) => l.purchaseRequestId === r.id)) {
        const ql = quoted.find(
          (x) => x.quoteRequestId === q.q.id && x.purchaseRequestLineId === row.id,
        );
        if (!ql?.available || ql.unitPrice === null) continue;
        const qty = ql.qty ?? row.qty;
        if (qty === null) continue;
        // As the order computes it (`poContent`): each line to the cent, the total their sum.
        const amount = dec(cents(dec(ql.unitPrice).times(qty)));
        total = total.plus(amount);
        orderLines.push({
          requestLineId: row.id,
          lineNo: row.lineNo,
          catalogItemId: row.catalogItemId,
          qty: toNumeric(qty),
          unit: ql.unit ?? row.unit,
          unitPrice: toNumeric(ql.unitPrice),
          amount: toNumeric(amount),
        });
      }
      if (orderLines.length === 0) continue;
      out.push({
        purchaseRequestId: r.id,
        quoteRequestId: q.q.id,
        vendorId: q.q.vendorId,
        vendorName: q.vendorName,
        references: [...new Set([...poRefs(r.id, q.q.id), o.externalId])],
        date: (r.orderedAt ?? new Date(o.at)).toISOString().slice(0, 10),
        currency: q.q.currency,
        total: toNumeric(total),
        lines: orderLines,
      });
    }
  }
  return out;
}

/** What has been received of an order's lines, by request line id; `whole` when all of it was. */
export async function receivedOf(
  tx: Tx,
  tenantId: string,
  purchaseRequestId: string,
): Promise<{ any: boolean; whole: boolean; byLine: Map<string, string>; ids: string[] }> {
  const rows = await tx
    .select()
    .from(apReceipt)
    .where(
      and(eq(apReceipt.tenantId, tenantId), eq(apReceipt.purchaseRequestId, purchaseRequestId)),
    )
    .orderBy(asc(apReceipt.createdAt));
  const byLine = new Map<string, string>();
  for (const r of rows) {
    if (!r.purchaseRequestLineId || r.qty === null) continue;
    byLine.set(
      r.purchaseRequestLineId,
      toNumeric(dec(byLine.get(r.purchaseRequestLineId) ?? "0").plus(r.qty)),
    );
  }
  return {
    any: rows.length > 0,
    whole: rows.some((r) => r.purchaseRequestLineId === null),
    byLine,
    ids: rows.map((r) => r.id),
  };
}
