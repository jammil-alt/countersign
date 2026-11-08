// Requests for quotes (docs/plan.md §1.67): one RFQ per vendor for a purchase request, marked sent
// once a message went out, and the vendor's answer recorded line by line against the request's
// lines. A vendor's words are kept as data (invariant 9): they are stored and compared, never
// followed. Quoted prices get their standard-unit price only through a conversion rule
// (invariant 7). A quote is not a price observation: price history stays what was paid.

import { dec, toNumeric } from "@countersign/core";
import {
  type Db,
  docLine,
  document,
  rawRecord,
  reachOut,
  type Tx,
  tenant,
  vendor,
  withTenant,
} from "@countersign/db";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { parseLine } from "../catalog/keys";
import type { CatalogItemRow } from "../catalog/store";
import { convert } from "../pricing/uom";
import {
  itemAlias,
  priceObservation,
  purchaseRequest,
  type QuoteChannel,
  quoteLine,
  quoteRequest,
  type RequestStatus,
} from "../schema";
// P-9
import { vendorContacts } from "./contacts";
import {
  type PurchasingContext,
  PurchasingError,
  type RequestLineRow,
  requestLines,
  requestRow,
} from "./requests";
import { rfqSubject, rfqText } from "./rfq";

export type QuoteRow = typeof quoteRequest.$inferSelect;
export type QuoteLineRow = typeof quoteLine.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Statuses a request takes quotes in. */
const QUOTABLE: readonly RequestStatus[] = ["open", "quoting", "quoted"];

export async function quoteRow(tx: Tx, tenantId: string, id: string): Promise<QuoteRow> {
  const [row] = await tx
    .select()
    .from(quoteRequest)
    .where(and(eq(quoteRequest.tenantId, tenantId), eq(quoteRequest.id, id)))
    .limit(1);
  if (!row) throw new PurchasingError("not_found", `quote request ${id} not found`);
  return row;
}

async function vendorName(tx: Tx, tenantId: string, id: string): Promise<string> {
  const [row] = await tx
    .select({ name: vendor.name })
    .from(vendor)
    .where(and(eq(vendor.tenantId, tenantId), eq(vendor.id, id)))
    .limit(1);
  return row?.name ?? "A vendor";
}

export interface QuoteView {
  id: string;
  requestId: string;
  vendorId: string;
  vendorName: string;
  status: string;
  sentAt: string | null;
  sentVia: string | null;
  dueAt: string | null;
  receivedAt: string | null;
  currency: string;
  notes: string | null;
}

function quoteView(q: QuoteRow, name: string): QuoteView {
  return {
    id: q.id,
    requestId: q.purchaseRequestId,
    vendorId: q.vendorId,
    vendorName: name,
    status: q.status,
    sentAt: iso(q.sentAt),
    sentVia: q.sentVia,
    dueAt: iso(q.dueAt),
    receivedAt: iso(q.receivedAt),
    currency: q.currency,
    notes: q.notes,
  };
}

export interface QuoteLineView {
  id: string;
  requestLineId: string;
  catalogItemId: string | null;
  description: string | null;
  qty: string | null;
  unit: string | null;
  unitPrice: string | null;
  currency: string;
  unitPriceStd: string | null;
  standardUom: string | null;
  leadTimeDays: number | null;
  available: boolean;
  notes: string | null;
}

export function quoteLineView(l: QuoteLineRow): QuoteLineView {
  return {
    id: l.id,
    requestLineId: l.purchaseRequestLineId,
    catalogItemId: l.catalogItemId,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    unitPrice: l.unitPrice,
    currency: l.currency,
    unitPriceStd: l.unitPriceStd,
    standardUom: l.standardUom,
    leadTimeDays: l.leadTimeDays,
    available: l.available,
    notes: l.notes,
  };
}

export async function quoteLines(tx: Tx, tenantId: string, quoteIds: readonly string[]) {
  if (quoteIds.length === 0) return [];
  return tx
    .select()
    .from(quoteLine)
    .where(and(eq(quoteLine.tenantId, tenantId), inArray(quoteLine.quoteRequestId, [...quoteIds])))
    .orderBy(asc(quoteLine.createdAt), asc(quoteLine.id));
}

