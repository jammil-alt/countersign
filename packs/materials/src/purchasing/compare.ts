// Comparing quotes (docs/plan.md §1.67, `materials.quote.compare`): deterministic, never a model.
// Per request line, the offers compare in the catalog item's standard unit; an offer whose unit has
// no conversion rule compares only with offers in the very same unit (invariant 7: never across
// units without a rule), and never across currencies. Then a total per vendor, the lines each
// vendor left out or can't supply, lead times against the needed-by date, and a suggestion (one
// vendor, or a split) with its reasons and the records behind it (invariant 10).

import { type Decimal, dec, formatAmount, toNumeric } from "@countersign/core";
import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { parseLine } from "../catalog/keys";
import { daysBefore } from "../pricing/rules";
import { convert, readUom } from "../pricing/uom";
import { quoteRequest } from "../schema";
import { quoteLines } from "./quotes";
import { type PurchasingContext, requestLines, requestRow } from "./requests";

/** A split is suggested only when it saves at least this much on the best single vendor. */
export const SPLIT_MIN_SAVING_PCT = 5;

export interface CompareLine {
  id: string;
  lineNo: number;
  description: string;
  qty: string;
  unit: string | null;
  catalogItemId: string | null;
  standardUom: string | null;
  /** The request's quantity in the item's standard unit, when its unit converts; else null. */
  qtyStd: string | null;
}

export interface CompareQuote {
  id: string;
  vendorId: string;
  vendorName: string;
  receivedAt: string | null;
}

export interface CompareOfferInput {
  id: string;
  quoteRequestId: string;
  requestLineId: string;
  qty: string | null;
  unit: string | null;
  unitPrice: string | null;
  currency: string;
  unitPriceStd: string | null;
  standardUom: string | null;
  leadTimeDays: number | null;
  available: boolean;
}

export interface Offer {
  quoteRequestId: string;
  quoteLineId: string;
  vendorId: string;
  vendorName: string;
  unitPrice: string | null;
  unit: string | null;
  currency: string;
  unitPriceStd: string | null;
  standardUom: string | null;
  /** What this vendor would charge for the line as asked. */
  cost: string | null;
  leadTimeDays: number | null;
  available: boolean;
  /** Compared with the line's other offers. */
  comparable: boolean;
  note: string | null;
}

export interface LineComparison {
  requestLineId: string;
  lineNo: number;
  description: string;
  qty: string;
  unit: string | null;
  catalogItemId: string | null;
  standardUom: string | null;
  offers: Offer[];
  best: {
    quoteRequestId: string;
    quoteLineId: string;
    vendorId: string;
    price: string;
    per: string;
    cost: string | null;
  } | null;
  missing: string[];
  unavailable: string[];
  note: string | null;
}

export interface VendorTotal {
  quoteRequestId: string;
  vendorId: string;
  vendorName: string;
  total: string;
  currency: string | null;
  linesPriced: number;
  linesMissing: number;
  linesUnavailable: number;
  complete: boolean;
  maxLeadTimeDays: number | null;
  late: boolean;
}

export interface Suggestion {
  kind: "single" | "split" | "none";
  quoteRequestId: string | null;
  vendorId: string | null;
  total: string | null;
  currency: string | null;
  split: { quoteRequestId: string; vendorId: string; requestLineIds: string[]; total: string }[];
  reasons: string[];
}

export interface Comparison {
  requestId: string;
  neededBy: string | null;
  asOf: string;
  lines: LineComparison[];
  vendors: VendorTotal[];
  suggestion: Suggestion;
  sources: string[];
}

function money(amount: Decimal | string, currency: string | null): string {
  const text = formatAmount(amount);
  return currency === null || currency === "USD" ? `$${text}` : `${currency} ${text}`;
}

const addDays = (day: string, n: number) => daysBefore(day, -n);

interface Basis {
  key: string;
  std: boolean;
  price: string;
  per: string;
}

