// Purchase requests (docs/plan.md §1.67): what someone asked to buy, its lines matched to the
// catalog, and its status from open to ordered. Each function runs in one client-scoped
// transaction (withTenant: RLS shows one client's rows, invariant 1); queries also filter by
// tenant_id. Every write records the agent version and run that made it (invariant 10). Nothing
// here writes to a client's tool: the order itself is placed elsewhere (QuickBooks, approval on)
// and only its reference is kept here.

import {
  contact,
  type Db,
  membership,
  rawRecord,
  type Tx,
  vendor,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { type CatalogItemRow, liveItem } from "../catalog/store";
import { materialsEventRegistry } from "../events";
import {
  type Fulfillment,
  purchaseRequest,
  purchaseRequestLine,
  quoteRequest,
  type RequestChannel,
  type RequestStatus,
} from "../schema";
import { matchText, type TextCandidate } from "./match-text";

export interface PurchasingContext {
  tenantId: string;
  agentVersionId: string;
  /** The run writing, recorded on the rows; null outside a run. */
  runId: string | null;
  testRun: boolean;
}

export class PurchasingError extends Error {
  override name = "PurchasingError";
  constructor(
    readonly code: "not_found" | "status" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────────

const STEP: Record<RequestStatus, number> = {
  open: 0,
  quoting: 1,
  quoted: 2,
  ordered: 3,
  closed: 4,
  cancelled: 5,
};

/** Why a request can't move from one status to another; null when it can. */
export function statusMoveProblem(from: RequestStatus, to: RequestStatus): string | null {
  if (from === to) return null;
  if (from === "cancelled" || from === "closed") return `the request is ${from}`;
  if (to === "cancelled") {
    return STEP[from] < STEP.ordered ? null : "an ordered request can't be cancelled; close it";
  }
  if (STEP[to] > STEP[from]) return null;
  return `a request's status only moves forward, not from ${from} back to ${to}`;
}

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

export interface RequestLineView {
  id: string;
  lineNo: number;
  description: string;
  /** P-9 (0036): null while nobody has said how many. */
  qty: string | null;
  unit: string | null;
  notes: string | null;
  catalogItemId: string | null;
  catalogItemName: string | null;
  standardUom: string | null;
  matchMethod: string | null;
  matchConfidence: number | null;
  candidates: TextCandidate[];
}

export interface QuoteSummary {
  id: string;
  vendorId: string;
  vendorName: string;
  status: string;
  sentAt: string | null;
  dueAt: string | null;
  receivedAt: string | null;
}

export interface RequestView {
  id: string;
  status: RequestStatus;
  channel: RequestChannel;
  requestedByContactId: string | null;
  requestedByUserId: string | null;
  rawRecordId: string | null;
  neededBy: string | null;
  fulfillment: Fulfillment | null;
  deliverTo: string | null;
  notes: string | null;
  orderConnector: string | null;
  orderExternalId: string | null;
  orderedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: RequestLineView[];
  quotes: QuoteSummary[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export type RequestRow = typeof purchaseRequest.$inferSelect;
export type RequestLineRow = typeof purchaseRequestLine.$inferSelect;

export async function requestRow(tx: Tx, tenantId: string, id: string): Promise<RequestRow> {
  const [row] = await tx
    .select()
    .from(purchaseRequest)
    .where(and(eq(purchaseRequest.tenantId, tenantId), eq(purchaseRequest.id, id)))
    .limit(1);
  if (!row) throw new PurchasingError("not_found", `purchase request ${id} not found`);
  return row;
}

/** A request's lines, oldest first, each with its catalog item as it is now (merges followed). */
export async function requestLines(
  tx: Tx,
  tenantId: string,
  requestId: string,
): Promise<{ row: RequestLineRow; item: CatalogItemRow | null }[]> {
  const rows = await tx
    .select()
    .from(purchaseRequestLine)
    .where(
      and(
        eq(purchaseRequestLine.tenantId, tenantId),
        eq(purchaseRequestLine.purchaseRequestId, requestId),
      ),
    )
    .orderBy(asc(purchaseRequestLine.lineNo));
  const out = [];
  for (const row of rows) {
    out.push({
      row,
      item: row.catalogItemId ? await liveItem(tx, tenantId, row.catalogItemId) : null,
    });
  }
  return out;
}

export function lineView(row: RequestLineRow, item: CatalogItemRow | null): RequestLineView {
  return {
    id: row.id,
    lineNo: row.lineNo,
    description: row.description,
    qty: row.qty,
    unit: row.unit,
    notes: row.notes,
    catalogItemId: item?.id ?? null,
    catalogItemName: item?.canonicalName ?? null,
    standardUom: item?.standardUom ?? null,
    matchMethod: row.matchMethod,
    matchConfidence: row.matchConfidence === null ? null : Number(row.matchConfidence),
    candidates: row.candidates as TextCandidate[],
  };
}

export async function quoteSummaries(
  tx: Tx,
  tenantId: string,
  requestId: string,
): Promise<QuoteSummary[]> {
  const rows = await tx
    .select({ q: quoteRequest, vendorName: vendor.name })
    .from(quoteRequest)
    .innerJoin(vendor, eq(vendor.id, quoteRequest.vendorId))
    .where(and(eq(quoteRequest.tenantId, tenantId), eq(quoteRequest.purchaseRequestId, requestId)))
    .orderBy(asc(vendor.name), asc(quoteRequest.id));
  return rows.map(({ q, vendorName }) => ({
    id: q.id,
    vendorId: q.vendorId,
    vendorName,
    status: q.status,
    sentAt: iso(q.sentAt),
    dueAt: iso(q.dueAt),
    receivedAt: iso(q.receivedAt),
  }));
}

export async function loadRequest(tx: Tx, tenantId: string, id: string): Promise<RequestView> {
  const r = await requestRow(tx, tenantId, id);
  const lines = await requestLines(tx, tenantId, id);
  return {
    id: r.id,
    status: r.status,
    channel: r.channel,
    requestedByContactId: r.requestedByContactId,
    requestedByUserId: r.requestedByUserId,
    rawRecordId: r.rawRecordId,
    neededBy: r.neededBy,
    fulfillment: r.fulfillment,
    deliverTo: r.deliverTo,
    notes: r.notes,
    orderConnector: r.orderConnector,
    orderExternalId: r.orderExternalId,
    orderedAt: iso(r.orderedAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lines: lines.map((l) => lineView(l.row, l.item)),
    quotes: await quoteSummaries(tx, tenantId, id),
  };
}

/** The records a request view rests on (invariant 10). */
export function requestSources(view: RequestView): string[] {
  return [
    view.id,
    ...(view.rawRecordId ? [view.rawRecordId] : []),
    ...view.lines.flatMap((l) => [l.id, ...(l.catalogItemId ? [l.catalogItemId] : [])]),
    ...view.quotes.map((q) => q.id),
  ];
}

// ── Writes ───────────────────────────────────────────────────────────────────────────────────────

export interface NewLine {
  description: string;
  /** P-9: null when nobody said how many. */
  qty: string | null;
  unit?: string | null | undefined;
  notes?: string | null | undefined;
}

async function insertLines(
  tx: Tx,
  tenantId: string,
  requestId: string,
  firstLineNo: number,
  lines: readonly NewLine[],
): Promise<void> {
  for (const [i, line] of lines.entries()) {
    const m = await matchText(tx, tenantId, { description: line.description });
    const matched = m.decision === "matched" && m.item;
    await tx.insert(purchaseRequestLine).values({
      tenantId,
      purchaseRequestId: requestId,
      lineNo: firstLineNo + i,
      description: line.description,
      qty: line.qty,
      unit: line.unit ?? null,
      notes: line.notes ?? null,
      catalogItemId: matched ? m.item?.id : null,
      matchMethod: matched ? m.method : null,
      matchConfidence: matched ? m.confidence.toFixed(3) : null,
      candidates: matched ? [] : m.candidates,
    });
  }
}

async function exists(
  tx: Tx,
  what: "contact" | "user" | "raw record",
  tenantId: string,
  id: string,
) {
  const rows =
    what === "contact"
      ? await tx
          .select({ id: contact.id })
          .from(contact)
          .where(and(eq(contact.tenantId, tenantId), eq(contact.id, id)))
          .limit(1)
      : what === "user"
        ? await tx
            .select({ id: membership.userId })
            .from(membership)
            .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, id)))
            .limit(1)
        : await tx
            .select({ id: rawRecord.id })
            .from(rawRecord)
            .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.id, id)))
            .limit(1);
  if (rows.length === 0) throw new PurchasingError("not_found", `${what} ${id} not found`);
}