// ── Create ───────────────────────────────────────────────────────────────────────────────────────

export interface RfqLine {
  requestLineId: string;
  lineNo: number;
  description: string;
  qty: string;
  unit: string | null;
  catalogItemName: string | null;
  /** What this vendor called the item before (its alias), when it did. */
  vendorDescription: string | null;
  vendorSku: string | null;
}

export interface CreatedQuote extends QuoteView {
  created: boolean;
  /** The lines to ask this vendor about, in its own words where it has them. */
  lines: RfqLine[];
  // P-9: who to send it to and the words to send (docs/plan.md §1.71).
  /** The vendor's person who may be emailed (materials.vendor-contacts), else null. */
  contactId: string | null;
  contactName: string | null;
  /** The email's subject and text, for reach out's fixed message. */
  subject: string;
  rfqText: string;
}

/** The vendor's own name for an item: its SKU and description aliases, a person's first. */
export async function vendorAliases(tx: Tx, tenantId: string, vendorId: string, itemId: string) {
  const rows = await tx
    .select()
    .from(itemAlias)
    .where(
      and(
        eq(itemAlias.tenantId, tenantId),
        eq(itemAlias.vendorId, vendorId),
        eq(itemAlias.catalogItemId, itemId),
      ),
    )
    .orderBy(desc(itemAlias.source), desc(itemAlias.updatedAt));
  // P-9: the vendor's own words are the description on its latest invoice line for the item (a
  // priced document line), else the alias's normalized description.
  const [own] = await tx
    .select({ description: docLine.rawDescription })
    .from(priceObservation)
    .innerJoin(
      docLine,
      and(eq(docLine.id, priceObservation.docLineId), eq(docLine.tenantId, tenantId)),
    )
    .where(
      and(
        eq(priceObservation.tenantId, tenantId),
        eq(priceObservation.vendorId, vendorId),
        eq(priceObservation.catalogItemId, itemId),
        isNotNull(priceObservation.docLineId),
      ),
    )
    .orderBy(desc(priceObservation.observedOn), desc(priceObservation.id))
    .limit(1);
  return {
    sku: rows.find((r) => r.vendorSku)?.vendorSku ?? null,
    description:
      own?.description ?? rows.find((r) => r.normalizedDescription)?.normalizedDescription ?? null,
  };
}

