// P-9: the Purchasing area's two inbox cards and its request page (docs/plan.md §1.71). The line
// review (`materials.request-lines`): a request's lines the rules weren't sure of or that have no
// quantity, each with its candidates and the client's catalog; a person picks the item and sets
// the quantity, line by line. The vendor choice (`materials.vendor-choice`): the quotes compared
// as a table; a person picks one vendor or a split. Both record a person's decision on the request
// (never an agent's), which the run's next steps read. The request page is one row of the
// `requests` report in full. Nothing here names an agent, a prompt or a cost (invariant 11).

import { document, type Tx, withTenant } from "@countersign/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { catalogItem, purchaseRequest, quoteRequest } from "../schema";
import { compareQuotesTx } from "./compare";
import { quoteLines } from "./quotes";
import {
  loadRequest,
  matchRequestLines,
  type PurchasingContext,
  PurchasingError,
  requestRow,
  updateLines,
} from "./requests";

export const REQUEST_LINES_REVIEW = "materials.request-lines";
export const VENDOR_CHOICE_REVIEW = "materials.vendor-choice";

const today = () => new Date().toISOString().slice(0, 10);

/** A person's choice of vendor, kept on the request (`ext.choice`). */
export interface VendorChoice {
  kind: "single" | "split";
  /** The one quote ordered from (single). */
  quoteRequestId: string | null;
  /** Each vendor's share (split). */
  split: { quoteRequestId: string; requestLineIds: string[] }[];
  userId: string;
  at: string;
}

export function choiceOf(ext: unknown): VendorChoice | null {
  const c = (ext as { choice?: unknown } | null)?.choice;
  return c && typeof c === "object" ? (c as VendorChoice) : null;
}

const CATALOG_LIMIT = 300;

async function catalogList(tx: Tx, tenantId: string) {
  return tx
    .select({
      id: catalogItem.id,
      name: catalogItem.canonicalName,
      standardUom: catalogItem.standardUom,
    })
    .from(catalogItem)
    .where(and(eq(catalogItem.tenantId, tenantId), isNull(catalogItem.mergedIntoId)))
    .orderBy(asc(catalogItem.canonicalName))
    .limit(CATALOG_LIMIT);
}

const RequestPayload = z.object({ requestId: z.uuid() });

/** What the line review card shows: the lines still to settle, first; then the rest. */
export async function requestLinesView(tx: Tx, tenantId: string, payload: unknown) {
  const { requestId } = RequestPayload.parse(payload);
  const r = await loadRequest(tx, tenantId, requestId);
  return {
    requestId: r.id,
    status: r.status,
    neededBy: r.neededBy,
    lines: r.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      notes: l.notes,
      catalogItemId: l.catalogItemId,
      catalogItemName: l.catalogItemName,
      matchMethod: l.matchMethod,
      candidates: l.candidates,
      settled: l.catalogItemId !== null && l.qty !== null,
    })),
    catalog: await catalogList(tx, tenantId),
  };
}

const LineDecision = z.strictObject({
  lineId: z.uuid(),
  catalogItemId: z.uuid().optional(),
  qty: z
    .string()
    .trim()
    .regex(/^[0-9]{1,10}(\.[0-9]{1,4})?$/, "a quantity, e.g. 12 or 2.5")
    .refine((v) => Number(v) > 0, "more than 0")
    .optional(),
  unit: z.string().trim().min(1).max(40).optional(),
});

/** A person's answer for one line: the catalog item it is, its quantity, its unit. */
export async function decideRequestLine(
  db: Parameters<typeof matchRequestLines>[0],
  input: {
    tenantId: string;
    userId: string;
    payload: unknown;
    decision: unknown;
    testRun: boolean;
  },
): Promise<void> {
  const { requestId } = RequestPayload.parse(input.payload);
  const d = z
    .object({ action: z.literal("line"), input: LineDecision })
    .parse(input.decision).input;
  if (!d.catalogItemId && d.qty === undefined && d.unit === undefined) {
    throw new PurchasingError("invalid", "say which item it is, how many, or the unit");
  }
  const ctx: PurchasingContext = {
    tenantId: input.tenantId,
    agentVersionId: "",
    userId: input.userId,
    runId: null,
    testRun: input.testRun,
  };
  if (d.qty !== undefined || d.unit !== undefined) {
    await updateLines(db, ctx, {
      requestId,
      lines: [
        { lineId: d.lineId, ...(d.qty ? { qty: d.qty } : {}), ...(d.unit ? { unit: d.unit } : {}) },
      ],
    });
  }
  if (d.catalogItemId) {
    await matchRequestLines(db, ctx, {
      requestId,
      choices: [{ lineId: d.lineId, catalogItemId: d.catalogItemId }],
    });
  }
}

/** What the vendor choice card shows: the comparison as a table, and the choice so far. */
export async function vendorChoiceView(tx: Tx, tenantId: string, payload: unknown) {
  const { requestId } = RequestPayload.parse(payload);
  const r = await requestRow(tx, tenantId, requestId);
  const comparison = await compareQuotesTx(tx, { tenantId }, { requestId, asOf: today() });
  const choice = choiceOf(r.ext);
  return {
    requestId,
    status: r.status,
    comparison,
    choice: choice
      ? {
          kind: choice.kind,
          quoteRequestId: choice.quoteRequestId,
          split: choice.split,
          at: choice.at,
        }
      : null,
  };
}

