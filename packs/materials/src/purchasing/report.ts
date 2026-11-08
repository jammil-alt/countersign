// The Purchasing area's report (docs/plan.md §1.67): the client's purchase requests, newest first,
// with what was asked, the quotes and the order, as JSON and CSV for the platform's generic report
// routes (/api/reports/materials/requests, and the back office's copy). No screen yet: the UI
// session owns screens. Nothing here names an agent, a prompt or a cost (invariant 11).

import { dec } from "@countersign/core";
import { type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { toCsv } from "../reports";
import { purchaseRequest, purchaseRequestLine, quoteRequest } from "../schema";

export interface RequestsReportRow {
  id: string;
  createdAt: string;
  status: string;
  channel: string;
  neededBy: string | null;
  fulfillment: string | null;
  lines: { description: string; qty: string | null; unit: string | null; matched: boolean }[];
  quotes: { vendor: string; status: string; receivedAt: string | null }[];
  order: string | null;
}

const REPORT_LIMIT = 200;

export async function requestsReport(
  tx: Tx,
  tenantId: string,
): Promise<{ requests: RequestsReportRow[] }> {
  const rows = await tx
    .select()
    .from(purchaseRequest)
    .where(
      and(
        eq(purchaseRequest.tenantId, tenantId),
        sql`not coalesce((${purchaseRequest.ext} ->> 'testRun')::boolean, false)`,
      ),
    )
    .orderBy(desc(purchaseRequest.createdAt), desc(purchaseRequest.id))
    .limit(REPORT_LIMIT);
  if (rows.length === 0) return { requests: [] };
  const ids = rows.map((r) => r.id);
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
  const quotes = await tx
    .select({ q: quoteRequest, vendorName: vendor.name })
    .from(quoteRequest)
    .innerJoin(vendor, eq(vendor.id, quoteRequest.vendorId))
    .where(and(eq(quoteRequest.tenantId, tenantId), inArray(quoteRequest.purchaseRequestId, ids)))
    .orderBy(asc(vendor.name));
  return {
    requests: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      status: r.status,
      channel: r.channel,
      neededBy: r.neededBy,
      fulfillment: r.fulfillment,
      lines: lines
        .filter((l) => l.purchaseRequestId === r.id)
        .map((l) => ({
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          matched: l.catalogItemId !== null,
        })),
      quotes: quotes
        .filter((x) => x.q.purchaseRequestId === r.id)
        .map((x) => ({
          vendor: x.vendorName,
          status: x.q.status,
          receivedAt: x.q.receivedAt ? x.q.receivedAt.toISOString() : null,
        })),
      order: r.orderExternalId,
    })),
  };
}

export function requestsCsv(report: { requests: RequestsReportRow[] }): string {
  return toCsv([
    ["Asked on", "Status", "Channel", "Needed by", "Delivery", "Items", "Quotes", "Order"],
    ...report.requests.map((r) => [
      r.createdAt.slice(0, 10),
      r.status,
      r.channel,
      r.neededBy,
      r.fulfillment,
      r.lines
        // P-9 (0036): a line with no quantity yet reads "x ?".
        .map(
          (l) =>
            `${l.description} x ${l.qty === null ? "?" : dec(l.qty).toString()}${l.unit ? ` ${l.unit}` : ""}`,
        )
        .join("; "),
      r.quotes.map((q) => `${q.vendor}: ${q.status}`).join("; "),
      r.order,
    ]),
  ]);
}