/** One draft RFQ per vendor; a vendor already asked keeps its RFQ (one per vendor and request). */
export async function createQuotes(
  db: Db,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    vendorIds: readonly string[];
    dueAt?: string | undefined;
    notes?: string | undefined;
    /** P-9: an RFQ PDF goes with the email, so a long list may be left to it. */
    withDocument?: boolean | undefined;
  },
): Promise<{ requestId: string; quotes: CreatedQuote[] }> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    if (!QUOTABLE.includes(r.status)) {
      throw new PurchasingError("status", `a ${r.status} request takes no more quotes`);
    }
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    if (lines.length === 0) {
      throw new PurchasingError("invalid", "the request has no lines to ask about");
    }
    // P-9 (0036): a vendor is asked only once every line says how many.
    const noQty = lines.filter((l) => l.row.qty === null).map((l) => l.row.lineNo);
    if (noQty.length > 0) {
      throw new PurchasingError(
        "invalid",
        `line ${noQty.join(", ")} has no quantity yet; set it before asking for quotes`,
      );
    }
    const vendorIds = [...new Set(input.vendorIds)];
    const vendors = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.tenantId, ctx.tenantId), inArray(vendor.id, vendorIds)));
    const unknown = vendorIds.filter((id) => !vendors.some((v) => v.id === id));
    if (unknown.length > 0) {
      throw new PurchasingError("not_found", `vendor ${unknown.join(", ")} not found`);
    }
    const quotes: CreatedQuote[] = [];
    // P-9: the words of each RFQ email, and who it goes to.
    const [client] = await tx
      .select({ name: tenant.name })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId))
      .limit(1);
    const contacts = await vendorContacts(tx, ctx.tenantId, vendorIds);
    for (const v of [...vendors].sort((a, b) => a.name.localeCompare(b.name))) {
      const [made] = await tx
        .insert(quoteRequest)
        .values({
          tenantId: ctx.tenantId,
          purchaseRequestId: r.id,
          vendorId: v.id,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          notes: input.notes ?? null,
          runId: ctx.runId,
          agentVersionId: ctx.agentVersionId,
        })
        .onConflictDoNothing()
        .returning();
      const q =
        made ??
        (
          await tx
            .select()
            .from(quoteRequest)
            .where(
              and(
                eq(quoteRequest.tenantId, ctx.tenantId),
                eq(quoteRequest.purchaseRequestId, r.id),
                eq(quoteRequest.vendorId, v.id),
              ),
            )
            .limit(1)
        )[0];
      if (!q) throw new Error("quote_request vanished after a conflicting insert");
      const rfq: RfqLine[] = [];
      for (const { row, item } of lines) {
        const alias = item
          ? await vendorAliases(tx, ctx.tenantId, v.id, item.id)
          : { sku: null, description: null };
        rfq.push({
          requestLineId: row.id,
          lineNo: row.lineNo,
          description: row.description,
          qty: row.qty as string,
          unit: row.unit,
          catalogItemName: item?.canonicalName ?? null,
          vendorDescription: alias.description,
          vendorSku: alias.sku,
        });
      }
      const who = contacts.find((c) => c.vendorId === v.id);
      const clientName = client?.name ?? "We";
      quotes.push({
        ...quoteView(q, v.name),
        created: made !== undefined,
        lines: rfq,
        contactId: who?.contactId ?? null,
        contactName: who?.contactName ?? null,
        subject: rfqSubject(clientName, rfq.length),
        rfqText: rfqText({
          clientName,
          vendorName: v.name,
          contactName: who?.contactName ?? null,
          neededBy: r.neededBy,
          fulfillment: r.fulfillment,
          deliverTo: r.deliverTo,
          replyBy: q.dueAt ? q.dueAt.toISOString().slice(0, 10) : null,
          lines: rfq,
          withDocument: input.withDocument === true,
        }),
      });
    }
    return { requestId: r.id, quotes };
  });
}

// ── Sent ─────────────────────────────────────────────────────────────────────────────────────────

/** A draft RFQ went out: it is `sent`, and its request is out for quotes. */
export async function markSent(
  db: Db,
  ctx: PurchasingContext,
  input: {
    quoteRequestId: string;
    sentVia: QuoteChannel;
    sentRef?: string | undefined;
    sentAt?: string | undefined;
    dueAt?: string | undefined;
  },
): Promise<{ quote: QuoteView; requestStatus: RequestStatus }> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const q = await quoteRow(tx, ctx.tenantId, input.quoteRequestId);
    const r = await requestRow(tx, ctx.tenantId, q.purchaseRequestId);
    if (!QUOTABLE.includes(r.status)) {
      throw new PurchasingError("status", `the request is ${r.status}`);
    }
    if (q.status !== "draft" && q.status !== "sent") {
      throw new PurchasingError("status", `the quote is already ${q.status}`);
    }
    const now = new Date();
    if (q.status === "draft") {
      await tx
        .update(quoteRequest)
        .set({
          status: "sent",
          sentVia: input.sentVia,
          sentRef: input.sentRef ?? null,
          sentAt: input.sentAt ? new Date(input.sentAt) : now,
          ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
          updatedAt: now,
        })
        .where(and(eq(quoteRequest.tenantId, ctx.tenantId), eq(quoteRequest.id, q.id)));
    }
    // DECISION: a request is `quoting` once its first RFQ is sent (a draft asks nobody yet).
    let requestStatus = r.status;
    if (r.status === "open") {
      requestStatus = "quoting";
      await tx
        .update(purchaseRequest)
        .set({ status: "quoting", updatedAt: now })
        .where(and(eq(purchaseRequest.tenantId, ctx.tenantId), eq(purchaseRequest.id, r.id)));
    }
    const fresh = await quoteRow(tx, ctx.tenantId, q.id);
    return {
      quote: quoteView(fresh, await vendorName(tx, ctx.tenantId, q.vendorId)),
      requestStatus,
    };
  });
}