function basisOf(o: CompareOfferInput, line: CompareLine): Basis | null {
  if (!o.available || o.unitPrice === null) return null;
  if (o.unitPriceStd !== null && o.standardUom !== null && o.standardUom === line.standardUom) {
    return {
      key: `${o.currency}|${o.standardUom}`,
      std: true,
      price: o.unitPriceStd,
      per: o.standardUom,
    };
  }
  const unit = readUom(o.unit) ?? (o.unit?.trim().toLowerCase() || "unstated unit");
  return { key: `${o.currency}|${unit}`, std: false, price: o.unitPrice, per: unit };
}

/**
 * The comparison itself: pure, so its decimal and unit rules are tested without a database.
 */
export function compareOffers(input: {
  requestId: string;
  neededBy: string | null;
  asOf: string;
  lines: readonly CompareLine[];
  quotes: readonly CompareQuote[];
  offers: readonly CompareOfferInput[];
  splitMinSavingPct?: number | undefined;
}): Comparison {
  const minPct = dec(String(input.splitMinSavingPct ?? SPLIT_MIN_SAVING_PCT));
  const quotes = [...input.quotes].sort(
    (a, b) => a.vendorName.localeCompare(b.vendorName) || a.id.localeCompare(b.id),
  );
  const sources = new Set<string>([input.requestId]);
  const lines: LineComparison[] = [];
  for (const line of input.lines) {
    sources.add(line.id);
    const offers: Offer[] = [];
    const bases = new Map<string, Basis>();
    const missing: string[] = [];
    const unavailable: string[] = [];
    for (const q of quotes) {
      const o = input.offers.find((x) => x.quoteRequestId === q.id && x.requestLineId === line.id);
      if (!o) {
        missing.push(q.vendorId);
        continue;
      }
      sources.add(o.id);
      if (!o.available) unavailable.push(q.vendorId);
      const basis = basisOf(o, line);
      if (basis) bases.set(o.id, basis);
      // DECISION: an offer's cost for the line as asked is its standard-unit price times the
      // asked quantity in standard units; otherwise its price times the quantity quoted.
      const cost =
        basis?.std && line.qtyStd !== null
          ? toNumeric(dec(basis.price).times(line.qtyStd))
          : o.unitPrice !== null && o.qty !== null && o.available
            ? toNumeric(dec(o.unitPrice).times(o.qty))
            : null;
      offers.push({
        quoteRequestId: q.id,
        quoteLineId: o.id,
        vendorId: q.vendorId,
        vendorName: q.vendorName,
        unitPrice: o.unitPrice,
        unit: o.unit,
        currency: o.currency,
        unitPriceStd: o.unitPriceStd,
        standardUom: o.standardUom,
        cost,
        leadTimeDays: o.leadTimeDays,
        available: o.available,
        comparable: false,
        note: o.available ? (o.unitPrice === null ? "no price" : null) : "not available",
      });
    }
    // The basis the line compares in: its standard unit when any offer converts to it, else the
    // one unit every priced offer shares; in the currency most offers are in. Offers in another
    // unit or currency are set aside with the reason.
    // DECISION: when two standard-unit currencies tie, or no offer converts and the units differ,
    // the line isn't compared at all: nothing decides between them without a rule.
    const counts = new Map<string, { n: number; std: boolean }>();
    for (const b of bases.values()) {
      const c = counts.get(b.key) ?? { n: 0, std: b.std };
      counts.set(b.key, { n: c.n + 1, std: b.std });
    }
    const ranked = [...counts.entries()].sort(
      (a, b) => Number(b[1].std) - Number(a[1].std) || b[1].n - a[1].n || a[0].localeCompare(b[0]),
    );
    const [first, second] = ranked;
    const primary =
      first &&
      (ranked.length === 1 || (first[1].std && !(second?.[1].std && second[1].n === first[1].n)))
        ? first[0]
        : null;
    let note: string | null = null;
    for (const offer of offers) {
      const b = bases.get(offer.quoteLineId);
      if (!b) continue;
      if (b.key === primary) offer.comparable = true;
      else if (primary !== null) {
        const [cur, per] = primary.split("|");
        offer.note =
          b.key.split("|")[0] !== cur
            ? `quoted in ${offer.currency}, not ${cur}`
            : `quoted per ${b.per}, and no conversion rule turns that into ${per}`;
      } else {
        offer.note =
          "vendors quoted this line in different units or currencies with no rule between them";
      }
    }
    if (primary === null && ranked.length > 1) {
      note =
        "Not compared: the vendors quoted this line in different units or currencies with no conversion rule.";
    } else if (ranked.length === 0 && offers.length > 0) {
      note = "No vendor gave a price for this line.";
    } else if (offers.length === 0) {
      note = quotes.length === 0 ? null : "No vendor quoted this line.";
    }
    const comparable = offers.filter((o) => o.comparable);
    const best = comparable.sort((a, b) => {
      const pa = bases.get(a.quoteLineId)?.price ?? "0";
      const pb = bases.get(b.quoteLineId)?.price ?? "0";
      return (
        dec(pa).comparedTo(dec(pb)) ||
        (a.leadTimeDays ?? Number.MAX_SAFE_INTEGER) - (b.leadTimeDays ?? Number.MAX_SAFE_INTEGER) ||
        a.vendorName.localeCompare(b.vendorName)
      );
    })[0];
    const bestBasis = best ? bases.get(best.quoteLineId) : undefined;
    lines.push({
      requestLineId: line.id,
      lineNo: line.lineNo,
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      catalogItemId: line.catalogItemId,
      standardUom: line.standardUom,
      offers: offers.sort((a, b) => a.vendorName.localeCompare(b.vendorName)),
      best:
        best && bestBasis
          ? {
              quoteRequestId: best.quoteRequestId,
              quoteLineId: best.quoteLineId,
              vendorId: best.vendorId,
              price: bestBasis.price,
              per: bestBasis.per,
              cost: best.cost,
            }
          : null,
      missing,
      unavailable,
      note,
    });
  }

  // Totals per vendor: the lines it can supply at a comparable price, as asked.
  const vendors: VendorTotal[] = quotes.map((q) => {
    let total = dec("0");
    let priced = 0;
    let lead: number | null = null;
    let currency: string | null = null;
    for (const l of lines) {
      const o = l.offers.find((x) => x.quoteRequestId === q.id);
      if (!o?.comparable || o.cost === null) continue;
      priced++;
      total = total.plus(o.cost);
      currency = o.currency;
      if (o.leadTimeDays !== null) lead = Math.max(lead ?? 0, o.leadTimeDays);
    }
    const late =
      input.neededBy !== null && lead !== null && addDays(input.asOf, lead) > input.neededBy;
    return {
      quoteRequestId: q.id,
      vendorId: q.vendorId,
      vendorName: q.vendorName,
      total: toNumeric(total),
      currency,
      linesPriced: priced,
      linesMissing: lines.filter((l) => l.missing.includes(q.vendorId)).length,
      linesUnavailable: lines.filter((l) => l.unavailable.includes(q.vendorId)).length,
      complete: lines.length > 0 && priced === lines.length,
      maxLeadTimeDays: lead,
      late,
    };
  });

  const suggestion = suggest(input, lines, vendors, minPct);
  return {
    requestId: input.requestId,
    neededBy: input.neededBy,
    asOf: input.asOf,
    lines,
    vendors,
    suggestion,
    sources: [...sources, ...quotes.map((q) => q.id)],
  };
}

