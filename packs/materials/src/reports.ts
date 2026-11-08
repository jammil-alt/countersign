// The pack's client reports (ARCHITECTURE §12.2): Price watch (item × vendor: last price, change on
// the price before, the 90-day series; alerts with the invoices behind them) and Catalog, each also
// as CSV; and the lines a match review asks about. Reads only, inside the caller's withTenant
// transaction, always filtered by the client too (invariant 1). Nothing here carries agent
// definitions or model cost (invariant 11).

import { dec, toNumeric } from "@countersign/core";
import { alert, docExtraction, docLine, document, type Tx, vendor } from "@countersign/db";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { latestMatch } from "./catalog/store";
import { PACK_ID } from "./ids";
import { daysBefore } from "./pricing/rules";
import { catalogItem, itemAlias, priceObservation } from "./schema";

// P-5: `requests`, the Purchasing area's purchase requests (purchasing/report.ts).
export const REPORTS = ["prices", "catalog", "requests"] as const;
export type MaterialsReport = (typeof REPORTS)[number];

export interface EvidenceDocument {
  id: string;
  label: string;
}

/** The documents an alert's evidence comes from (its observations, lines and extractions). */
export async function evidenceDocuments(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, EvidenceDocument>> {
  const out = new Map<string, EvidenceDocument>();
  if (ids.length === 0) return out;
  const all = [...new Set(ids)];
  const obs = await tx
    .select({ id: priceObservation.id, docLineId: priceObservation.docLineId })
    .from(priceObservation)
    .where(and(eq(priceObservation.tenantId, tenantId), inArray(priceObservation.id, all)));
  const lineIds = [...new Set([...all, ...obs.flatMap((o) => (o.docLineId ? [o.docLineId] : []))])];
  const lines = await tx
    .select({ id: docLine.id, documentId: docExtraction.documentId })
    .from(docLine)
    .innerJoin(docExtraction, eq(docExtraction.id, docLine.extractionId))
    .where(and(eq(docLine.tenantId, tenantId), inArray(docLine.id, lineIds)));
  const extractions = await tx
    .select({ id: docExtraction.id, documentId: docExtraction.documentId })
    .from(docExtraction)
    .where(and(eq(docExtraction.tenantId, tenantId), inArray(docExtraction.id, all)));
  const docIds = [
    ...new Set([
      ...all,
      ...lines.map((l) => l.documentId),
      ...extractions.map((x) => x.documentId),
    ]),
  ];
  const docs = await tx
    .select({ id: document.id, filename: document.filename })
    .from(document)
    .where(and(eq(document.tenantId, tenantId), inArray(document.id, docIds)));
  const headers = docs.length
    ? await tx
        .select({ documentId: docExtraction.documentId, header: docExtraction.header })
        .from(docExtraction)
        .where(
          and(
            eq(docExtraction.tenantId, tenantId),
            inArray(
              docExtraction.documentId,
              docs.map((d) => d.id),
            ),
          ),
        )
        .orderBy(desc(docExtraction.createdAt))
    : [];
  for (const d of docs) {
    const h = (headers.find((x) => x.documentId === d.id)?.header ?? {}) as Record<string, unknown>;
    const label =
      typeof h.vendorName === "string" && typeof h.invoiceNumber === "string"
        ? `${h.vendorName} invoice ${h.invoiceNumber}`
        : d.filename;
    out.set(d.id, { id: d.id, label });
  }
  // Each evidence id → its document, so callers can map an alert's evidence.
  const byId = new Map<string, EvidenceDocument>();
  const put = (id: string, documentId: string | undefined) => {
    const d = documentId ? out.get(documentId) : undefined;
    if (d) byId.set(id, d);
  };
  for (const id of all) put(id, out.has(id) ? id : undefined);
  for (const l of lines) put(l.id, l.documentId);
  for (const x of extractions) put(x.id, x.documentId);
  for (const o of obs) put(o.id, lines.find((l) => l.id === o.docLineId)?.documentId);
  return byId;
}

// ── Price watch ──────────────────────────────────────────────────────────────────────────────────

export interface PriceWatchRow {
  catalogItemId: string;
  item: string;
  category: string;
  standardUom: string;
  vendorId: string;
  vendor: string;
  lastPrice: string;
  lastOn: string;
  previousPrice: string | null;
  /** Change of the last price on the one before, in percent (2 places); null with one price. */
  changePct: string | null;
  /** The last 90 days of prices, oldest first. */
  series: { on: string; price: string }[];
  purchases90: number;
  qty90: string;
  openAlerts: number;
}

export interface PriceWatchAlert {
  id: string;
  kind: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  dollarImpact: string | null;
  createdAt: string;
  catalogItemId: string | null;
  vendorId: string | null;
  evidence: string[];
  documents: EvidenceDocument[];
}

export interface PriceWatch {
  asOf: string;
  rows: PriceWatchRow[];
  alerts: PriceWatchAlert[];
  totals: { items: number; vendors: number; openAlerts: number; dollarImpact: string };
}

// DECISION: Price watch reads the last 400 days of prices (enough for a 90-day series and the
// price before it), lists every open alert and the 50 newest closed ones.
const WATCH_DAYS = 400;

export async function priceWatch(
  tx: Tx,
  tenantId: string,
  input: { today: string },
): Promise<PriceWatch> {
  const since = daysBefore(input.today, WATCH_DAYS);
  const rows = await tx
    .select({
      o: priceObservation,
      item: catalogItem.canonicalName,
      category: catalogItem.category,
      vendor: vendor.name,
    })
    .from(priceObservation)
    .innerJoin(catalogItem, eq(catalogItem.id, priceObservation.catalogItemId))
    .innerJoin(vendor, eq(vendor.id, priceObservation.vendorId))
    .where(and(eq(priceObservation.tenantId, tenantId), gte(priceObservation.observedOn, since)))
    .orderBy(asc(priceObservation.observedOn), asc(priceObservation.createdAt));
  const alerts = await tx
    .select()
    .from(alert)
    .where(and(eq(alert.tenantId, tenantId), eq(alert.pack, PACK_ID)))
    .orderBy(sql`${alert.status} = 'open' desc`, desc(alert.createdAt))
    .limit(500);
  const shown = [
    ...alerts.filter((a) => a.status === "open"),
    ...alerts.filter((a) => a.status !== "open").slice(0, 50),
  ];
  const docs = await evidenceDocuments(
    tx,
    tenantId,
    shown.flatMap((a) => a.evidence),
  );

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.o.catalogItemId}:${r.o.vendorId}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const window = daysBefore(input.today, 90);
  const out: PriceWatchRow[] = [];
  for (const group of groups.values()) {
    const last = group.at(-1) as (typeof rows)[number];
    const prev = group.length > 1 ? (group.at(-2) as (typeof rows)[number]) : null;
    const recent = group.filter((g) => g.o.observedOn >= window);
    const change =
      prev && !dec(prev.o.unitPriceStd).isZero()
        ? dec(last.o.unitPriceStd)
            .minus(prev.o.unitPriceStd)
            .dividedBy(prev.o.unitPriceStd)
            .times(100)
            .toDecimalPlaces(2)
            .toString()
        : null;
    out.push({
      catalogItemId: last.o.catalogItemId,
      item: last.item,
      category: last.category,
      standardUom: last.o.standardUom,
      vendorId: last.o.vendorId,
      vendor: last.vendor,
      lastPrice: last.o.unitPriceStd,
      lastOn: last.o.observedOn,
      previousPrice: prev?.o.unitPriceStd ?? null,
      changePct: change,
      series: recent.map((g) => ({ on: g.o.observedOn, price: g.o.unitPriceStd })),
      purchases90: recent.length,
      qty90: toNumeric(recent.reduce((s, g) => s.plus(g.o.qtyStd), dec("0"))),
      openAlerts: alerts.filter(
        (a) =>
          a.status === "open" &&
          a.subjectId === last.o.catalogItemId &&
          (a.facts as Record<string, unknown>).vendorId === last.o.vendorId,
      ).length,
    });
  }
  out.sort((a, b) => a.item.localeCompare(b.item) || a.vendor.localeCompare(b.vendor));
  const open = alerts.filter((a) => a.status === "open");
  return {
    asOf: input.today,
    rows: out,
    alerts: shown.map((a) => {
      const facts = a.facts as Record<string, unknown>;
      const documents = new Map<string, EvidenceDocument>();
      for (const id of a.evidence) {
        const d = docs.get(id);
        if (d) documents.set(d.id, d);
      }
      return {
        id: a.id,
        kind: a.kind,
        severity: a.severity,
        status: a.status,
        title: a.title,
        body: a.body,
        dollarImpact: a.dollarImpact,
        createdAt: a.createdAt.toISOString(),
        catalogItemId: typeof facts.catalogItemId === "string" ? facts.catalogItemId : null,
        vendorId: typeof facts.vendorId === "string" ? facts.vendorId : null,
        evidence: a.evidence,
        documents: [...documents.values()],
      };
    }),
    totals: {
      items: new Set(out.map((r) => r.catalogItemId)).size,
      vendors: new Set(out.map((r) => r.vendorId)).size,
      openAlerts: open.length,
      dollarImpact: toNumeric(open.reduce((s, a) => s.plus(a.dollarImpact ?? "0"), dec("0"))),
    },
  };
}