// ── P-9: sent, from the reach-out's outcome, and expired (docs/plan.md §1.71) ────────────────

/** What a reach-out step answered (`comms.reach-out`'s output), as mark-sent reads it. */
export interface ReachOutOutcome {
  outcome: string;
  channel: string | null;
  reachOutId: string | null;
  attempts: number;
  reason?: string | null | undefined;
  testRun?: boolean | undefined;
  reply?:
    | {
        text?: string | undefined;
        rawRecordId?: string | null | undefined;
        documents?: readonly string[] | undefined;
        at?: string | undefined;
      }
    | null
    | undefined;
}

const VIA: Record<string, QuoteChannel> = {
  email: "email",
  sms: "sms",
  whatsapp: "whatsapp",
  voice: "phone",
};

/**
 * Moves a request on once no RFQ is waiting: `quoted` when a quote is in and no RFQ sent is still
 * open (drafts never sent don't hold it back). Answers the request's status.
 */
export async function settleRequest(
  tx: Tx,
  tenantId: string,
  requestId: string,
  now: Date,
): Promise<RequestStatus> {
  const r = await requestRow(tx, tenantId, requestId);
  const all = await tx
    .select({ status: quoteRequest.status })
    .from(quoteRequest)
    .where(and(eq(quoteRequest.tenantId, tenantId), eq(quoteRequest.purchaseRequestId, r.id)));
  if (
    (r.status === "open" || r.status === "quoting") &&
    all.some((x) => x.status === "received") &&
    !all.some((x) => x.status === "sent")
  ) {
    await tx
      .update(purchaseRequest)
      .set({ status: "quoted", updatedAt: now })
      .where(and(eq(purchaseRequest.tenantId, tenantId), eq(purchaseRequest.id, r.id)));
    return "quoted";
  }
  return r.status;
}

export interface SentFromReach {
  quote: QuoteView;
  requestStatus: RequestStatus;
  /** Something went out (an attempt was made). */
  sent: boolean;
  /** The vendor answered: read and record its reply next. */
  replied: boolean;
  /** No answer came (or the vendor can't be reached any more): the RFQ is expired. */
  expired: boolean;
  reason: string | null;
  /** The reply, as data for the reading skill: its words, its record and its first document. */
  reply: {
    text: string;
    rawRecordId: string | null;
    documentId: string | null;
    documents: string[];
  } | null;
}

/**
 * Records how an RFQ went out from its reach-out step's outcome: sent when an attempt was made
 * (with the reach-out tied to the RFQ), then expired when no reply came; a reach-out that sent
 * nothing (refused, declined, opted out before sending, a test run) leaves the RFQ a draft.
 */