const ChoiceDecision = z.union([
  z.strictObject({ kind: z.literal("single"), quoteRequestId: z.uuid() }),
  z.strictObject({
    kind: z.literal("split"),
    split: z
      .array(
        z.strictObject({
          quoteRequestId: z.uuid(),
          requestLineIds: z.array(z.uuid()).min(1).max(50),
        }),
      )
      .min(2)
      .max(10),
  }),
]);

// DECISION: a person's vendor choice names received quotes of this request only; a split gives
// each line to at most one vendor. It is kept on the request (`ext.choice`, with who and when), so
// the run reads it (materials.quote.chosen) and the request page shows it; choosing again replaces
// it until the request is ordered.
export async function decideVendorChoice(
  db: Parameters<typeof matchRequestLines>[0],
  input: {
    tenantId: string;
    userId: string;
    payload: unknown;
    decision: unknown;
    testRun: boolean;
  },
): Promise<void> {
  const { requestId } = RequestPayload.parse(input.payload);
  const d = z
    .object({ action: z.literal("choose"), input: ChoiceDecision })
    .parse(input.decision).input;
  await withTenant(db, input.tenantId, async (tx) => {
    const r = await requestRow(tx, input.tenantId, requestId);
    if (r.status !== "quoted" && r.status !== "quoting") {
      throw new PurchasingError("status", `a ${r.status} request takes no choice of vendor`);
    }
    const received = await tx
      .select({ id: quoteRequest.id })
      .from(quoteRequest)
      .where(
        and(
          eq(quoteRequest.tenantId, input.tenantId),
          eq(quoteRequest.purchaseRequestId, r.id),
          eq(quoteRequest.status, "received"),
        ),
      );
    const ok = new Set(received.map((q) => q.id));
    const ids = d.kind === "single" ? [d.quoteRequestId] : d.split.map((s) => s.quoteRequestId);
    for (const id of ids) {
      if (!ok.has(id))
        throw new PurchasingError("invalid", "pick a quote that came in for this request");
    }
    if (d.kind === "split") {
      const seen = new Set<string>();
      for (const s of d.split) {
        for (const l of s.requestLineIds) {
          if (seen.has(l)) throw new PurchasingError("invalid", "a line goes to one vendor");
          seen.add(l);
        }
      }
      if (new Set(ids).size !== ids.length) {
        throw new PurchasingError("invalid", "each vendor once in a split");
      }
    }
    const choice: VendorChoice = {
      kind: d.kind,
      quoteRequestId: d.kind === "single" ? d.quoteRequestId : null,
      split: d.kind === "split" ? d.split : [],
      userId: input.userId,
      at: new Date().toISOString(),
    };
    await tx
      .update(purchaseRequest)
      .set({
        ext: sql`${purchaseRequest.ext} || ${JSON.stringify({ choice })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(eq(purchaseRequest.tenantId, input.tenantId), eq(purchaseRequest.id, r.id)));
  });
}

/** The person's choice, for the run: refused when nobody has chosen yet. */
export async function chosenQuote(tx: Tx, tenantId: string, requestId: string) {
  const r = await requestRow(tx, tenantId, requestId);
  const choice = choiceOf(r.ext);
  if (!choice)
    throw new PurchasingError("invalid", "nobody has picked a vendor for this request yet");
  return choice;
}

/** One purchase request in full, for its page in the portal and the back office. */
export async function requestPage(tx: Tx, tenantId: string, id: string, asOf: string) {
  const [row] = await tx
    .select()
    .from(purchaseRequest)
    .where(
      and(
        eq(purchaseRequest.tenantId, tenantId),
        eq(purchaseRequest.id, id),
        sql`not coalesce((${purchaseRequest.ext} ->> 'testRun')::boolean, false)`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const r = await loadRequest(tx, tenantId, id);
  const recorded = await quoteLines(
    tx,
    tenantId,
    r.quotes.map((q) => q.id),
  );
  const received = r.quotes.some((q) => q.status === "received");
  const comparison = received
    ? await compareQuotesTx(tx, { tenantId }, { requestId: id, asOf })
    : null;
  const docs = await tx
    .select({
      id: document.id,
      filename: document.filename,
      meta: document.meta,
      createdAt: document.receivedAt,
    })
    .from(document)
    .where(
      and(eq(document.tenantId, tenantId), sql`${document.meta} ->> 'purchaseRequestId' = ${id}`),
    )
    .orderBy(asc(document.receivedAt));
  const choice = choiceOf(row.ext);
  return {
    id: r.id,
    status: r.status,
    channel: r.channel,
    neededBy: r.neededBy,
    fulfillment: r.fulfillment,
    deliverTo: r.deliverTo,
    notes: r.notes,
    createdAt: r.createdAt,
    orders: r.orders,
    lines: r.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      catalogItemName: l.catalogItemName,
      matched: l.catalogItemId !== null,
    })),
    quotes: r.quotes.map((q) => ({
      ...q,
      lines: recorded
        .filter((l) => l.quoteRequestId === q.id)
        .map((l) => ({
          requestLineId: l.purchaseRequestLineId,
          unitPrice: l.unitPrice,
          unit: l.unit,
          currency: l.currency,
          leadTimeDays: l.leadTimeDays,
          available: l.available,
        })),
    })),
    comparison,
    choice: choice
      ? {
          kind: choice.kind,
          quoteRequestId: choice.quoteRequestId,
          split: choice.split,
          at: choice.at,
        }
      : null,
    documents: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      kind: ((d.meta as { kind?: unknown } | null)?.kind as string | undefined) ?? "document",
    })),
  };
}