export interface CreateRequestInput {
  channel: RequestChannel;
  requestedByContactId?: string | undefined;
  requestedByUserId?: string | undefined;
  rawRecordId?: string | undefined;
  neededBy?: string | undefined;
  fulfillment?: Fulfillment | undefined;
  deliverTo?: string | undefined;
  notes?: string | undefined;
  lines: readonly NewLine[];
}

/** Opens a request with its lines, each matched to the catalog when the rules are sure. */
export async function createRequest(
  db: Db,
  ctx: PurchasingContext,
  input: CreateRequestInput,
): Promise<RequestView> {
  if (input.requestedByContactId && input.requestedByUserId) {
    throw new PurchasingError("invalid", "a request is asked by a contact or a user, not both");
  }
  return withTenant(db, ctx.tenantId, async (tx) => {
    if (input.requestedByContactId) {
      await exists(tx, "contact", ctx.tenantId, input.requestedByContactId);
    }
    if (input.requestedByUserId) await exists(tx, "user", ctx.tenantId, input.requestedByUserId);
    if (input.rawRecordId) await exists(tx, "raw record", ctx.tenantId, input.rawRecordId);
    const [row] = await tx
      .insert(purchaseRequest)
      .values({
        tenantId: ctx.tenantId,
        channel: input.channel,
        requestedByContactId: input.requestedByContactId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        rawRecordId: input.rawRecordId ?? null,
        neededBy: input.neededBy ?? null,
        fulfillment: input.fulfillment ?? null,
        deliverTo: input.deliverTo ?? null,
        notes: input.notes ?? null,
        runId: ctx.runId,
        agentVersionId: ctx.agentVersionId,
        // DECISION: a test run's requests are written like a live run's (they are the platform's
        // own records, not a client's tool) and marked, so lists leave them out.
        ext: ctx.testRun ? { testRun: true } : {},
      })
      .returning({ id: purchaseRequest.id });
    if (!row) throw new Error("purchase_request insert returned nothing");
    await insertLines(tx, ctx.tenantId, row.id, 1, input.lines);
    const view = await loadRequest(tx, ctx.tenantId, row.id);
    // P-9: news for the area's workflows (docs/plan.md §1.71); a test run's emits nothing.
    await emit(
      tx,
      {
        tenantId: ctx.tenantId,
        type: "materials.request.created",
        subjectId: view.id,
        payload: {
          requestId: view.id,
          channel: view.channel,
          lines: view.lines.length,
          unmatched: view.lines.filter((l) => !l.catalogItemId).length,
          withoutQuantity: view.lines.filter((l) => l.qty === null).length,
        },
      },
      { registry: materialsEventRegistry(), testRun: ctx.testRun },
    );
    return view;
  });
}