// DECISION: an RFQ that went out and got no reply by the reach-out's timeout is `expired` at once,
// and the request moves on to `quoted` when the others are in; one that never went out stays a
// draft, with the reason, so asking again later is still possible.
export async function sentFromReachOut(
  db: Db,
  ctx: PurchasingContext,
  input: { quoteRequestId: string; reachOut: ReachOutOutcome; dueAt?: string | undefined },
): Promise<SentFromReach> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const q = await quoteRow(tx, ctx.tenantId, input.quoteRequestId);
    const r = await requestRow(tx, ctx.tenantId, q.purchaseRequestId);
    const name = await vendorName(tx, ctx.tenantId, q.vendorId);
    const ro = input.reachOut;
    const now = new Date();
    const went = ro.attempts > 0 && ro.reachOutId !== null && ro.testRun !== true;
    let row: typeof reachOut.$inferSelect | undefined;
    if (went) {
      [row] = await tx
        .select()
        .from(reachOut)
        .where(and(eq(reachOut.tenantId, ctx.tenantId), eq(reachOut.id, ro.reachOutId as string)))
        .limit(1);
      if (!row) throw new PurchasingError("not_found", `reach-out ${ro.reachOutId} not found`);
    }
    const replied = went && ro.outcome === "replied";
    const reason = went
      ? replied
        ? null
        : (ro.reason ?? (ro.outcome === "no_reply" ? "no reply in time" : ro.outcome))
      : (ro.reason ?? "nothing was sent");
    if (went && (q.status === "draft" || q.status === "sent")) {
      if (!QUOTABLE.includes(r.status)) {
        throw new PurchasingError("status", `the request is ${r.status}`);
      }
      const attempts = (row?.attempts ?? []) as { at?: string }[];
      const firstAt = attempts.find((a) => typeof a.at === "string")?.at;
      await tx
        .update(quoteRequest)
        .set({
          status: replied ? "sent" : "expired",
          sentVia: VIA[ro.channel ?? ""] ?? "other",
          sentRef: ro.reachOutId,
          reachOutId: ro.reachOutId,
          sentAt: q.sentAt ?? (firstAt ? new Date(firstAt) : (row?.createdAt ?? now)),
          ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
          ...(replied ? {} : { notes: reason }),
          updatedAt: now,
        })
        .where(and(eq(quoteRequest.tenantId, ctx.tenantId), eq(quoteRequest.id, q.id)));
      if (r.status === "open") {
        await tx
          .update(purchaseRequest)
          .set({ status: "quoting", updatedAt: now })
          .where(and(eq(purchaseRequest.tenantId, ctx.tenantId), eq(purchaseRequest.id, r.id)));
      }
    }
    const requestStatus = await settleRequest(tx, ctx.tenantId, r.id, now);
    const fresh = await quoteRow(tx, ctx.tenantId, q.id);
    const documents = [...(ro.reply?.documents ?? [])];
    return {
      quote: quoteView(fresh, name),
      requestStatus,
      sent: went,
      replied,
      expired: fresh.status === "expired",
      reason,
      reply:
        replied && ro.reply
          ? {
              text: ro.reply.text ?? "",
              rawRecordId: ro.reply.rawRecordId ?? null,
              documentId: documents[0] ?? null,
              documents,
            }
          : null,
    };
  });
}

/**
 * Expires a request's RFQs still waiting on an answer (sent, no quote): those past their due time,
 * or all of them with `all`. Then the request moves on.
 */
export async function expireQuotes(
  db: Db,
  ctx: PurchasingContext,
  input: { requestId: string; all?: boolean | undefined; asOf?: string | undefined },
): Promise<{ expired: QuoteView[]; requestStatus: RequestStatus }> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    const asOf = input.asOf ? new Date(input.asOf) : new Date();
    const waiting = await tx
      .select({ q: quoteRequest, vendorName: vendor.name })
      .from(quoteRequest)
      .innerJoin(vendor, eq(vendor.id, quoteRequest.vendorId))
      .where(
        and(
          eq(quoteRequest.tenantId, ctx.tenantId),
          eq(quoteRequest.purchaseRequestId, r.id),
          eq(quoteRequest.status, "sent"),
        ),
      )
      .orderBy(asc(vendor.name));
    const due = waiting.filter(
      ({ q }) => input.all === true || (q.dueAt !== null && q.dueAt.getTime() <= asOf.getTime()),
    );
    const now = new Date();
    for (const { q } of due) {
      await tx
        .update(quoteRequest)
        .set({ status: "expired", notes: q.notes ?? "no reply in time", updatedAt: now })
        .where(and(eq(quoteRequest.tenantId, ctx.tenantId), eq(quoteRequest.id, q.id)));
    }
    const requestStatus = await settleRequest(tx, ctx.tenantId, r.id, now);
    const expired = [];
    for (const { q, vendorName: n } of due) {
      expired.push(quoteView(await quoteRow(tx, ctx.tenantId, q.id), n));
    }
    return { expired, requestStatus };
  });
}

// ── Get ──────────────────────────────────────────────────────────────────────────────────────────

