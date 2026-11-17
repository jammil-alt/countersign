// Comparing quotes (docs/plan.md §1.67, `materials.quote.compare`): deterministic, never a model.
// Per request line, the offers compare in the catalog item's standard unit; an offer whose unit has
// no conversion rule compares only with offers in the very same unit (invariant 7: never across
// units without a rule), never when that unit is a box, case or pail (one vendor's box is not
// another's), and never across currencies. The quantity each vendor quoted is held against the
// quantity asked (in standard units when both convert): one for less is short and not compared,
// one for more is compared at what it will cost. Each offer costs what its purchase order will
// charge: the quoted quantity times the price, rounded to cents (`po.ts`). Then a total per
// vendor, the lines each vendor left out or can't supply, lead times against the needed-by date,
// and a suggestion (one vendor, or a split) with its reasons and the records behind it
// (invariant 10).

import { type Decimal, dec, formatAmount, toNumeric } from "@countersign/core";
import { type Db, type Tx, vendor, withTenant } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { parseLine } from "../catalog/keys";
import { daysBefore } from "../pricing/rules";
import { convertLine, PACKAGING_UOMS, readUom } from "../pricing/uom";
import { quoteRequest } from "../schema";
import { vendorItemForUnit } from "../vendor/store";
import { cents } from "./po";
import { quotedConversion, quoteLines } from "./quotes";
import { type PurchasingContext, PurchasingError, requestLines, requestRow } from "./requests";

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
  /** The quantity quoted in the item's standard unit, when its unit converts; else null. */
  qtyStd?: string | null | undefined;
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
  /** What this vendor's purchase order would charge for the line: quoted quantity × price. */
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
  /**
   * False when vendors priced the line but no price could be compared (a box of no known size,
   * units with no rule between them): it is left out of every vendor's total and completeness.
   */
  compared: boolean;
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
  /** Per box, case or pail with no known pack size: a unit of its own, never compared. */
  packaged?: boolean;
}

/** A unit as compared: its one spelling when known, else its words; null when none is given. */
const unitKey = (raw: string | null): string | null =>
  raw?.trim() ? (readUom(raw) ?? raw.trim().toLowerCase()) : null;

const UNIT_WORDS: Record<string, string> = {
  board_foot: "board feet",
  linear_foot: "linear feet",
  each: "each",
};
const unitWords = (uom: string) => UNIT_WORDS[uom] ?? `${uom.replace(/_/g, " ")}s`;

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

type Coverage = "covered" | "short" | "over" | "unknown";

/**
 * Whether what the vendor quoted covers what was asked: in standard units when both convert,
 * else in the unit asked when the vendor quoted in it (a line with no unit and no catalog item is
 * for whatever unit the vendor quotes); else nothing tells.
 */