export async function getRequest(db: Db, ctx: PurchasingContext, id: string) {
  return withTenant(db, ctx.tenantId, (tx) => loadRequest(tx, ctx.tenantId, id));
}

export interface ListRequestsInput {
  statuses?: readonly RequestStatus[] | undefined;
  limit?: number | undefined;
  includeTest?: boolean | undefined;
}

export interface RequestSummary {
  id: string;
  status: RequestStatus;
  channel: RequestChannel;
  neededBy: string | null;
  createdAt: string;
  lines: number;
  matchedLines: number;
  quotes: number;
  quotesReceived: number;
  orderExternalId: string | null;
}

/** Requests, newest first. */
export async function listRequests(
  db: Db,
  ctx: PurchasingContext,
  input: ListRequestsInput,
): Promise<RequestSummary[]> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const filters = [eq(purchaseRequest.tenantId, ctx.tenantId)];
    if (input.statuses && input.statuses.length > 0) {
      filters.push(inArray(purchaseRequest.status, [...input.statuses]));
    }
    if (!input.includeTest) {
      filters.push(sql`not coalesce((${purchaseRequest.ext} ->> 'testRun')::boolean, false)`);
    }
    const rows = await tx
      .select()
      .from(purchaseRequest)
      .where(and(...filters))
      .orderBy(desc(purchaseRequest.createdAt), desc(purchaseRequest.id))
      .limit(Math.min(Math.max(input.limit ?? 25, 1), 100));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const lines = await tx
      .select({
        requestId: purchaseRequestLine.purchaseRequestId,
        matched: sql<boolean>`${purchaseRequestLine.catalogItemId} is not null`,
      })
      .from(purchaseRequestLine)
      .where(
        and(
          eq(purchaseRequestLine.tenantId, ctx.tenantId),
          inArray(purchaseRequestLine.purchaseRequestId, ids),
        ),
      );
    const quotes = await tx
      .select({ requestId: quoteRequest.purchaseRequestId, status: quoteRequest.status })
      .from(quoteRequest)
      .where(
        and(eq(quoteRequest.tenantId, ctx.tenantId), inArray(quoteRequest.purchaseRequestId, ids)),
      );
    return rows.map((r) => {
      const own = lines.filter((l) => l.requestId === r.id);
      const qs = quotes.filter((q) => q.requestId === r.id);
      return {
        id: r.id,
        status: r.status,
        channel: r.channel,
        neededBy: r.neededBy,
        createdAt: r.createdAt.toISOString(),
        lines: own.length,
        matchedLines: own.filter((l) => l.matched).length,
        quotes: qs.length,
        quotesReceived: qs.filter((q) => q.status === "received").length,
        orderExternalId: r.orderExternalId,
      };
    });
  });
}

