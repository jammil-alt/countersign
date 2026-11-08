// The Purchasing area's tools (docs/plan.md §1.67): purchase requests, the vendors that sold an
// item, what the client buys most, requests for quotes and their comparison, a purchase order
// PDF, and prices from QuickBooks bills. Each is `none` (reads) or `internal` (the area's own
// records, logged with the step and attributed to the agent version and run): none writes to a
// client's tool, so none needs approval. Inputs and outputs are Zod (invariant 5); outputs carry
// `sources` (invariant 10). Vendors' words reach these tools as data and stay data (invariant 9).

import { DECIMAL_RE, dec, toNumeric } from "@countersign/core";
import { withTenant } from "@countersign/db";
import { z } from "zod";
import { daysBefore } from "../pricing/rules";
import {
  CATEGORIES,
  FULFILLMENTS,
  QUOTE_CHANNELS,
  REQUEST_CHANNELS,
  REQUEST_STATUSES,
} from "../schema";
import { defineTool, type PackTool, type PackToolContext } from "../tools";
import { backfillFromBills } from "./backfill";
import { compareQuotes, SPLIT_MIN_SAVING_PCT } from "./compare";
import { frequentItems, vendorsForItems } from "./history";
import { matchText } from "./match-text";
import { purchaseOrderDocument } from "./po";
import { createQuotes, getQuote, markSent, recordQuote } from "./quotes";
import {
  addLines,
  createRequest,
  getRequest,
  listRequests,
  matchRequestLines,
  type PurchasingContext,
  type RequestView,
  requestSources,
  updateRequest,
} from "./requests";

const today = () => new Date().toISOString().slice(0, 10);

const purchasing = (ctx: PackToolContext): PurchasingContext => ({
  tenantId: ctx.tenantId,
  agentVersionId: ctx.agentVersionId,
  runId: ctx.runId,
  testRun: ctx.mode === "test",
});

// ── Shapes ───────────────────────────────────────────────────────────────────────────────────────

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date, yyyy-mm-dd");
const Moment = z.iso.datetime({ offset: true });
const Text = (max: number) => z.string().trim().min(1).max(max);

/**
 * A quantity or price: a decimal string, or a JSON number read as its shortest decimal text (a
 * model often writes numbers); at most 4 places, never computed on as a float (invariant 6).
 */
// DECISION: numbers are accepted and turned into decimal text at once, as the QuickBooks mapper
// reads QuickBooks' amounts; anything with more than 4 places is refused, not rounded.
const Decimal = z
  .union([z.string().trim(), z.number().finite()])
  .transform((v) => (typeof v === "number" ? String(v) : v))
  .refine((v) => DECIMAL_RE.test(v), "a decimal with at most 4 places, e.g. 12.5")
  .transform((v) => toNumeric(v));
const Positive = Decimal.refine((v) => dec(v).greaterThan(0), "more than 0");
const NonNegative = Decimal.refine((v) => !dec(v).isNegative(), "0 or more");

const Candidate = z.object({
  catalogItemId: z.string(),
  name: z.string(),
  standardUom: z.string(),
  confidence: z.number(),
  hinge: z.string().nullable(),
});

// Optional fields also take null, so a task skill's output (which says null for "not stated")
// can be passed straight in.
const LineIn = z.object({
  description: Text(500),
  qty: Positive,
  unit: Text(40).nullish(),
  notes: Text(1000).nullish(),
});

const LineOut = z.object({
  id: z.string(),
  lineNo: z.number(),
  description: z.string(),
  // P-9 (0036): null while nobody has said how many.
  qty: z.string().nullable(),
  unit: z.string().nullable(),
  notes: z.string().nullable(),
  catalogItemId: z.string().nullable(),
  catalogItemName: z.string().nullable(),
  standardUom: z.string().nullable(),
  matchMethod: z.string().nullable(),
  matchConfidence: z.number().nullable(),
  candidates: z.array(Candidate),
});

const QuoteSummary = z.object({
  id: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  status: z.string(),
  sentAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
});

