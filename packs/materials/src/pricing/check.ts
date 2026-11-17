// The price check (ARCHITECTURE §12.4, skill `materials.price-check`): the six rules over a
// document's prices against the client's history, and (§1.104) the contract rules when its vendor
// has a contract (./contract.ts), and an alert for each that fires, with its
// evidence and dollar impact. One open alert per (kind, item, vendor): a repeat finds the open one
// (the dedupe key's unique index decides when two runs race). `alert.raised` goes out for each new
// alert. A test run evaluates the same rules and writes nothing.

import {
  alert,
  type Db,
  docExtraction,
  document,
  type Tx,
  transaction,
  vendor,
  withTenant,
} from "@countersign/db";
import { emit } from "@countersign/senses";
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { agreedPrices, vendorContracts } from "../contracts/store";
import { materialsEventRegistry } from "../events";
import { PACK_ID } from "../ids";
import { catalogItem, priceObservation } from "../schema";
import { agreedPriceStd, checkContract } from "./contract";
import {
  fromLatestReading,
  loadPricedDocument,
  type PricedDocument,
  type PricingContext,
  priceLines,
} from "./record";
import {
  type AlertDraft,
  checkObservation,
  daysBefore,
  dedupeKey,
  type Names,
  newFees,
  type Observation,
  type PriceSettings,
} from "./rules";

// DECISION: an item's history for the rules is its last 365 days (the outlier rule's reach; the
// others look back 90 days or one month).
const HISTORY_DAYS = 365;

export interface RaisedAlert {
  id: string | null;
  kind: string;
  severity: string;
  title: string;
  body: string;
  catalogItemId: string | null;
  vendorId: string;
  dollarImpact: string | null;
  evidence: string[];
  /** An open alert of this kind for this item and vendor already stood: no new one. */
  deduped: boolean;
}

export interface CheckResult {
  documentId: string;
  checked: number;
  raised: number;
  deduped: number;
  alerts: RaisedAlert[];
  sources: string[];
}