export interface UpdateRequestInput {
  requestId: string;
  status?: RequestStatus | undefined;
  neededBy?: string | null | undefined;
  fulfillment?: Fulfillment | null | undefined;
  deliverTo?: string | null | undefined;
  notes?: string | null | undefined;
  order?: { connector: string; externalId: string } | undefined;
}

/**
 * Changes a request's status and fields. The status only moves forward; any status before
 * `ordered` may be cancelled. An order's reference moves the request to `ordered`.
 */
export async function updateRequest(
  db: Db,
  ctx: PurchasingContext,
  input: UpdateRequestInput,
): Promise<{ request: RequestView; changed: string[] }> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    const target: RequestStatus = input.status ?? (input.order ? "ordered" : r.status);
    const problem = statusMoveProblem(r.status, target);
    if (problem) throw new PurchasingError("status", problem);
    if (input.order && target !== "ordered") {
      throw new PurchasingError("invalid", "an order's reference comes with the status ordered");
    }
    // DECISION: a request is ordered once; a different order reference is refused (a second
    // order is a new request). The same one again changes nothing.
    if (
      input.order &&
      r.orderExternalId !== null &&
      (r.orderExternalId !== input.order.externalId || r.orderConnector !== input.order.connector)
    ) {
      throw new PurchasingError(
        "status",
        `the request is already ordered as ${r.orderConnector} ${r.orderExternalId}`,
      );
    }
    const set: Partial<typeof purchaseRequest.$inferInsert> = {};
    const changed: string[] = [];
    const field = <K extends "neededBy" | "fulfillment" | "deliverTo" | "notes">(key: K) => {
      const value = input[key];
      if (value === undefined || value === r[key]) return;
      set[key] = value as never;
      changed.push(key);
    };
    field("neededBy");
    field("fulfillment");
    field("deliverTo");
    field("notes");
    if (changed.length > 0 && (r.status === "cancelled" || r.status === "closed")) {
      throw new PurchasingError("status", `the request is ${r.status}`);
    }
    if (target !== r.status) {
      set.status = target;
      changed.push("status");
      if (target === "ordered") set.orderedAt = new Date();
    }
    if (input.order && r.orderExternalId === null) {
      set.orderConnector = input.order.connector;
      set.orderExternalId = input.order.externalId;
      changed.push("order");
    }
    if (changed.length > 0) {
      await tx
        .update(purchaseRequest)
        .set({ ...set, updatedAt: new Date() })
        .where(and(eq(purchaseRequest.tenantId, ctx.tenantId), eq(purchaseRequest.id, r.id)));
    }
    return { request: await loadRequest(tx, ctx.tenantId, r.id), changed };
  });
}