// ── Catalog ──────────────────────────────────────────────────────────────────────────────────────

export interface CatalogRow {
  id: string;
  category: string;
  name: string;
  standardUom: string;
  attributes: Record<string, string>;
  vendors: number;
  aliases: number;
  purchases: number;
  lastPrice: string | null;
  lastOn: string | null;
}

export async function catalogReport(tx: Tx, tenantId: string): Promise<{ items: CatalogRow[] }> {
  const items = await tx
    .select()
    .from(catalogItem)
    .where(and(eq(catalogItem.tenantId, tenantId), isNull(catalogItem.mergedIntoId)))
    .orderBy(asc(catalogItem.category), asc(catalogItem.canonicalName))
    .limit(5000);
  const aliasCounts = await tx
    .select({ id: itemAlias.catalogItemId, n: sql<number>`count(*)::int` })
    .from(itemAlias)
    .where(eq(itemAlias.tenantId, tenantId))
    .groupBy(itemAlias.catalogItemId);
  const prices = await tx
    .select({
      id: priceObservation.catalogItemId,
      n: sql<number>`count(*)::int`,
      vendors: sql<number>`count(distinct ${priceObservation.vendorId})::int`,
      lastOn: sql<string>`max(${priceObservation.observedOn})::text`,
    })
    .from(priceObservation)
    .where(eq(priceObservation.tenantId, tenantId))
    .groupBy(priceObservation.catalogItemId);
  const lastPrices = await tx
    .selectDistinctOn([priceObservation.catalogItemId], {
      id: priceObservation.catalogItemId,
      price: priceObservation.unitPriceStd,
    })
    .from(priceObservation)
    .where(eq(priceObservation.tenantId, tenantId))
    .orderBy(
      priceObservation.catalogItemId,
      desc(priceObservation.observedOn),
      desc(priceObservation.createdAt),
    );
  return {
    items: items.map((i) => {
      const p = prices.find((x) => x.id === i.id);
      return {
        id: i.id,
        category: i.category,
        name: i.canonicalName,
        standardUom: i.standardUom,
        attributes: i.attributes as Record<string, string>,
        vendors: p?.vendors ?? 0,
        aliases: aliasCounts.find((x) => x.id === i.id)?.n ?? 0,
        purchases: p?.n ?? 0,
        lastPrice: lastPrices.find((x) => x.id === i.id)?.price ?? null,
        lastOn: p?.lastOn ?? null,
      };
    }),
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────

function cell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  // A leading =, +, - or @ would run as a formula in a spreadsheet: quote it with a '.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: (string | number | null)[][]): string {
  return `${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function priceWatchCsv(report: PriceWatch): string {
  return toCsv([
    [
      "Item",
      "Category",
      "Unit",
      "Vendor",
      "Last price",
      "Last purchased",
      "Price before",
      "Change %",
      "Purchases (90 days)",
      "Quantity (90 days)",
      "Open alerts",
    ],
    ...report.rows.map((r) => [
      r.item,
      r.category,
      r.standardUom,
      r.vendor,
      r.lastPrice,
      r.lastOn,
      r.previousPrice,
      r.changePct,
      r.purchases90,
      r.qty90,
      r.openAlerts,
    ]),
  ]);
}

export function catalogCsv(report: { items: CatalogRow[] }): string {
  return toCsv([
    [
      "Item",
      "Category",
      "Unit",
      "Attributes",
      "Vendors",
      "Purchases",
      "Last price",
      "Last purchased",
    ],
    ...report.items.map((i) => [
      i.name,
      i.category,
      i.standardUom,
      Object.entries(i.attributes)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
      i.vendors,
      i.purchases,
      i.lastPrice,
      i.lastOn,
    ]),
  ]);
}

// ── Match review ─────────────────────────────────────────────────────────────────────────────────

export interface ReviewLine {
  docLineId: string;
  lineNo: number;
  description: string;
  vendorSku: string | null;
  qty: string;
  uom: string | null;
  unitPrice: string;
  /** The newest decision about the line. */
  decision: "matched" | "new_item" | "unsure" | null;
  method: string | null;
  catalogItemId: string | null;
  catalogItemName: string | null;
  candidates: { catalogItemId: string; name: string; confidence: number; vetoed: boolean }[];
}

/** The lines a match review asks about, with the candidates the agent weighed. */
export async function reviewLines(
  tx: Tx,
  tenantId: string,
  docLineIds: readonly string[],
): Promise<ReviewLine[]> {
  if (docLineIds.length === 0) return [];
  const lines = await tx
    .select()
    .from(docLine)
    .where(and(eq(docLine.tenantId, tenantId), inArray(docLine.id, [...docLineIds])))
    .orderBy(asc(docLine.lineNo));
  const out: ReviewLine[] = [];
  for (const l of lines) {
    const m = await latestMatch(tx, tenantId, l.id);
    const item = m?.catalogItemId
      ? (
          await tx
            .select({ name: catalogItem.canonicalName })
            .from(catalogItem)
            .where(and(eq(catalogItem.tenantId, tenantId), eq(catalogItem.id, m.catalogItemId)))
        )[0]
      : undefined;
    // The candidates of the agent's last unsure decision, if the newest is a person's.
    const candidates = (Array.isArray(m?.candidates) ? m.candidates : []) as {
      catalogItemId?: unknown;
      name?: unknown;
      confidence?: unknown;
      vetoed?: unknown;
    }[];
    out.push({
      docLineId: l.id,
      lineNo: l.lineNo,
      description: l.rawDescription,
      vendorSku: l.vendorSku,
      qty: l.qty,
      uom: l.uomRaw,
      unitPrice: l.unitPrice,
      decision: m?.decision ?? null,
      method: m?.method ?? null,
      catalogItemId: m?.catalogItemId ?? null,
      catalogItemName: item?.name ?? null,
      candidates: candidates
        .filter((c) => typeof c.catalogItemId === "string" && typeof c.name === "string")
        .map((c) => ({
          catalogItemId: c.catalogItemId as string,
          name: c.name as string,
          confidence: Number(c.confidence ?? 0),
          vetoed: c.vetoed === true,
        }))
        .slice(0, 5),
    });
  }
  return out;
}