export async function getQuote(db: Db, ctx: PurchasingContext, quoteRequestId: string) {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const q = await quoteRow(tx, ctx.tenantId, quoteRequestId);
    const lines = await requestLines(tx, ctx.tenantId, q.purchaseRequestId);
    const recorded = await quoteLines(tx, ctx.tenantId, [q.id]);
    return {
      quote: quoteView(q, await vendorName(tx, ctx.tenantId, q.vendorId)),
      requestLines: lines.map(({ row, item }) => ({
        id: row.id,
        lineNo: row.lineNo,
        description: row.description,
        qty: row.qty,
        unit: row.unit,
        catalogItemId: item?.id ?? null,
        catalogItemName: item?.canonicalName ?? null,
        standardUom: item?.standardUom ?? null,
      })),
      lines: recorded.map(quoteLineView),
    };
  });
}

// ── Record ───────────────────────────────────────────────────────────────────────────────────────

export interface QuotedLineInput {
  requestLineId: string;
  description?: string | undefined;
  qty?: string | undefined;
  unit?: string | undefined;
  unitPrice?: string | undefined;
  leadTimeDays?: number | undefined;
  available?: boolean | undefined;
  notes?: string | undefined;
}

export interface RecordQuoteInput {
  quoteRequestId: string;
  declined?: boolean | undefined;
  currency?: string | undefined;
  receivedAt?: string | undefined;
  answerRawRecordId?: string | undefined;
  answerDocumentId?: string | undefined;
  notes?: string | undefined;
  lines: readonly QuotedLineInput[];
}

export interface RecordedLine extends QuoteLineView {
  /** How the standard-unit price was found, or why there is none. */
  conversion: string | null;
}

/**
 * A quoted price in the item's standard unit. DECISION: a quoted line without a unit or a
 * quantity is for the unit and quantity asked.
 */
export function standardPrice(
  item: CatalogItemRow | null,
  line: { unit: string | null; unitPrice: string | null; description: string | null },
  asked: { description: string },
): { unitPriceStd: string | null; standardUom: string | null; conversion: string | null } {
  if (!item)
    return { unitPriceStd: null, standardUom: null, conversion: "not matched to a catalog item" };
  if (line.unitPrice === null) return { unitPriceStd: null, standardUom: null, conversion: null };
  const attributes = {
    ...(item.attributes as Record<string, string>),
    ...parseLine(asked.description).attributes,
    ...(line.description ? parseLine(line.description).attributes : {}),
  };
  const conv = convert(line.unit, item.standardUom, attributes);
  if (!conv.ok) return { unitPriceStd: null, standardUom: null, conversion: conv.reason };
  return {
    unitPriceStd: toNumeric(dec(line.unitPrice).dividedBy(conv.factor)),
    standardUom: item.standardUom,
    conversion: conv.rule,
  };
}

async function checkAnswer(tx: Tx, tenantId: string, input: RecordQuoteInput) {
  if (input.answerRawRecordId) {
    const [row] = await tx
      .select({ id: rawRecord.id })
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, tenantId), eq(rawRecord.id, input.answerRawRecordId)))
      .limit(1);
    if (!row)
      throw new PurchasingError("not_found", `raw record ${input.answerRawRecordId} not found`);
  }
  if (input.answerDocumentId) {
    const [row] = await tx
      .select({ id: document.id })
      .from(document)
      .where(and(eq(document.tenantId, tenantId), eq(document.id, input.answerDocumentId)))
      .limit(1);
    if (!row)
      throw new PurchasingError("not_found", `document ${input.answerDocumentId} not found`);
  }
}

/** Checks a vendor's lines against the request's lines; answers the problems found. */
export function quotedLineProblems(
  lines: readonly QuotedLineInput[],
  requestLineIds: ReadonlySet<string>,
  declined: boolean,
): string[] {
  const problems: string[] = [];
  if (declined && lines.length > 0) problems.push("a declined quote has no lines");
  if (!declined && lines.length === 0) problems.push("a quote needs at least one line");
  const seen = new Set<string>();
  for (const l of lines) {
    if (!requestLineIds.has(l.requestLineId)) {
      problems.push(`line ${l.requestLineId} is not on this request`);
    }
    if (seen.has(l.requestLineId)) problems.push(`line ${l.requestLineId} is quoted twice`);
    seen.add(l.requestLineId);
    if ((l.available ?? true) && l.unitPrice === undefined) {
      problems.push(`line ${l.requestLineId} is available but has no unit price`);
    }
  }
  return problems;
}