function suggest(
  input: { neededBy: string | null; quotes: readonly CompareQuote[] },
  lines: readonly LineComparison[],
  vendors: readonly VendorTotal[],
  minPct: Decimal,
): Suggestion {
  const none = (reasons: string[]): Suggestion => ({
    kind: "none",
    quoteRequestId: null,
    vendorId: null,
    total: null,
    currency: null,
    split: [],
    reasons,
  });
  if (input.quotes.length === 0) return none(["No quotes are in yet."]);
  if (lines.length === 0) return none(["The request has no lines."]);

  const complete = vendors
    .filter((v) => v.complete)
    .sort(
      (a, b) =>
        dec(a.total).comparedTo(dec(b.total)) ||
        (a.maxLeadTimeDays ?? 0) - (b.maxLeadTimeDays ?? 0) ||
        a.vendorName.localeCompare(b.vendorName),
    );
  // DECISION: a vendor that would deliver after the needed-by date is suggested only when no
  // vendor that is on time quoted every line.
  const onTime = complete.filter((v) => !v.late);
  const pool = onTime.length > 0 ? onTime : complete;
  const single = pool[0];

  // The split: every line from the vendor with its best comparable price.
  const covered = lines.every((l) => l.best !== null && l.best.cost !== null);
  const parts = new Map<
    string,
    { quoteRequestId: string; vendorId: string; ids: string[]; total: Decimal }
  >();
  let splitTotal = dec("0");
  if (covered) {
    for (const l of lines) {
      const b = l.best as NonNullable<LineComparison["best"]>;
      const part = parts.get(b.quoteRequestId) ?? {
        quoteRequestId: b.quoteRequestId,
        vendorId: b.vendorId,
        ids: [],
        total: dec("0"),
      };
      part.ids.push(l.requestLineId);
      part.total = part.total.plus(b.cost as string);
      parts.set(b.quoteRequestId, part);
      splitTotal = splitTotal.plus(b.cost as string);
    }
  }
  const currency = single?.currency ?? vendors.find((v) => v.currency)?.currency ?? null;
  const split = [...parts.values()].map((p) => ({
    quoteRequestId: p.quoteRequestId,
    vendorId: p.vendorId,
    requestLineIds: p.ids,
    total: toNumeric(p.total),
  }));
  const nameOf = (vendorId: string) =>
    vendors.find((v) => v.vendorId === vendorId)?.vendorName ?? "a vendor";

  if (single) {
    const reasons = [
      `${single.vendorName} quoted every line for ${money(single.total, currency)} in total, the lowest of ${complete.length} complete ${complete.length === 1 ? "quote" : "quotes"}.`,
    ];
    const next = pool[1];
    if (next) {
      reasons.push(
        `Next is ${next.vendorName} at ${money(next.total, currency)}, ${money(dec(next.total).minus(single.total), currency)} more.`,
      );
    }
    const cheaperLate = complete.find(
      (v) => v.late && dec(v.total).lessThan(single.total) && onTime.length > 0,
    );
    if (cheaperLate && input.neededBy) {
      reasons.push(
        `${cheaperLate.vendorName} is cheaper at ${money(cheaperLate.total, currency)} but can't deliver by ${input.neededBy}.`,
      );
    }
    if (single.late && input.neededBy) {
      reasons.push(`No vendor that quoted every line can deliver by ${input.neededBy}.`);
    }
    if (covered && parts.size > 1) {
      const saving = dec(single.total).minus(splitTotal);
      const pct = dec(single.total).isZero() ? dec("0") : saving.dividedBy(single.total).times(100);
      if (saving.greaterThan(0) && pct.greaterThanOrEqualTo(minPct)) {
        return {
          kind: "split",
          quoteRequestId: null,
          vendorId: null,
          total: toNumeric(splitTotal),
          currency,
          split,
          reasons: [
            `Buying each line from its cheapest vendor costs ${money(splitTotal, currency)}, ${money(saving, currency)} (${pct.toDecimalPlaces(1).toString()}%) less than ${single.vendorName} alone.`,
            ...split.map(
              (p) =>
                `${nameOf(p.vendorId)}: ${p.requestLineIds.length} ${p.requestLineIds.length === 1 ? "line" : "lines"}, ${money(p.total, currency)}.`,
            ),
          ],
        };
      }
      if (saving.greaterThan(0)) {
        reasons.push(
          `Splitting the order would save ${money(saving, currency)} (${pct.toDecimalPlaces(1).toString()}%), less than ${minPct.toString()}%, so one vendor is simpler.`,
        );
      }
    }
    return {
      kind: "single",
      quoteRequestId: single.quoteRequestId,
      vendorId: single.vendorId,
      total: single.total,
      currency,
      split: [],
      reasons,
    };
  }
  if (covered) {
    return {
      kind: "split",
      quoteRequestId: null,
      vendorId: null,
      total: toNumeric(splitTotal),
      currency,
      split,
      reasons: [
        `No vendor quoted every line at a price we can compare; buying each line from its cheapest vendor covers them all for ${money(splitTotal, currency)}.`,
        ...split.map(
          (p) =>
            `${nameOf(p.vendorId)}: ${p.requestLineIds.length} ${p.requestLineIds.length === 1 ? "line" : "lines"}, ${money(p.total, currency)}.`,
        ),
      ],
    };
  }
  return none(
    lines
      .filter((l) => l.best === null || l.best.cost === null)
      .map(
        (l) =>
          `Line ${l.lineNo} (${l.description}) has no price we can compare${l.note ? `: ${l.note.replace(/\.$/, "").toLowerCase()}` : ""}.`,
      ),
  );
}