const RequestOut = z.object({
  id: z.string(),
  status: z.enum(REQUEST_STATUSES),
  channel: z.enum(REQUEST_CHANNELS),
  requestedByContactId: z.string().nullable(),
  requestedByUserId: z.string().nullable(),
  rawRecordId: z.string().nullable(),
  neededBy: z.string().nullable(),
  fulfillment: z.enum(FULFILLMENTS).nullable(),
  deliverTo: z.string().nullable(),
  notes: z.string().nullable(),
  orderConnector: z.string().nullable(),
  orderExternalId: z.string().nullable(),
  orderedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lines: z.array(LineOut),
  quotes: z.array(QuoteSummary),
});

const withRequest = (request: RequestView) => ({
  request,
  // The matched lines' items, for the next step (e.g. the vendors that sold them).
  catalogItemIds: [
    ...new Set(request.lines.flatMap((l) => (l.catalogItemId ? [l.catalogItemId] : []))),
  ],
  unmatched: request.lines.filter((l) => !l.catalogItemId).length,
  sources: requestSources(request),
});
const RequestResult = z.object({
  request: RequestOut,
  catalogItemIds: z.array(z.string()),
  unmatched: z.number(),
  sources: z.array(z.string()),
});

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

export const requestCreate = defineTool({
  id: "materials.request.create",
  description:
    "Opens a purchase request: who asked, the channel it came in on, the message it came from, when it is needed, delivery or pickup, and its lines. Each line is matched to the client's catalog when the rules are sure; other lines come back with their candidates.",
  sideEffect: "internal",
  summary: "Opened a request for {{request.lines.length}} items",
  input: z
    .object({
      channel: z.enum(REQUEST_CHANNELS),
      requestedByContactId: z.uuid().optional(),
      requestedByUserId: z.uuid().optional(),
      rawRecordId: z.uuid().optional(),
      neededBy: Day.optional(),
      fulfillment: z.enum(FULFILLMENTS).optional(),
      deliverTo: Text(500).optional(),
      notes: Text(2000).optional(),
      lines: z.array(LineIn).max(50),
    })
    .refine((v) => !(v.requestedByContactId && v.requestedByUserId), {
      message: "a request is asked by a contact or a user, not both",
    }),
  output: RequestResult,
  async run(input, ctx) {
    return withRequest(await createRequest(ctx.db, purchasing(ctx), input));
  },
});

export const requestGet = defineTool({
  id: "materials.request.get",
  description:
    "A purchase request with its lines (and the catalog items they matched) and its requests for quotes.",
  sideEffect: "none",
  input: z.object({ requestId: z.uuid() }),
  output: RequestResult,
  async run(input, ctx) {
    return withRequest(await getRequest(ctx.db, purchasing(ctx), input.requestId));
  },
});

