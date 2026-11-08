// Recording prices (ARCHITECTURE §12.4 `materials.prices.record`): each matched line of a document's
// latest reading becomes one price observation in its catalog item's standard unit. Freight and
// surcharges are not folded into the unit price; the landed unit price (freight and surcharges
// shared out by each line's share of the lines' amount) is kept beside it. A line whose unit has no
// conversion rule to the item's unit is skipped with the reason (invariant 7).

import { dec, toNumeric } from "@countersign/core";
import {
  type Db,
  docExtraction,
  docLine,
  document,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { parseLine } from "../catalog/keys";
import { latestMatch, liveItem } from "../catalog/store";
import { materialsEventRegistry } from "../events";
import { priceObservation } from "../schema";
import type { Observation } from "./rules";
import { convert } from "./uom";

export class PricingError extends Error {
  override name = "PricingError";
  constructor(
    readonly code: "no_extraction" | "no_vendor",
    message: string,
  ) {
    super(message);
  }
}

export interface PricingContext {
  tenantId: string;
  agentVersionId: string;
  /** The run recording, for alerts' `raised_by_run_id`; null outside a run. */
  runId?: string | null | undefined;
  /** Test runs write nothing (no prices, no alerts, no events) and say what they would have. */
  testRun: boolean;
}

/** A document's latest reading, with its vendor and the day its prices are for. */
export interface PricedDocument {
  documentId: string;
  extractionId: string;
  vendorId: string;
  vendorName: string;
  transactionId: string | null;
  observedOn: string;
  currency: string;
  freight: string;
  surcharges: { label: string; amount: string }[];
}

export interface LinePrice {
  docLineId: string;
  lineNo: number;
  description: string;
  catalogItemId: string | null;
  catalogItemName: string | null;
  /** Null when skipped; the observation's id once recorded (a test run's stays null). */
  observationId: string | null;
  unitPriceStd: string | null;
  qtyStd: string | null;
  standardUom: string | null;
  landedUnitPriceStd: string | null;
  /** Why the line has no price (not matched yet, no conversion rule, no quantity). */
  skipped: string | null;
}

const isoDay = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

export async function loadPricedDocument(
  tx: Tx,
  tenantId: string,
  documentId: string,
): Promise<PricedDocument> {
  const [row] = await tx
    .select({
      extractionId: docExtraction.id,
      header: docExtraction.header,
      currency: docExtraction.currency,
      freight: docExtraction.freight,
      surcharges: docExtraction.surcharges,
      transactionId: document.transactionId,
      receivedAt: document.receivedAt,
      vendorId: transaction.vendorId,
      txnDate: transaction.txnDate,
      vendorName: vendor.name,
    })
    .from(docExtraction)
    .innerJoin(document, eq(document.id, docExtraction.documentId))
    .leftJoin(transaction, eq(transaction.id, document.transactionId))
    .leftJoin(vendor, eq(vendor.id, transaction.vendorId))
    .where(and(eq(docExtraction.tenantId, tenantId), eq(docExtraction.documentId, documentId)))
    .orderBy(desc(docExtraction.createdAt), desc(docExtraction.id))
    .limit(1);
  if (!row) {
    throw new PricingError(
      "no_extraction",
      `document ${documentId} has no extraction; read it first`,
    );
  }
  if (!row.vendorId) {
    throw new PricingError(
      "no_vendor",
      "the document isn't linked to a purchase with a vendor yet",
    );
  }
  const header = (row.header ?? {}) as Record<string, unknown>;
  const surcharges = Array.isArray(row.surcharges)
    ? (row.surcharges as { label?: unknown; amount?: unknown }[]).map((s) => ({
        label: String(s.label ?? ""),
        amount: toNumeric(String(s.amount ?? "0")),
      }))
    : [];
  return {
    documentId,
    extractionId: row.extractionId,
    vendorId: row.vendorId,
    vendorName: row.vendorName ?? "the vendor",
    transactionId: row.transactionId,
    // DECISION: a price is for the invoice's date, else the purchase's, else the day it arrived.
    observedOn:
      isoDay(header.invoiceDate) ??
      isoDay(row.txnDate) ??
      row.receivedAt.toISOString().slice(0, 10),
    currency: row.currency ?? "USD",
    freight: toNumeric(row.freight ?? "0"),
    surcharges,
  };
}

interface Draft extends Observation {
  line: LinePrice;
  ext: Record<string, unknown>;
}

/** What recording would write for each line of the document (nothing is written here). */
export async function priceLines(
  tx: Tx,
  tenantId: string,
  doc: PricedDocument,
): Promise<{ drafts: Draft[]; lines: LinePrice[] }> {
  const lines = await tx
    .select()
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), eq(docLine.extractionId, doc.extractionId)))
    .orderBy(asc(docLine.lineNo));
  const extras = doc.surcharges.reduce((s, x) => s.plus(x.amount), dec(doc.freight));
  const linesTotal = lines.reduce((s, l) => s.plus(l.extPrice), dec("0"));
  const drafts: Draft[] = [];
  const out: LinePrice[] = [];
  for (const l of lines) {
    const base: LinePrice = {
      docLineId: l.id,
      lineNo: l.lineNo,
      description: l.rawDescription,
      catalogItemId: null,
      catalogItemName: null,
      observationId: null,
      unitPriceStd: null,
      qtyStd: null,
      standardUom: null,
      landedUnitPriceStd: null,
      skipped: null,
    };
    const m = await latestMatch(tx, tenantId, l.id);
    const item =
      m?.catalogItemId && m.decision !== "unsure"
        ? await liveItem(tx, tenantId, m.catalogItemId)
        : null;
    if (!item) {
      out.push({ ...base, skipped: "not matched to a catalog item yet" });
      continue;
    }
    const withItem = { ...base, catalogItemId: item.id, catalogItemName: item.canonicalName };
    const attributes = {
      ...(item.attributes as Record<string, string>),
      ...parseLine(l.rawDescription).attributes,
    };
    const conv = convert(l.uomRaw, item.standardUom, attributes);
    if (!conv.ok) {
      out.push({ ...withItem, skipped: conv.reason });
      continue;
    }
    const qty = dec(l.qty);
    if (!qty.greaterThan(0)) {
      out.push({ ...withItem, skipped: "no quantity" });
      continue;
    }
    // DECISION: a line with a discount is priced at what was paid (its amount over its quantity);
    // otherwise at its printed unit price.
    const discounted = l.discount !== null && dec(l.discount).greaterThan(0);
    const unitRaw = discounted ? dec(l.extPrice).dividedBy(qty) : dec(l.unitPrice);
    const qtyStd = qty.times(conv.factor);
    const unitStd = unitRaw.dividedBy(conv.factor);
    const share = linesTotal.isZero() ? dec("0") : extras.times(l.extPrice).dividedBy(linesTotal);
    const landed = dec(l.extPrice).plus(share).dividedBy(qtyStd);
    const line: LinePrice = {
      ...withItem,
      unitPriceStd: toNumeric(unitStd),
      qtyStd: toNumeric(qtyStd),
      standardUom: item.standardUom,
      landedUnitPriceStd: toNumeric(landed),
    };
    out.push(line);
    drafts.push({
      id: l.id,
      catalogItemId: item.id,
      vendorId: doc.vendorId,
      observedOn: doc.observedOn,
      unitPriceStd: toNumeric(unitStd),
      qtyStd: toNumeric(qtyStd),
      standardUom: item.standardUom,
      docLineId: l.id,
      line,
      ext: {
        uomRaw: l.uomRaw,
        unitPriceRaw: toNumeric(unitRaw),
        factor: conv.factor.toString(),
        conversion: conv.rule,
        ...(conv.assumed ? { uomAssumed: true } : {}),
        landedUnitPriceStd: toNumeric(landed),
        freightShare: toNumeric(share),
      },
    });
  }
  return { drafts, lines: out };
}