/** Adds lines to a request still open or out for quotes, matching each to the catalog. */
export async function addLines(
  db: Db,
  ctx: PurchasingContext,
  input: { requestId: string; lines: readonly NewLine[] },
): Promise<RequestView> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    // DECISION: lines are added while the request is open or out for quotes; once quotes are in,
    // a new need is a new request, so the quotes compared are for the lines asked.
    if (r.status !== "open" && r.status !== "quoting") {
      throw new PurchasingError("status", `lines can't be added to a ${r.status} request`);
    }
    const [last] = await tx
      .select({ n: max(purchaseRequestLine.lineNo) })
      .from(purchaseRequestLine)
      .where(
        and(
          eq(purchaseRequestLine.tenantId, ctx.tenantId),
          eq(purchaseRequestLine.purchaseRequestId, r.id),
        ),
      );
    await insertLines(tx, ctx.tenantId, r.id, (last?.n ?? 0) + 1, input.lines);
    await tx
      .update(purchaseRequest)
      .set({ updatedAt: new Date() })
      .where(and(eq(purchaseRequest.tenantId, ctx.tenantId), eq(purchaseRequest.id, r.id)));
    return loadRequest(tx, ctx.tenantId, r.id);
  });
}

export interface MatchLinesResult {
  request: RequestView;
  matched: number;
  unsure: number;
  chosen: number;
}

/**
 * Matches the request's unmatched lines again (aliases and items may have been added since), and
 * records a person's choices: a line and the catalog item they said it is.
 */
// DECISION: a choice names any live item of the client's catalog, not only a candidate: the
// person may know better than the rules. It is recorded as `chosen`, confidence 1.
export async function matchRequestLines(
  db: Db,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    choices?: readonly { lineId: string; catalogItemId: string }[] | undefined;
  },
): Promise<MatchLinesResult> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    if (r.status === "cancelled" || r.status === "closed") {
      throw new PurchasingError("status", `the request is ${r.status}`);
    }
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    const choices = new Map((input.choices ?? []).map((c) => [c.lineId, c.catalogItemId]));
    for (const lineId of choices.keys()) {
      if (!lines.some((l) => l.row.id === lineId)) {
        throw new PurchasingError("not_found", `line ${lineId} is not on this request`);
      }
    }
    const where = (id: string) =>
      and(eq(purchaseRequestLine.tenantId, ctx.tenantId), eq(purchaseRequestLine.id, id));
    let chosen = 0;
    for (const { row } of lines) {
      const choice = choices.get(row.id);
      if (choice) {
        const item = await liveItem(tx, ctx.tenantId, choice);
        if (!item) throw new PurchasingError("not_found", `catalog item ${choice} not found`);
        await tx
          .update(purchaseRequestLine)
          .set({
            catalogItemId: item.id,
            matchMethod: "chosen",
            matchConfidence: "1.000",
            candidates: [],
          })
          .where(where(row.id));
        chosen++;
        continue;
      }
      if (row.catalogItemId) continue;
      const m = await matchText(tx, ctx.tenantId, { description: row.description });
      if (m.decision === "matched" && m.item) {
        await tx
          .update(purchaseRequestLine)
          .set({
            catalogItemId: m.item.id,
            matchMethod: m.method,
            matchConfidence: m.confidence.toFixed(3),
            candidates: [],
          })
          .where(where(row.id));
      } else {
        await tx.update(purchaseRequestLine).set({ candidates: m.candidates }).where(where(row.id));
      }
    }
    const request = await loadRequest(tx, ctx.tenantId, r.id);
    return {
      request,
      matched: request.lines.filter((l) => l.catalogItemId).length,
      unsure: request.lines.filter((l) => !l.catalogItemId).length,
      chosen,
    };
  });
}