export const requestList = defineTool({
  id: "materials.request.list",
  description:
    "The client's purchase requests, newest first, optionally only some statuses: lines, matched lines, quotes and quotes received for each.",
  sideEffect: "none",
  input: z.object({
    statuses: z.array(z.enum(REQUEST_STATUSES)).max(6).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({
    requests: z.array(
      z.object({
        id: z.string(),
        status: z.enum(REQUEST_STATUSES),
        channel: z.enum(REQUEST_CHANNELS),
        neededBy: z.string().nullable(),
        createdAt: z.string(),
        lines: z.number(),
        matchedLines: z.number(),
        quotes: z.number(),
        quotesReceived: z.number(),
        orderExternalId: z.string().nullable(),
      }),
    ),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const requests = await listRequests(ctx.db, purchasing(ctx), input);
    return { requests, sources: requests.map((r) => r.id) };
  },
});

export const requestUpdate = defineTool({
  id: "materials.request.update",
  description:
    "Changes a purchase request's status or fields. The status only moves forward (open, quoting, quoted, ordered, closed); a request can be cancelled any time before it is ordered. Passing the order's reference (e.g. the QuickBooks purchase order id) marks it ordered.",
  sideEffect: "internal",
  verb: "update",
  summary: "Updated the request: {{changed}}",
  input: z.object({
    requestId: z.uuid(),
    status: z.enum(REQUEST_STATUSES).optional(),
    neededBy: Day.nullable().optional(),
    fulfillment: z.enum(FULFILLMENTS).nullable().optional(),
    deliverTo: Text(500).nullable().optional(),
    notes: Text(2000).nullable().optional(),
    order: z.object({ connector: Text(40), externalId: Text(200) }).optional(),
  }),
  output: RequestResult.extend({ changed: z.array(z.string()) }),
  async run(input, ctx) {
    const r = await updateRequest(ctx.db, purchasing(ctx), input);
    return { ...withRequest(r.request), changed: r.changed };
  },
});

export const requestAddLines = defineTool({
  id: "materials.request.add-lines",
  description:
    "Adds lines to a purchase request that is open or out for quotes, matching each to the catalog when the rules are sure.",
  sideEffect: "internal",
  summary: "Added {{added}} lines to the request",
  input: z.object({ requestId: z.uuid(), lines: z.array(LineIn).min(1).max(50) }),
  output: RequestResult.extend({ added: z.number() }),
  async run(input, ctx) {
    const request = await addLines(ctx.db, purchasing(ctx), input);
    return { ...withRequest(request), added: input.lines.length };
  },
});

export const requestMatchLines = defineTool({
  id: "materials.request.match-lines",
  description:
    "Matches a purchase request's unmatched lines to the catalog again (deterministic: the vendors' names for items, then the attribute rules). Lines it isn't sure of come back with candidates. `choices` records what a person said a line is; only pass a person's answer, never a guess.",
  sideEffect: "internal",
  summary: "{{matched}} of {{request.lines.length}} lines matched; {{unsure}} to check",
  input: z.object({
    requestId: z.uuid(),
    choices: z
      .array(z.object({ lineId: z.uuid(), catalogItemId: z.uuid() }))
      .max(50)
      .optional(),
  }),
  output: RequestResult.extend({ matched: z.number(), unsure: z.number(), chosen: z.number() }),
  async run(input, ctx) {
    const r = await matchRequestLines(ctx.db, purchasing(ctx), input);
    return { ...withRequest(r.request), matched: r.matched, unsure: r.unsure, chosen: r.chosen };
  },
});

export const catalogMatchText = defineTool({
  id: "materials.catalog.match-text",
  description:
    "Matches descriptions of materials (as someone asked for them) to the client's catalog, deterministically: the vendors' names for items, then the attribute rules. Unsure descriptions come back with candidates. Writes nothing.",
  sideEffect: "none",
  input: z.object({
    descriptions: z.array(Text(500)).min(1).max(50),
    vendorId: z.uuid().optional(),
  }),
  output: z.object({
    lines: z.array(
      z.object({
        description: z.string(),
        decision: z.enum(["matched", "unsure"]),
        catalogItemId: z.string().nullable(),
        catalogItemName: z.string().nullable(),
        standardUom: z.string().nullable(),
        method: z.enum(["alias", "rules"]).nullable(),
        confidence: z.number(),
        candidates: z.array(Candidate),
      }),
    ),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const lines = await withTenant(ctx.db, ctx.tenantId, async (tx) => {
      const out = [];
      for (const description of input.descriptions) {
        const m = await matchText(tx, ctx.tenantId, { description, vendorId: input.vendorId });
        const matched = m.decision === "matched" && m.item !== null;
        out.push({
          description,
          decision: matched ? ("matched" as const) : ("unsure" as const),
          catalogItemId: matched ? (m.item?.id ?? null) : null,
          catalogItemName: matched ? (m.item?.canonicalName ?? null) : null,
          standardUom: matched ? (m.item?.standardUom ?? null) : null,
          method: matched ? m.method : null,
          confidence: m.confidence,
          candidates: matched ? [] : m.candidates,
        });
      }
      return out;
    });
    return {
      lines,
      sources: [
        ...new Set(
          lines.flatMap((l) =>
            l.catalogItemId ? [l.catalogItemId] : l.candidates.map((c) => c.catalogItemId),
          ),
        ),
      ],
    };
  },
});

// ── History ──────────────────────────────────────────────────────────────────────────────────────

export const vendorsForItemsTool = defineTool({
  id: "materials.vendors-for-items",
  description:
    "For catalog items, the vendors that sold each to the client (from what it paid and the vendors' names for the item): the last price per standard unit, when, how many times, and the records behind each. Cheapest last price first.",
  sideEffect: "none",
  summary: "Found {{vendorIds.length}} vendors for {{items.length}} items",
  input: z.object({
    catalogItemIds: z.array(z.uuid()).min(1).max(50),
    days: z.number().int().min(1).max(1825).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        catalogItemId: z.string(),
        askedId: z.string(),
        name: z.string(),
        standardUom: z.string(),
        vendors: z.array(
          z.object({
            vendorId: z.string(),
            vendorName: z.string(),
            lastPrice: z.string().nullable(),
            lastOn: z.string().nullable(),
            timesBought: z.number(),
            qtyStd: z.string(),
            currency: z.string().nullable(),
            sources: z.array(z.string()),
          }),
        ),
      }),
    ),
    /** Every vendor found, those that sold the most items first. */
    vendorIds: z.array(z.string()),
    missing: z.array(z.string()),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      vendorsForItems(tx, ctx.tenantId, { ...input, today: today() }),
    );
    const counts = new Map<string, number>();
    for (const item of r.items) {
      for (const v of item.vendors) counts.set(v.vendorId, (counts.get(v.vendorId) ?? 0) + 1);
    }
    return {
      ...r,
      vendorIds: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id]) => id),
      sources: [
        ...new Set(
          r.items.flatMap((i) => [i.catalogItemId, ...i.vendors.flatMap((v) => v.sources)]),
        ),
      ],
    };
  },
});