function coverageOf(
  o: CompareOfferInput,
  line: CompareLine,
): { is: Coverage; note: string | null } {
  if (o.qty === null) return { is: "covered", note: null };
  const words = (qty: string, unit: string | null) =>
    [dec(qty).toString(), unit].filter(Boolean).join(" ");
  let quoted: string;
  let asked: string;
  let unit: string | null;
  if (o.qtyStd != null && line.qtyStd !== null && line.standardUom !== null) {
    quoted = o.qtyStd;
    asked = line.qtyStd;
    unit = unitWords(line.standardUom);
  } else if (
    unitKey(o.unit) === unitKey(line.unit) ||
    (unitKey(line.unit) === null && line.qtyStd === null)
  ) {
    quoted = o.qty;
    asked = line.qty;
    unit = o.unit?.trim() || null;
  } else {
    return {
      is: "unknown",
      note: `quoted ${words(o.qty, o.unit?.trim() || null)}, and no rule says whether that covers the ${words(line.qty, line.unit)} asked`,
    };
  }
  const c = dec(quoted).comparedTo(dec(asked));
  if (c < 0)
    return {
      is: "short",
      note: `quoted ${words(quoted, unit)} of the ${words(asked, unit)} asked`,
    };
  if (c > 0) {
    return {
      is: "over",
      note: `quoted ${words(quoted, unit)} where ${words(asked, unit)} were asked (a minimum order?): priced as quoted`,
    };
  }
  return { is: "covered", note: null };
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
    let shortCount = 0;
    let packagedCount = 0;
    let unknownCount = 0;
    const coverages = new Map<string, { is: Coverage; note: string | null }>();
    for (const q of quotes) {
      const o = input.offers.find((x) => x.quoteRequestId === q.id && x.requestLineId === line.id);
      if (!o) {
        missing.push(q.vendorId);
        continue;
      }
      sources.add(o.id);
      if (!o.available) unavailable.push(q.vendorId);
      const basis = basisOf(o, line);
      // DECISION (audit 7.8): a price per box, case or pail that doesn't convert to the standard
      // unit is never compared, not even with another vendor's in the same word: a box of 50 is
      // not a box of 100. It is set aside, and the others compare among themselves.
      const packaged = basis !== null && !basis.std && PACKAGING_UOMS.has(basis.per);
      // DECISION (review of fix/materials, finding 2): an offer costs what its purchase order
      // will charge (the quoted quantity, else the asked one, times the price, each line rounded
      // to cents, `po.ts`). Its quantity is held against the quantity asked: short is shown, not
      // compared, and leaves the vendor's quote incomplete; more than asked (a minimum order) is
      // compared at that cost; when no rule tells, it is not compared.
      const cost =
        o.available && o.unitPrice !== null
          ? toNumeric(cents(dec(o.unitPrice).times(o.qty ?? line.qty)))
          : null;
      if (basis && !packaged) {
        bases.set(o.id, basis);
        coverages.set(o.id, coverageOf(o, line));
      }
      if (packaged) packagedCount++;
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
        note: !o.available
          ? "not available"
          : o.unitPrice === null
            ? "no price"
            : packaged
              ? `quoted per ${o.unit?.trim() || "pack"} with no known pack size, so it can't be compared`
              : null,
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
      if (b.key === primary) {
        // In the line's basis: compared when what was quoted covers what was asked.
        const cov = coverages.get(offer.quoteLineId);
        offer.comparable = cov?.is === "covered" || cov?.is === "over";
        offer.note = cov?.note ?? null;
        if (cov?.is === "short") shortCount++;
        if (cov?.is === "unknown") unknownCount++;
      } else if (primary !== null) {
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
    } else if (ranked.length === 0 && packagedCount > 0) {
      note = `Not compared: no vendor's box, case or container converts to ${line.standardUom ?? "the unit asked"} with a known pack size.`;
    } else if (primary !== null && !offers.some((o) => o.comparable) && shortCount > 0) {
      note = "No vendor quoted the whole quantity asked.";
    } else if (primary !== null && !offers.some((o) => o.comparable) && unknownCount > 0) {
      note =
        "Not compared: the vendors quoted this line in different units from the one asked, with no conversion rule.";
    } else if (ranked.length === 0 && offers.length > 0) {
      note = "No vendor gave a price for this line.";
    } else if (offers.length === 0) {
      note = quotes.length === 0 ? null : "No vendor quoted this line.";
    }
    // Ranked on what each purchase order would charge, then the price, the lead time, the name.
    const comparable = offers.filter((o) => o.comparable);
    const best = comparable.sort((a, b) => {
      const pa = bases.get(a.quoteLineId)?.price ?? "0";
      const pb = bases.get(b.quoteLineId)?.price ?? "0";
      return (
        dec(a.cost ?? "0").comparedTo(dec(b.cost ?? "0")) ||
        dec(pa).comparedTo(dec(pb)) ||
        (a.leadTimeDays ?? Number.MAX_SAFE_INTEGER) - (b.leadTimeDays ?? Number.MAX_SAFE_INTEGER) ||
        a.vendorName.localeCompare(b.vendorName)
      );
    })[0];
    const bestBasis = best ? bases.get(best.quoteLineId) : undefined;
    // DECISION (review of fix/materials, finding 7): a line vendors priced but nobody's price
    // could be compared on is left out of every vendor's total and completeness (the suggestion
    // says so), rather than leaving every quote incomplete. A line nobody quoted in full, or at
    // all, still counts against each vendor.
    const priced = offers.some((o) => o.available && o.unitPrice !== null);
    const compared = best !== undefined || !priced || shortCount > 0;
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
      compared,
    });
  }

  // Totals per vendor: the lines it can supply at a comparable price, as asked.
  const vendors: VendorTotal[] = quotes.map((q) => {
    let total = dec("0");
    let priced = 0;
    let lead: number | null = null;
    let currency: string | null = null;
    const counted = lines.filter((l) => l.compared);
    for (const l of counted) {
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
      complete: counted.length > 0 && priced === counted.length,
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
  allLines: readonly LineComparison[],
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
  if (allLines.length === 0) return none(["The request has no lines."]);
  // Lines no price could be compared on are left out of the totals, and the reasons say so.
  const left = allLines
    .filter((l) => !l.compared)
    .map(
      (l) =>
        `Line ${l.lineNo} (${l.description}) is left out of the totals: ${(l.note ?? "its prices can't be compared").replace(/\.$/, "").replace(/^Not compared: /, "")}.`,
    );
  const lines = allLines.filter((l) => l.compared);
  if (lines.length === 0) return none(left);

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
            ...left,
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
      reasons: [...reasons, ...left],
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
        ...left,
      ],
    };
  }
  return none([
    ...lines
      .filter((l) => l.best === null || l.best.cost === null)
      .map(
        (l) =>
          `Line ${l.lineNo} (${l.description}) has no price we can compare${l.note ? `: ${l.note.replace(/\.$/, "").toLowerCase()}` : ""}.`,
      ),
    ...left,
  ]);
}