export interface RecordResult {
  documentId: string;
  extractionId: string;
  vendorId: string;
  observedOn: string;
  total: number;
  recorded: number;
  skipped: number;
  lines: LinePrice[];
  sources: string[];
}

/**
 * Records the document's prices: one observation per matched line (recording again adds nothing),
 * `materials.price.observed` for each new one and `materials.price.changed` when the vendor's
 * last price for the item was different. A test run writes nothing.
 */
export async function recordPrices(
  db: Db,
  ctx: PricingContext,
  input: { documentId: string },
): Promise<RecordResult> {
  const registry = materialsEventRegistry();
  return withTenant(db, ctx.tenantId, async (tx) => {
    const doc = await loadPricedDocument(tx, ctx.tenantId, input.documentId);
    const { drafts, lines } = await priceLines(tx, ctx.tenantId, doc);
    if (!ctx.testRun && drafts.length > 0) {
      for (const d of drafts) {
        const [prev] = await tx
          .select()
          .from(priceObservation)
          .where(
            and(
              eq(priceObservation.tenantId, ctx.tenantId),
              eq(priceObservation.catalogItemId, d.catalogItemId),
              eq(priceObservation.vendorId, d.vendorId),
            ),
          )
          .orderBy(desc(priceObservation.observedOn), desc(priceObservation.createdAt))
          .limit(1);
        const [row] = await tx
          .insert(priceObservation)
          .values({
            tenantId: ctx.tenantId,
            catalogItemId: d.catalogItemId,
            vendorId: d.vendorId,
            observedOn: d.observedOn,
            unitPriceStd: d.unitPriceStd,
            qtyStd: d.qtyStd,
            standardUom: d.standardUom,
            currency: doc.currency,
            docLineId: d.docLineId,
            transactionId: doc.transactionId,
            agentVersionId: ctx.agentVersionId,
            ext: d.ext,
          })
          .onConflictDoNothing()
          .returning({ id: priceObservation.id });
        if (!row) continue;
        d.line.observationId = row.id;
        const payload = {
          observationId: row.id,
          catalogItemId: d.catalogItemId,
          vendorId: d.vendorId,
          observedOn: d.observedOn,
          unitPriceStd: d.unitPriceStd,
          standardUom: d.standardUom,
        };
        await emit(
          tx,
          { tenantId: ctx.tenantId, type: "materials.price.observed", subjectId: row.id, payload },
          { registry },
        );
        if (
          prev &&
          prev.standardUom === d.standardUom &&
          !dec(prev.unitPriceStd).equals(d.unitPriceStd)
        ) {
          const before = dec(prev.unitPriceStd);
          await emit(
            tx,
            {
              tenantId: ctx.tenantId,
              type: "materials.price.changed",
              subjectId: row.id,
              payload: {
                ...payload,
                previousObservationId: prev.id,
                previousUnitPriceStd: prev.unitPriceStd,
                changePct: before.isZero()
                  ? null
                  : dec(d.unitPriceStd)
                      .minus(before)
                      .dividedBy(before)
                      .times(100)
                      .toDecimalPlaces(2)
                      .toString(),
              },
            },
            { registry },
          );
        }
      }
      // Lines recorded before (a retried step): answer with their observation ids.
      const missing = drafts.filter((d) => d.line.observationId === null);
      if (missing.length > 0) {
        const existing = await tx
          .select({ id: priceObservation.id, docLineId: priceObservation.docLineId })
          .from(priceObservation)
          .where(
            and(
              eq(priceObservation.tenantId, ctx.tenantId),
              inArray(
                priceObservation.docLineId,
                missing.map((d) => d.docLineId as string),
              ),
            ),
          );
        for (const d of missing) {
          d.line.observationId = existing.find((e) => e.docLineId === d.docLineId)?.id ?? null;
        }
      }
    }
    const priced = lines.filter((l) => l.skipped === null);
    return {
      documentId: doc.documentId,
      extractionId: doc.extractionId,
      vendorId: doc.vendorId,
      observedOn: doc.observedOn,
      total: lines.length,
      recorded: priced.length,
      skipped: lines.length - priced.length,
      lines,
      sources: [
        doc.documentId,
        doc.extractionId,
        ...priced.flatMap((l) => [l.docLineId, ...(l.observationId ? [l.observationId] : [])]),
      ],
    };
  });
}