/**
 * Records a vendor's answer: its lines (validated against the request's), the answer's message
 * or document, and the status `received` (or `declined`). The request is `quoted` once no RFQ is
 * still waiting on an answer. An answer already recorded is given back unchanged.
 */
export async function recordQuote(
  db: Db,
  ctx: PurchasingContext,
  input: RecordQuoteInput,
): Promise<{
  quote: QuoteView;
  lines: RecordedLine[];
  requestStatus: RequestStatus;
  alreadyRecorded: boolean;
}> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const q = await quoteRow(tx, ctx.tenantId, input.quoteRequestId);
    const name = await vendorName(tx, ctx.tenantId, q.vendorId);
    const r = await requestRow(tx, ctx.tenantId, q.purchaseRequestId);
    // DECISION: an answer already recorded is kept; a revised one is a new request for quotes.
    // A retried step gets the first answer back, flagged.
    if (q.status === "received") {
      const existing = await quoteLines(tx, ctx.tenantId, [q.id]);
      return {
        quote: quoteView(q, name),
        lines: existing.map((l) => ({ ...quoteLineView(l), conversion: null })),
        requestStatus: r.status,
        alreadyRecorded: true,
      };
    }
    if (!QUOTABLE.includes(r.status)) {
      throw new PurchasingError("status", `the request is ${r.status}`);
    }
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    const byId = new Map(lines.map((l) => [l.row.id, l]));
    const declined = input.declined === true;
    const problems = quotedLineProblems(input.lines, new Set(byId.keys()), declined);
    if (problems.length > 0) throw new PurchasingError("invalid", problems.join("; "));
    await checkAnswer(tx, ctx.tenantId, input);
    const currency = input.currency ?? q.currency;
    const recorded: RecordedLine[] = [];
    for (const l of input.lines) {
      const asked = byId.get(l.requestLineId) as {
        row: RequestLineRow;
        item: CatalogItemRow | null;
      };
      const unit = l.unit ?? asked.row.unit;
      const unitPrice = l.unitPrice ?? null;
      const std = standardPrice(
        asked.item,
        { unit, unitPrice, description: l.description ?? null },
        asked.row,
      );
      const values = {
        tenantId: ctx.tenantId,
        quoteRequestId: q.id,
        purchaseRequestLineId: l.requestLineId,
        catalogItemId: asked.item?.id ?? null,
        description: l.description ?? null,
        qty: l.qty ?? asked.row.qty,
        unit,
        unitPrice,
        currency,
        unitPriceStd: std.unitPriceStd,
        standardUom: std.standardUom as QuoteLineRow["standardUom"],
        leadTimeDays: l.leadTimeDays ?? null,
        available: l.available ?? true,
        notes: l.notes ?? null,
      };
      const [row] = await tx
        .insert(quoteLine)
        .values(values)
        .onConflictDoUpdate({
          target: [quoteLine.quoteRequestId, quoteLine.purchaseRequestLineId],
          set: values,
        })
        .returning();
      if (!row) throw new Error("quote_line insert returned nothing");
      recorded.push({ ...quoteLineView(row), conversion: std.conversion });
    }
    const now = new Date();
    await tx
      .update(quoteRequest)
      .set({
        status: declined ? "declined" : "received",
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : now,
        currency,
        answerRawRecordId: input.answerRawRecordId ?? q.answerRawRecordId,
        answerDocumentId: input.answerDocumentId ?? q.answerDocumentId,
        notes: input.notes ?? q.notes,
        updatedAt: now,
      })
      .where(and(eq(quoteRequest.tenantId, ctx.tenantId), eq(quoteRequest.id, q.id)));
    // DECISION: a request is `quoted` once at least one quote is in and no RFQ sent is still
    // waiting (drafts never sent don't hold it back). P-9: shared with expiring (settleRequest).
    const requestStatus = await settleRequest(tx, ctx.tenantId, r.id, now);
    const fresh = await quoteRow(tx, ctx.tenantId, q.id);
    return {
      quote: quoteView(fresh, name),
      lines: recorded,
      requestStatus,
      alreadyRecorded: false,
    };
  });
}