// ── P-9: a line's quantity or words, fixed by a person (docs/plan.md §1.71) ─────────────────────

export interface LineChange {
  lineId: string;
  description?: string | undefined;
  qty?: string | undefined;
  unit?: string | null | undefined;
  notes?: string | null | undefined;
}

/**
 * Changes lines of a request still open (before any vendor is asked): a quantity nobody stated, a
 * unit, the words of what is wanted (matched to the catalog again, unless a person chose its item),
 * a note. Answers the changed fields per line.
 */
// DECISION: lines change only while the request is open; once vendors are asked, a change is a new
// request, so every quote compared is for the lines as asked.
export async function updateLines(
  db: Db,
  ctx: PurchasingContext,
  input: { requestId: string; lines: readonly LineChange[] },
): Promise<{ request: RequestView; changed: { lineId: string; fields: string[] }[] }> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    if (r.status !== "open") {
      throw new PurchasingError("status", `lines of a ${r.status} request can't change`);
    }
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    const changed: { lineId: string; fields: string[] }[] = [];
    for (const change of input.lines) {
      const line = lines.find((l) => l.row.id === change.lineId);
      if (!line)
        throw new PurchasingError("not_found", `line ${change.lineId} is not on this request`);
      const set: Partial<typeof purchaseRequestLine.$inferInsert> = {};
      const fields: string[] = [];
      if (change.qty !== undefined && change.qty !== line.row.qty) {
        set.qty = change.qty;
        fields.push("qty");
      }
      if (change.unit !== undefined && change.unit !== line.row.unit) {
        set.unit = change.unit;
        fields.push("unit");
      }
      if (change.notes !== undefined && change.notes !== line.row.notes) {
        set.notes = change.notes;
        fields.push("notes");
      }
      if (change.description !== undefined && change.description !== line.row.description) {
        set.description = change.description;
        fields.push("description");
        if (line.row.matchMethod !== "chosen") {
          const m = await matchText(tx, ctx.tenantId, { description: change.description });
          const matched = m.decision === "matched" && m.item;
          set.catalogItemId = matched ? (m.item?.id ?? null) : null;
          set.matchMethod = matched ? m.method : null;
          set.matchConfidence = matched ? m.confidence.toFixed(3) : null;
          set.candidates = matched ? [] : m.candidates;
        }
      }
      if (fields.length === 0) continue;
      await tx
        .update(purchaseRequestLine)
        .set(set)
        .where(
          and(
            eq(purchaseRequestLine.tenantId, ctx.tenantId),
            eq(purchaseRequestLine.id, line.row.id),
          ),
        );
      changed.push({ lineId: line.row.id, fields });
    }
    if (changed.length > 0) {
      await tx
        .update(purchaseRequest)
        .set({ updatedAt: new Date() })
        .where(and(eq(purchaseRequest.tenantId, ctx.tenantId), eq(purchaseRequest.id, r.id)));
    }
    return { request: await loadRequest(tx, ctx.tenantId, r.id), changed };
  });
}