export const frequentItemsTool = defineTool({
  id: "materials.frequent-items",
  description:
    "What the client buys most over a period (default the last 365 days): how many purchases, the quantity in standard units, the spend, and the last vendor and price for each item, with the records behind them.",
  sideEffect: "none",
  summary: "The {{items.length}} items bought most",
  input: z.object({
    from: Day.optional(),
    to: Day.optional(),
    category: z.enum(CATEGORIES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    items: z.array(
      z.object({
        catalogItemId: z.string(),
        name: z.string(),
        category: z.string(),
        standardUom: z.string(),
        purchases: z.number(),
        qtyStd: z.string(),
        spend: z.string(),
        currency: z.string(),
        lastOn: z.string(),
        lastVendorId: z.string(),
        lastVendorName: z.string(),
        lastPrice: z.string(),
        sources: z.array(z.string()),
      }),
    ),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const to = input.to ?? today();
    const from = input.from ?? daysBefore(to, 365);
    if (from > to) throw new Error("`from` is after `to`");
    const items = await withTenant(ctx.db, ctx.tenantId, (tx) =>
      frequentItems(tx, ctx.tenantId, { from, to, limit: input.limit, category: input.category }),
    );
    return { from, to, items, sources: items.flatMap((i) => i.sources) };
  },
});

// ── Quotes ───────────────────────────────────────────────────────────────────────────────────────

const QuoteOut = z.object({
  id: z.string(),
  requestId: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  status: z.string(),
  sentAt: z.string().nullable(),
  sentVia: z.string().nullable(),
  dueAt: z.string().nullable(),
  receivedAt: z.string().nullable(),
  currency: z.string(),
  notes: z.string().nullable(),
});

const QuoteLineOut = z.object({
  id: z.string(),
  requestLineId: z.string(),
  catalogItemId: z.string().nullable(),
  description: z.string().nullable(),
  qty: z.string().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.string().nullable(),
  currency: z.string(),
  unitPriceStd: z.string().nullable(),
  standardUom: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  available: z.boolean(),
  notes: z.string().nullable(),
});

export const quoteCreate = defineTool({
  id: "materials.quote.create",
  description:
    "Creates a draft request for a quote (RFQ) to each vendor for a purchase request, one per vendor (a vendor already asked keeps its RFQ). Answers each RFQ with the lines to ask about, in the vendor's own words where it has them. Sends nothing: a send step does that, then materials.quote.mark-sent.",
  sideEffect: "internal",
  summary: "Drafted {{quotes.length}} requests for quotes",
  input: z.object({
    requestId: z.uuid(),
    vendorIds: z.array(z.uuid()).min(1).max(10),
    dueAt: Moment.optional(),
    notes: Text(2000).optional(),
  }),
  output: z.object({
    requestId: z.string(),
    quotes: z.array(
      QuoteOut.extend({
        created: z.boolean(),
        lines: z.array(
          z.object({
            requestLineId: z.string(),
            lineNo: z.number(),
            description: z.string(),
            qty: z.string(),
            unit: z.string().nullable(),
            catalogItemName: z.string().nullable(),
            vendorDescription: z.string().nullable(),
            vendorSku: z.string().nullable(),
          }),
        ),
      }),
    ),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await createQuotes(ctx.db, purchasing(ctx), input);
    return {
      ...r,
      sources: [
        r.requestId,
        ...r.quotes.flatMap((q) => [q.id, ...q.lines.map((l) => l.requestLineId)]),
      ],
    };
  },
});

export const quoteMarkSent = defineTool({
  id: "materials.quote.mark-sent",
  description:
    "Marks a draft request for a quote as sent: how it went out (email, sms, whatsapp, phone, portal, other), the sent message's id, and when the answer is due. The purchase request is then out for quotes.",
  sideEffect: "internal",
  verb: "update",
  summary: "Sent the request for a quote to {{quote.vendorName}}",
  input: z.object({
    quoteRequestId: z.uuid(),
    sentVia: z.enum(QUOTE_CHANNELS),
    sentRef: Text(500).optional(),
    sentAt: Moment.optional(),
    dueAt: Moment.optional(),
  }),
  output: z.object({
    quote: QuoteOut,
    requestStatus: z.enum(REQUEST_STATUSES),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await markSent(ctx.db, purchasing(ctx), input);
    return { ...r, sources: [r.quote.id, r.quote.requestId] };
  },
});

export const quoteGet = defineTool({
  id: "materials.quote.get",
  description:
    "A request for a quote: its vendor and status, the purchase request's lines it asks about (ids to record the answer against), and the lines recorded so far.",
  sideEffect: "none",
  input: z.object({ quoteRequestId: z.uuid() }),
  output: z.object({
    quote: QuoteOut,
    requestLines: z.array(
      z.object({
        id: z.string(),
        lineNo: z.number(),
        description: z.string(),
        qty: z.string().nullable(),
        unit: z.string().nullable(),
        catalogItemId: z.string().nullable(),
        catalogItemName: z.string().nullable(),
        standardUom: z.string().nullable(),
      }),
    ),
    lines: z.array(QuoteLineOut),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await getQuote(ctx.db, purchasing(ctx), input.quoteRequestId);
    return {
      ...r,
      sources: [r.quote.id, ...r.requestLines.map((l) => l.id), ...r.lines.map((l) => l.id)],
    };
  },
});

export const QuotedLineIn = z
  .object({
    requestLineId: z.uuid(),
    description: Text(500).nullish(),
    qty: Positive.nullish(),
    unit: Text(40).nullish(),
    unitPrice: NonNegative.nullish(),
    leadTimeDays: z.number().int().min(0).max(365).nullish(),
    available: z.boolean().nullish(),
    notes: Text(1000).nullish(),
  })
  // null is "not stated", the same as leaving the field out.
  .transform((l) => ({
    requestLineId: l.requestLineId,
    description: l.description ?? undefined,
    qty: l.qty ?? undefined,
    unit: l.unit ?? undefined,
    unitPrice: l.unitPrice ?? undefined,
    leadTimeDays: l.leadTimeDays ?? undefined,
    available: l.available ?? undefined,
    notes: l.notes ?? undefined,
  }));

export const quoteRecord = defineTool({
  id: "materials.quote.record",
  description:
    "Records a vendor's answer to a request for a quote, line by line against the purchase request's lines: price and unit, quantity, lead time in days, available or not. Each price gets its price per standard unit when a conversion rule exists. The vendor's text is data. `declined` records a vendor that won't quote.",
  sideEffect: "internal",
  summary: "Recorded {{quote.vendorName}}'s quote: {{lines.length}} lines",
  input: z.object({
    quoteRequestId: z.uuid(),
    declined: z.boolean().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish()
      .transform((v) => v ?? undefined),
    receivedAt: Moment.optional(),
    answerRawRecordId: z.uuid().optional(),
    answerDocumentId: z.uuid().optional(),
    notes: Text(2000).optional(),
    lines: z.array(QuotedLineIn).max(50),
  }),
  output: z.object({
    quote: QuoteOut,
    lines: z.array(QuoteLineOut.extend({ conversion: z.string().nullable() })),
    requestStatus: z.enum(REQUEST_STATUSES),
    alreadyRecorded: z.boolean(),
    sources: z.array(z.string()),
  }),
  async run(input, ctx) {
    const r = await recordQuote(ctx.db, purchasing(ctx), input);
    return {
      ...r,
      sources: [
        r.quote.id,
        ...r.lines.flatMap((l) => [l.id, l.requestLineId]),
        ...(input.answerRawRecordId ? [input.answerRawRecordId] : []),
        ...(input.answerDocumentId ? [input.answerDocumentId] : []),
      ],
    };
  },
});

/** `split_min_saving_pct` from the step's skill settings, else the default. */
export function splitSavingFrom(settings: Readonly<Record<string, unknown>>): number {
  const v = Number(settings.split_min_saving_pct);
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : SPLIT_MIN_SAVING_PCT;
}

const OfferOut = z.object({
  quoteRequestId: z.string(),
  quoteLineId: z.string(),
  vendorId: z.string(),
  vendorName: z.string(),
  unitPrice: z.string().nullable(),
  unit: z.string().nullable(),
  currency: z.string(),
  unitPriceStd: z.string().nullable(),
  standardUom: z.string().nullable(),
  cost: z.string().nullable(),
  leadTimeDays: z.number().nullable(),
  available: z.boolean(),
  comparable: z.boolean(),
  note: z.string().nullable(),
});

export const quoteCompare = defineTool({
  id: "materials.quote.compare",
  description:
    "Compares the quotes received for a purchase request, in code: per line the best price per standard unit (never across units without a conversion rule, never across currencies), each vendor's total for the lines as asked, lines missing or unavailable, lead times against the needed-by date, and a suggested vendor or split with its reasons.",
  sideEffect: "none",
  summary: "Compared {{vendors.length}} quotes: {{suggestion.kind}}",
  input: z.object({ requestId: z.uuid(), asOf: Day.optional() }),
  output: z.object({
    requestId: z.string(),
    neededBy: z.string().nullable(),
    asOf: z.string(),
    lines: z.array(
      z.object({
        requestLineId: z.string(),
        lineNo: z.number(),
        description: z.string(),
        qty: z.string(),
        unit: z.string().nullable(),
        catalogItemId: z.string().nullable(),
        standardUom: z.string().nullable(),
        offers: z.array(OfferOut),
        best: z
          .object({
            quoteRequestId: z.string(),
            quoteLineId: z.string(),
            vendorId: z.string(),
            price: z.string(),
            per: z.string(),
            cost: z.string().nullable(),
          })
          .nullable(),
        missing: z.array(z.string()),
        unavailable: z.array(z.string()),
        note: z.string().nullable(),
      }),
    ),
    vendors: z.array(
      z.object({
        quoteRequestId: z.string(),
        vendorId: z.string(),
        vendorName: z.string(),
        total: z.string(),
        currency: z.string().nullable(),
        linesPriced: z.number(),
        linesMissing: z.number(),
        linesUnavailable: z.number(),
        complete: z.boolean(),
        maxLeadTimeDays: z.number().nullable(),
        late: z.boolean(),
      }),
    ),
    suggestion: z.object({
      kind: z.enum(["single", "split", "none"]),
      quoteRequestId: z.string().nullable(),
      vendorId: z.string().nullable(),
      total: z.string().nullable(),
      currency: z.string().nullable(),
      split: z.array(
        z.object({
          quoteRequestId: z.string(),
          vendorId: z.string(),
          requestLineIds: z.array(z.string()),
          total: z.string(),
        }),
      ),
      reasons: z.array(z.string()),
    }),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) =>
    compareQuotes(ctx.db, purchasing(ctx), {
      requestId: input.requestId,
      asOf: input.asOf ?? today(),
      splitMinSavingPct: splitSavingFrom(ctx.settings),
    }),
});

// ── Purchase order and backfill ──────────────────────────────────────────────────────────────────

export const poDocument = defineTool({
  id: "materials.po.document",
  description:
    "Renders a purchase order PDF from a purchase request and the vendor's received quote (the client's name, the vendor, the lines with amounts and total, needed-by, delivery or pickup, a reference) and stores it as the client's document. Answers its document id, for a later step to attach. Sends nothing and writes nothing to a client's tool.",
  sideEffect: "internal",
  summary: "Made purchase order {{reference}} for {{vendorName}}",
  input: z.object({
    requestId: z.uuid(),
    quoteRequestId: z.uuid(),
    reference: Text(40).optional(),
    notes: Text(2000).optional(),
  }),
  output: z.object({
    documentId: z.string(),
    filename: z.string(),
    reference: z.string(),
    vendorId: z.string(),
    vendorName: z.string(),
    currency: z.string(),
    total: z.string(),
    lines: z.number(),
    created: z.boolean(),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) => purchaseOrderDocument(ctx.db, ctx.content, purchasing(ctx), input),
});

export const backfillFromBillsTool = defineTool({
  id: "materials.backfill-from-bills",
  description:
    "Turns the client's synced QuickBooks bills dated `from` to `to` into catalog matches and prices (deterministic matching; unsure lines are counted and listed for review, never guessed). Safe to run again: a bill line is priced once. Reads at most `limit` bills a call; pass `next` back as `after` to continue.",
  sideEffect: "internal",
  summary: "Recorded {{recorded}} prices from {{bills}} bills; {{needsReview}} lines to review",
  input: z
    .object({
      from: Day,
      to: Day,
      limit: z.number().int().min(1).max(500).optional(),
      after: z.string().max(60).optional(),
    })
    .refine((v) => v.from <= v.to, { message: "`from` is after `to`" }),
  output: z.object({
    from: z.string(),
    to: z.string(),
    bills: z.number(),
    lines: z.number(),
    itemLines: z.number(),
    accountLines: z.number(),
    recorded: z.number(),
    alreadyRecorded: z.number(),
    matched: z.number(),
    newItems: z.number(),
    needsReview: z.number(),
    skipped: z.number(),
    review: z.array(
      z.object({
        transactionId: z.string(),
        rawRecordId: z.string(),
        lineId: z.string(),
        description: z.string(),
        candidates: z.array(Candidate),
      }),
    ),
    next: z.string().nullable(),
    sources: z.array(z.string()),
  }),
  run: (input, ctx) => backfillFromBills(ctx.db, purchasing(ctx), input),
});

export const PURCHASING_TOOLS: readonly PackTool[] = [
  requestCreate,
  requestGet,
  requestList,
  requestUpdate,
  requestAddLines,
  requestMatchLines,
  catalogMatchText,
  vendorsForItemsTool,
  frequentItemsTool,
  quoteCreate,
  quoteMarkSent,
  quoteGet,
  quoteRecord,
  quoteCompare,
  poDocument,
  backfillFromBillsTool,
];

/** The task skills' structured outputs, shared with the manifest. */
export const ReadRequestOut = z.object({
  lines: z.array(
    z.object({
      description: z.string(),
      /** A decimal; null when the person didn't say how many (then there is a question). */
      qty: z.string().nullable(),
      unit: z.string().nullable(),
      neededBy: z.string().nullable(),
      notes: z.string().nullable(),
      catalogItemId: z.string().nullable(),
      catalogItemName: z.string().nullable(),
      candidates: z.array(z.object({ catalogItemId: z.string(), name: z.string() })),
    }),
  ),
  neededBy: z.string().nullable(),
  fulfillment: z.enum(FULFILLMENTS).nullable(),
  deliverTo: z.string().nullable(),
  notes: z.string().nullable(),
  /** What to ask the person before ordering (an unclear size, a missing quantity). */
  questions: z.array(z.string()),
  sources: z.array(z.string()),
});

export const ReadQuoteOut = z.object({
  quoteRequestId: z.string(),
  declined: z.boolean(),
  currency: z.string().nullable(),
  lines: z.array(
    z.object({
      requestLineId: z.string(),
      description: z.string().nullable(),
      qty: z.string().nullable(),
      unit: z.string().nullable(),
      unitPrice: z.string().nullable(),
      leadTimeDays: z.number().nullable(),
      available: z.boolean(),
      notes: z.string().nullable(),
    }),
  ),
  /** Lines the vendor quoted that match no line asked, as the vendor wrote them. */
  unmatched: z.array(z.string()),
  notes: z.string().nullable(),
  sources: z.array(z.string()),
});

/** A decimal's text the way the tools read it (for the pack's tests). */
export const readDecimal = (v: string | number) => Decimal.parse(v);