async function observationsOf(
  tx: Tx,
  tenantId: string,
  docLineIds: string[],
): Promise<Observation[]> {
  if (docLineIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(priceObservation)
    .where(
      and(eq(priceObservation.tenantId, tenantId), inArray(priceObservation.docLineId, docLineIds)),
    );
  return rows.map(toObservation);
}

export function toObservation(r: typeof priceObservation.$inferSelect): Observation {
  return {
    id: r.id,
    catalogItemId: r.catalogItemId,
    vendorId: r.vendorId,
    observedOn: r.observedOn,
    unitPriceStd: r.unitPriceStd,
    qtyStd: r.qtyStd,
    standardUom: r.standardUom,
    docLineId: r.docLineId,
    currency: r.currency,
    ...(r.ext?.uomAssumed === true ? { uomAssumed: true } : {}),
  };
}

/** Fee types on the vendor's other invoices, and how many there are. */
async function priorFees(tx: Tx, tenantId: string, vendorId: string, documentId: string) {
  const rows = await tx
    .select({
      documentId: docExtraction.documentId,
      surcharges: docExtraction.surcharges,
      createdAt: docExtraction.createdAt,
    })
    .from(docExtraction)
    .innerJoin(document, eq(document.id, docExtraction.documentId))
    .innerJoin(transaction, eq(transaction.id, document.transactionId))
    .where(
      and(
        eq(docExtraction.tenantId, tenantId),
        eq(transaction.vendorId, vendorId),
        ne(docExtraction.documentId, documentId),
      ),
    )
    .orderBy(desc(docExtraction.createdAt));
  const latest = new Map<string, { label: string }[]>();
  for (const r of rows) if (!latest.has(r.documentId)) latest.set(r.documentId, r.surcharges ?? []);
  return {
    invoices: latest.size,
    types: [...latest.values()].flatMap((s) => s.map((x) => String(x.label ?? ""))),
  };
}

/**
 * §1.104: the contract check of a document's priced lines, when its vendor has a contract (null
 * when it has none): the alerts, and the lines it couldn't compare (the review lists them).
 */
export async function contractCheckFor(
  tx: Tx,
  tenantId: string,
  doc: PricedDocument,
  lines: readonly Observation[],
  vendorItemOf: ReadonlyMap<string | null, string | null>,
  names: (catalogItemId: string) => Names,
): Promise<ReturnType<typeof checkContract> | null> {
  const contracts = await vendorContracts(tx, tenantId, doc.vendorId);
  if (contracts.length === 0) return null;
  const agreed = await agreedPrices(
    tx,
    tenantId,
    contracts.map((c) => c.id),
  );
  return checkContract({
    vendorId: doc.vendorId,
    vendorName: doc.vendorName,
    contracts,
    // DECISION: the line's own vendor item when it is on the contract and its price converts to
    // the line's unit, else one of the item's whose price converts (invariant 7); else one that
    // doesn't, so the line is listed as unchecked rather than as not on the contract.
    agreedFor: (o, c) => {
      const list = agreed.filter(
        (p) => p.contractId === c.id && p.catalogItemId === o.catalogItemId,
      );
      const own = vendorItemOf.get(o.docLineId);
      const converts = (p: (typeof list)[number]) => agreedPriceStd(p, o.standardUom) !== null;
      return (
        list.find((p) => p.vendorItemId === own && converts(p)) ??
        list.find(converts) ??
        list.find((p) => p.vendorItemId === own) ??
        list[0] ??
        null
      );
    },
    hasPrices: (c) => agreed.some((p) => p.contractId === c.id),
    invoice: {
      documentId: doc.documentId,
      extractionId: doc.extractionId,
      invoiceNumber: doc.terms.invoiceNumber,
      invoiceDate: doc.observedOn,
      dueDate: doc.terms.dueDate,
      paymentTerms: doc.terms.paymentTerms,
      freight: doc.freight,
      currency: doc.currency,
    },
    lines,
    names,
  });
}

async function raise(tx: Tx, ctx: PricingContext, draft: AlertDraft): Promise<RaisedAlert> {
  const key = dedupeKey(draft);
  const view = {
    kind: draft.kind,
    severity: draft.severity,
    title: draft.title,
    body: draft.body,
    catalogItemId: draft.catalogItemId,
    vendorId: draft.vendorId,
    dollarImpact: draft.dollarImpact,
    evidence: draft.evidence,
  };
  if (ctx.testRun) return { ...view, id: null, deduped: false };
  const [row] = await tx
    .insert(alert)
    .values({
      tenantId: ctx.tenantId,
      pack: PACK_ID,
      kind: draft.kind,
      subjectType: draft.catalogItemId ? "catalog_item" : "vendor",
      subjectId: draft.catalogItemId ?? draft.vendorId,
      severity: draft.severity,
      title: draft.title,
      body: draft.body,
      evidence: draft.evidence,
      facts: { ...draft.facts, vendorId: draft.vendorId, catalogItemId: draft.catalogItemId },
      dollarImpact: draft.dollarImpact,
      // The currency its dollar impact is in (the invoice's), as its facts say.
      currency: typeof draft.facts.currency === "string" ? draft.facts.currency : "USD",
      dedupeKey: key,
      raisedByRunId: ctx.runId ?? null,
      agentVersionId: ctx.agentVersionId,
    })
    .onConflictDoNothing()
    .returning({ id: alert.id });
  if (row) {
    await emit(
      tx,
      {
        tenantId: ctx.tenantId,
        type: "alert.raised",
        subjectId: row.id,
        payload: {
          alertId: row.id,
          kind: draft.kind,
          severity: draft.severity,
          sources: draft.evidence,
        },
      },
      { registry: materialsEventRegistry() },
    );
    return { ...view, id: row.id, deduped: false };
  }
  const [open] = await tx
    .select({ id: alert.id })
    .from(alert)
    .where(
      and(eq(alert.tenantId, ctx.tenantId), eq(alert.dedupeKey, key), eq(alert.status, "open")),
    )
    .limit(1);
  return { ...view, id: open?.id ?? null, deduped: true };
}

/** Runs the rules over the document's recorded prices and raises what fires. */
export async function checkPrices(
  db: Db,
  ctx: PricingContext,
  input: { documentId: string; settings: PriceSettings; ignoreVendors?: readonly string[] },
): Promise<CheckResult> {
  return withTenant(db, ctx.tenantId, async (tx) => {
    const doc = await loadPricedDocument(tx, ctx.tenantId, input.documentId, {
      testRun: ctx.testRun,
    });
    const { drafts } = await priceLines(tx, ctx.tenantId, doc);
    // Live runs check what was recorded; a test run checks what would have been.
    const current = ctx.testRun
      ? drafts.map(({ line: _l, ext: _e, ...o }) => o)
      : await observationsOf(
          tx,
          ctx.tenantId,
          drafts.map((d) => d.docLineId as string),
        );
    const itemIds = [...new Set(current.map((o) => o.catalogItemId))];
    const since = daysBefore(doc.observedOn, HISTORY_DAYS);
    const history =
      itemIds.length === 0
        ? []
        : (
            await tx
              .select()
              .from(priceObservation)
              .where(
                and(
                  eq(priceObservation.tenantId, ctx.tenantId),
                  inArray(priceObservation.catalogItemId, itemIds),
                  gte(priceObservation.observedOn, since),
                  // A document read again counts once: its latest reading's prices only.
                  fromLatestReading(),
                ),
              )
          ).map(toObservation);
    const currentIds = new Set(current.map((o) => o.docLineId));
    const past = history.filter((o) => !currentIds.has(o.docLineId));
    const vendorIds = [...new Set([doc.vendorId, ...history.map((o) => o.vendorId)])];
    const vendors = await tx
      .select({ id: vendor.id, name: vendor.name })
      .from(vendor)
      .where(and(eq(vendor.tenantId, ctx.tenantId), inArray(vendor.id, vendorIds)));
    const items =
      itemIds.length === 0
        ? []
        : await tx
            .select({ id: catalogItem.id, name: catalogItem.canonicalName })
            .from(catalogItem)
            .where(and(eq(catalogItem.tenantId, ctx.tenantId), inArray(catalogItem.id, itemIds)));
    const vendorName = (id: string) => vendors.find((v) => v.id === id)?.name ?? "another vendor";

    const drafted: AlertDraft[] = [];
    for (const o of current) {
      const names = {
        item: items.find((i) => i.id === o.catalogItemId)?.name ?? "An item",
        vendor: vendorName,
      };
      drafted.push(...checkObservation(o, past, input.settings, names));
    }
    const fees = await priorFees(tx, ctx.tenantId, doc.vendorId, doc.documentId);
    drafted.push(
      ...newFees({
        vendorId: doc.vendorId,
        vendorName: doc.vendorName,
        fees: doc.surcharges,
        priorFeeTypes: fees.types,
        priorInvoices: fees.invoices,
        evidence: [doc.documentId, doc.extractionId],
        currency: doc.currency,
      }),
    );
    // DECISION: the client-specific `ignore_vendors` setting leaves out alerts about those vendors'
    // own prices and fees (a vendor the shop is leaving, or one on contract pricing).
    const ignored = new Set((input.ignoreVendors ?? []).map((v) => v.trim().toLowerCase()));
    const kept = drafted.filter((d) => !ignored.has(vendorName(d.vendorId).toLowerCase()));
    // §1.104: the contract check, when the vendor has a contract. DECISION: `ignore_vendors`
    // leaves out the history rules only; a vendor on contract pricing is checked against its
    // contract all the same (that is what the contract is for).
    const contract = await contractCheckFor(
      tx,
      ctx.tenantId,
      doc,
      current,
      new Map(drafts.map((d) => [d.docLineId, d.vendorItem?.id ?? null])),
      (itemId) => ({
        item: items.find((i) => i.id === itemId)?.name ?? "An item",
        vendor: vendorName,
      }),
    );
    if (contract) kept.push(...contract.alerts);
    // The same alert key twice in one document (two lines of one item): the first stands.
    const seen = new Set<string>();
    const alerts: RaisedAlert[] = [];
    for (const d of kept) {
      const key = dedupeKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      alerts.push(await raise(tx, ctx, d));
    }
    return {
      documentId: doc.documentId,
      checked: current.length,
      raised: alerts.filter((a) => !a.deduped).length,
      deduped: alerts.filter((a) => a.deduped).length,
      alerts,
      sources: [
        doc.documentId,
        doc.extractionId,
        ...current.map((o) => o.id),
        ...alerts.flatMap((a) => (a.id ? [a.id] : [])),
      ],
    };
  });
}