/** Loads a request's received quotes and compares them. */
export async function compareQuotes(
  db: Db,
  ctx: PurchasingContext,
  input: { requestId: string; asOf: string; splitMinSavingPct?: number | undefined },
): Promise<Comparison> {
  return withTenant(db, ctx.tenantId, (tx: Tx) => compareQuotesTx(tx, ctx, input));
}

/** P-9: the same, in a transaction already scoped to the client (a screen's or a card's). */
export async function compareQuotesTx(
  tx: Tx,
  ctx: Pick<PurchasingContext, "tenantId">,
  input: { requestId: string; asOf: string; splitMinSavingPct?: number | undefined },
): Promise<Comparison> {
  {
    const r = await requestRow(tx, ctx.tenantId, input.requestId);
    const lines = await requestLines(tx, ctx.tenantId, r.id);
    // P-9 (0036): quotes are asked for lines that say how many; a line added without one since
    // can't be compared until it does.
    const noQty = lines.filter((l) => l.row.qty === null).map((l) => l.row.lineNo);
    if (noQty.length > 0) {
      throw new PurchasingError("invalid", `line ${noQty.join(", ")} has no quantity yet`);
    }
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
    // Each quoted quantity in standard units, by the rule its price was converted by
    // (`quotedConversion`: the vendor's words or its one vendor item in that unit word).
    const vendorOf = new Map(quotes.map(({ q }) => [q.id, q.vendorId]));
    const byLine = new Map(lines.map((l) => [l.row.id, l]));
    const offerQtyStd = new Map<string, string | null>();
    for (const o of offers) {
      const asked = byLine.get(o.purchaseRequestLineId);
      const vendorId = vendorOf.get(o.quoteRequestId);
      if (!asked?.item || !vendorId || o.qty === null || o.unitPriceStd === null) continue;
      const vi = await vendorItemForUnit(tx, ctx.tenantId, {
        vendorId,
        catalogItemId: asked.item.id,
        unitRaw: o.unit,
      });
      const conv = quotedConversion(asked.item, o, asked.row, vi);
      offerQtyStd.set(o.id, conv.ok ? toNumeric(dec(o.qty).times(conv.factor)) : null);
    }
    return compareOffers({
      requestId: r.id,
      neededBy: r.neededBy,
      asOf: input.asOf,
      splitMinSavingPct: input.splitMinSavingPct,
      lines: lines.map(({ row, item }) => {
        // DECISION (review of fix/materials, finding 2): the request converts by the same rule as
        // quotes and invoices (`convertLine`): its own words, never the master item's pack size.
        let qtyStd: string | null = null;
        if (item) {
          const conv = convertLine(
            row.unit,
            item.standardUom,
            parseLine(row.description).attributes,
            item.attributes as Record<string, unknown>,
          );
          if (conv.ok) qtyStd = toNumeric(dec(row.qty as string).times(conv.factor));
        }
        return {
          id: row.id,
          lineNo: row.lineNo,
          description: row.description,
          qty: row.qty as string,
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
        qtyStd: offerQtyStd.get(o.id) ?? null,
        leadTimeDays: o.leadTimeDays,
        available: o.available,
      })),
    });
  }
}