/** Loads a request's received quotes and compares them. */
export async function compareQuotes(
  db: Db,
  ctx: PurchasingContext,
  input: { requestId: string; asOf: string; splitMinSavingPct?: number | undefined },
): Promise<Comparison> {
  return withTenant(db, ctx.tenantId, async (tx: Tx) => {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    const quotes = await tx
      .select({ q: quoteRequest, vendorName: vendor.name })
      .from(quoteRequest)
      .innerJoin(vendor, eq(vendor.id, quoteRequest.vendorId))
      .where(
        and(
          eq(quoteRequest.tenantId, ctx.tenantId),
          eq(quoteRequest.purchaseRequestId, r.id),
          eq(quoteRequest.status, "received"),
        ),
      );
    const offers = await quoteLines(
      tx,
      ctx.tenantId,
      quotes.map((x) => x.q.id),
    );
    return compareOffers({
      requestId: r.id,
      neededBy: r.neededBy,
      asOf: input.asOf,
      splitMinSavingPct: input.splitMinSavingPct,
      lines: lines.map(({ row, item }) => {
        let qtyStd: string | null = null;
        if (item) {
          const conv = convert(row.unit, item.standardUom, {
            ...(item.attributes as Record<string, string>),
            ...parseLine(row.description).attributes,
          });
          if (conv.ok) qtyStd = toNumeric(dec(row.qty).times(conv.factor));
        }
        return {
          id: row.id,
          lineNo: row.lineNo,
          description: row.description,
          qty: row.qty,
          unit: row.unit,
          catalogItemId: item?.id ?? null,
          standardUom: item?.standardUom ?? null,
          qtyStd,
        };
      }),
      quotes: quotes.map(({ q, vendorName }) => ({
        id: q.id,
        vendorId: q.vendorId,
        vendorName,
        receivedAt: q.receivedAt ? q.receivedAt.toISOString() : null,
      })),
      offers: offers.map((o) => ({
        id: o.id,
        quoteRequestId: o.quoteRequestId,
        requestLineId: o.purchaseRequestLineId,
        qty: o.qty,
        unit: o.unit,
        unitPrice: o.unitPrice,
        currency: o.currency,
        unitPriceStd: o.unitPriceStd,
        standardUom: o.standardUom,
        leadTimeDays: o.leadTimeDays,
        available: o.available,
      })),
    });
  });
}
