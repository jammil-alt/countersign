// The six price alert rules (ARCHITECTURE §12.4), as pure functions over price observations in the
// item's standard unit. Thresholds come from the skill settings on the agent's version, never from
// the model. Each alert carries its evidence (invariant 10) and its dollar impact: the change times
// the trailing 90-day quantity. Prices in different standard units are never compared (invariant 7).

import { type Decimal, dec, formatAmount, toNumeric } from "@countersign/core";
import type { StandardUom } from "../schema";

export const ALERT_KINDS = [
  "price_jump",
  "price_vs_avg",
  "vendor_spread",
  "price_creep",
  "new_fee",
  "outlier",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

// DECISION: defaults the architecture leaves open: a 5% change (its own figure), a vendor 10%
// cheaper, 8% creep over 90 days; trailing windows of 90 days; an outlier is more than 3 median
// absolute deviations from at least 5 earlier prices.
export const PRICE_DEFAULTS = {
  price_change_pct: 5,
  vendor_spread_pct: 10,
  creep_pct: 8,
} as const;
export const WINDOW_DAYS = 90;
export const OUTLIER_MADS = 3;
export const OUTLIER_MIN_HISTORY = 5;

export interface PriceSettings {
  priceChangePct: Decimal;
  vendorSpreadPct: Decimal;
  creepPct: Decimal;
}

function pctSetting(value: unknown, fallback: number): Decimal {
  const n = Number(value);
  return dec(String(Number.isFinite(n) && n > 0 && n <= 1000 ? n : fallback));
}

/** The thresholds from a step's resolved skill settings; nonsense falls back to the defaults. */
export function priceSettingsFrom(settings: Readonly<Record<string, unknown>>): PriceSettings {
  return {
    priceChangePct: pctSetting(settings.price_change_pct, PRICE_DEFAULTS.price_change_pct),
    vendorSpreadPct: pctSetting(settings.vendor_spread_pct, PRICE_DEFAULTS.vendor_spread_pct),
    creepPct: pctSetting(settings.creep_pct, PRICE_DEFAULTS.creep_pct),
  };
}

/** One recorded price, as the rules see it. */
export interface Observation {
  id: string;
  catalogItemId: string;
  vendorId: string;
  /** yyyy-mm-dd */
  observedOn: string;
  unitPriceStd: string;
  qtyStd: string;
  standardUom: StandardUom;
  docLineId: string | null;
}

export interface AlertDraft {
  kind: AlertKind;
  severity: "info" | "warning" | "critical";
  /** Null for a vendor's new fee. */
  catalogItemId: string | null;
  vendorId: string;
  title: string;
  body: string;
  evidence: string[];
  /** numeric(14,4), or null when it can't be measured. */
  dollarImpact: string | null;
  facts: Record<string, unknown>;
}

export interface Names {
  item: string;
  vendor(id: string): string;
}

const UNIT_WORD: Record<StandardUom, string> = {
  sheet: "sheet",
  board_foot: "board foot",
  linear_foot: "linear foot",
  each: "each",
  gallon: "gallon",
  quart: "quart",
};

const usd = (v: Decimal | string) => `$${formatAmount(v)}`;
const pct = (v: Decimal) => `${v.abs().toDecimalPlaces(1).toString()}%`;
const per = (o: Observation) =>
  o.standardUom === "each" ? "each" : `a ${UNIT_WORD[o.standardUom]}`;

/** The day `days` before a yyyy-mm-dd date. */
export function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const change = (from: string, to: string) => dec(to).minus(from).dividedBy(dec(from)).times(100);

const evidence = (...obs: Observation[]) => [
  ...new Set(obs.flatMap((o) => [o.id, ...(o.docLineId ? [o.docLineId] : [])])),
];

function sorted(obs: readonly Observation[]): Observation[] {
  return [...obs].sort((a, b) => a.observedOn.localeCompare(b.observedOn));
}

/** Same item, same vendor, same unit, on or before the current observation's day (not it). */
function sameVendorBefore(current: Observation, history: readonly Observation[]): Observation[] {
  return sorted(
    history.filter(
      (o) =>
        o.id !== current.id &&
        o.catalogItemId === current.catalogItemId &&
        o.vendorId === current.vendorId &&
        o.standardUom === current.standardUom &&
        o.observedOn <= current.observedOn,
    ),
  );
}

/** Quantity bought from this vendor in the 90 days ending on the observation, it included. */
export function trailingQty(current: Observation, history: readonly Observation[]): Decimal {
  const from = daysBefore(current.observedOn, WINDOW_DAYS);
  return [current, ...sameVendorBefore(current, history)]
    .filter((o) => o.observedOn >= from)
    .reduce((sum, o) => sum.plus(o.qtyStd), dec("0"));
}

const impact = (perUnit: Decimal, qty: Decimal) => toNumeric(perUnit.times(qty));

/** `price_jump`: up more than `price_change_pct` on the last price from the same vendor. */
// DECISION: price alerts are raised for increases only (they cost the client money); decreases
// show in Price watch's change column.
export function priceJump(
  current: Observation,
  history: readonly Observation[],
  settings: PriceSettings,
  names: Names,
): AlertDraft | null {
  const last = sameVendorBefore(current, history).at(-1);
  if (!last || dec(last.unitPriceStd).isZero()) return null;
  const c = change(last.unitPriceStd, current.unitPriceStd);
  if (!c.greaterThan(settings.priceChangePct)) return null;
  const perUnit = dec(current.unitPriceStd).minus(last.unitPriceStd);
  const qty = trailingQty(current, history);
  return {
    kind: "price_jump",
    severity: c.greaterThan(settings.priceChangePct.times(3)) ? "critical" : "warning",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `${names.item} up ${pct(c)} at ${names.vendor(current.vendorId)}`,
    body: `${usd(current.unitPriceStd)} ${per(current)} on ${current.observedOn}, up from ${usd(last.unitPriceStd)} on ${last.observedOn}. About ${usd(perUnit.times(qty))} more over the last 90 days' quantity.`,
    evidence: evidence(current, last),
    dollarImpact: impact(perUnit, qty),
    facts: {
      previous: last.unitPriceStd,
      current: current.unitPriceStd,
      changePct: c.toDecimalPlaces(2).toString(),
      thresholdPct: settings.priceChangePct.toString(),
      standardUom: current.standardUom,
    },
  };
}

/** `price_vs_avg`: more than `price_change_pct` over the vendor's trailing 90-day average. */
// DECISION: the average is the plain mean of the vendor's earlier prices in the window, and needs
// at least two of them (with one, it is the jump rule).
export function priceVsAverage(
  current: Observation,
  history: readonly Observation[],
  settings: PriceSettings,
  names: Names,
): AlertDraft | null {
  const from = daysBefore(current.observedOn, WINDOW_DAYS);
  const window = sameVendorBefore(current, history).filter((o) => o.observedOn >= from);
  if (window.length < 2) return null;
  const avg = window.reduce((s, o) => s.plus(o.unitPriceStd), dec("0")).dividedBy(window.length);
  if (avg.isZero()) return null;
  const c = dec(current.unitPriceStd).minus(avg).dividedBy(avg).times(100);
  if (!c.greaterThan(settings.priceChangePct)) return null;
  const perUnit = dec(current.unitPriceStd).minus(avg);
  const qty = trailingQty(current, history);
  return {
    kind: "price_vs_avg",
    severity: "warning",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `${names.item} ${pct(c)} over its 90-day average at ${names.vendor(current.vendorId)}`,
    body: `${usd(current.unitPriceStd)} ${per(current)} against an average of ${usd(avg)} over ${window.length} earlier purchases.`,
    evidence: evidence(current, ...window),
    dollarImpact: impact(perUnit, qty),
    facts: {
      average: toNumeric(avg),
      current: current.unitPriceStd,
      changePct: c.toDecimalPlaces(2).toString(),
      observations: window.length,
      thresholdPct: settings.priceChangePct.toString(),
      standardUom: current.standardUom,
    },
  };
}

/** `vendor_spread`: another vendor sold the same item in the same month for > `vendor_spread_pct` less. */
// DECISION: the spread is how much more this price is than the cheapest other vendor's latest
// price that month, as a share of that cheaper price; the impact is the difference on this line.
export function vendorSpread(
  current: Observation,
  history: readonly Observation[],
  settings: PriceSettings,
  names: Names,
): AlertDraft | null {
  const month = current.observedOn.slice(0, 7);
  const latestByVendor = new Map<string, Observation>();
  for (const o of sorted(history)) {
    if (
      o.catalogItemId !== current.catalogItemId ||
      o.vendorId === current.vendorId ||
      o.standardUom !== current.standardUom ||
      o.observedOn.slice(0, 7) !== month ||
      o.observedOn > current.observedOn
    ) {
      continue;
    }
    latestByVendor.set(o.vendorId, o);
  }
  let cheapest: Observation | null = null;
  for (const o of latestByVendor.values()) {
    if (!cheapest || dec(o.unitPriceStd).lessThan(cheapest.unitPriceStd)) cheapest = o;
  }
  if (!cheapest || dec(cheapest.unitPriceStd).isZero()) return null;
  const c = change(cheapest.unitPriceStd, current.unitPriceStd);
  if (!c.greaterThan(settings.vendorSpreadPct)) return null;
  const perUnit = dec(current.unitPriceStd).minus(cheapest.unitPriceStd);
  const other = names.vendor(cheapest.vendorId);
  return {
    kind: "vendor_spread",
    severity: "warning",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `${names.item} ${pct(c)} cheaper at ${other}`,
    body: `${names.vendor(current.vendorId)} charged ${usd(current.unitPriceStd)} ${per(current)}; ${other} charged ${usd(cheapest.unitPriceStd)} on ${cheapest.observedOn}.`,
    evidence: evidence(current, cheapest),
    dollarImpact: impact(perUnit, dec(current.qtyStd)),
    facts: {
      current: current.unitPriceStd,
      cheaper: cheapest.unitPriceStd,
      cheaperVendorId: cheapest.vendorId,
      spreadPct: c.toDecimalPlaces(2).toString(),
      thresholdPct: settings.vendorSpreadPct.toString(),
      standardUom: current.standardUom,
    },
  };
}

/** `price_creep`: up more than `creep_pct` over 90 days with no single step over `price_change_pct`. */
// DECISION: creep needs at least three prices from the vendor in the window (two is one step).
export function priceCreep(
  current: Observation,
  history: readonly Observation[],
  settings: PriceSettings,
  names: Names,
): AlertDraft | null {
  const from = daysBefore(current.observedOn, WINDOW_DAYS);
  const series = [
    ...sameVendorBefore(current, history).filter((o) => o.observedOn >= from),
    current,
  ];
  if (series.length < 3) return null;
  const first = series[0] as Observation;
  if (dec(first.unitPriceStd).isZero()) return null;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1] as Observation;
    const b = series[i] as Observation;
    if (dec(a.unitPriceStd).isZero()) return null;
    if (change(a.unitPriceStd, b.unitPriceStd).greaterThan(settings.priceChangePct)) return null;
  }
  const c = change(first.unitPriceStd, current.unitPriceStd);
  if (!c.greaterThan(settings.creepPct)) return null;
  const perUnit = dec(current.unitPriceStd).minus(first.unitPriceStd);
  const qty = trailingQty(current, history);
  return {
    kind: "price_creep",
    severity: "warning",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `${names.item} crept up ${pct(c)} at ${names.vendor(current.vendorId)}`,
    body: `${usd(first.unitPriceStd)} ${per(current)} on ${first.observedOn} to ${usd(current.unitPriceStd)} on ${current.observedOn}, in ${series.length - 1} small steps.`,
    evidence: evidence(...series),
    dollarImpact: impact(perUnit, qty),
    facts: {
      first: first.unitPriceStd,
      current: current.unitPriceStd,
      changePct: c.toDecimalPlaces(2).toString(),
      steps: series.length - 1,
      thresholdPct: settings.creepPct.toString(),
      standardUom: current.standardUom,
    },
  };
}

function median(values: Decimal[]): Decimal {
  const s = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as Decimal)
    : (s[mid - 1] as Decimal).plus(s[mid] as Decimal).dividedBy(2);
}

/** How many median absolute deviations `x` is from `values`; null with too little history. */
export function madDistance(x: Decimal, values: Decimal[]): Decimal | null {
  if (values.length < OUTLIER_MIN_HISTORY) return null;
  const m = median(values);
  // DECISION: when every earlier value is the same (MAD 0), 1% of the median stands in for it,
  // so a repeated price doesn't make every small change an outlier.
  const mad = median(values.map((v) => v.minus(m).abs()));
  const scale = mad.isZero() ? m.abs().times("0.01") : mad;
  if (scale.isZero()) return null;
  return x.minus(m).abs().dividedBy(scale);
}

/** `outlier`: the price or the quantity is more than 3 MADs from the item's history (all vendors). */
export function outlier(
  current: Observation,
  history: readonly Observation[],
  _settings: PriceSettings,
  names: Names,
): AlertDraft | null {
  const past = history.filter(
    (o) =>
      o.id !== current.id &&
      o.catalogItemId === current.catalogItemId &&
      o.standardUom === current.standardUom &&
      o.observedOn <= current.observedOn,
  );
  const priceMads = madDistance(
    dec(current.unitPriceStd),
    past.map((o) => dec(o.unitPriceStd)),
  );
  const qtyMads = madDistance(
    dec(current.qtyStd),
    past.map((o) => dec(o.qtyStd)),
  );
  const priceOut = priceMads?.greaterThan(OUTLIER_MADS) ?? false;
  const qtyOut = qtyMads?.greaterThan(OUTLIER_MADS) ?? false;
  if (!priceOut && !qtyOut) return null;
  const what = priceOut && qtyOut ? "price and quantity" : priceOut ? "price" : "quantity";
  return {
    kind: "outlier",
    severity: "info",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `Unusual ${what} for ${names.item} from ${names.vendor(current.vendorId)}`,
    body: `${current.qtyStd} at ${usd(current.unitPriceStd)} ${per(current)} is far from the ${past.length} earlier purchases of this item.`,
    evidence: evidence(current, ...past.slice(-5)),
    dollarImpact: null,
    facts: {
      price: current.unitPriceStd,
      qty: current.qtyStd,
      priceMads: priceMads?.toDecimalPlaces(2).toString() ?? null,
      qtyMads: qtyMads?.toDecimalPlaces(2).toString() ?? null,
      history: past.length,
      standardUom: current.standardUom,
    },
  };
}

/** The five rules over one observation, in a fixed order. */
export const OBSERVATION_RULES = [priceJump, priceVsAverage, vendorSpread, priceCreep, outlier];

export function checkObservation(
  current: Observation,
  history: readonly Observation[],
  settings: PriceSettings,
  names: Names,
): AlertDraft[] {
  return OBSERVATION_RULES.map((rule) => rule(current, history, settings, names)).filter(
    (a): a is AlertDraft => a !== null,
  );
}

/** A surcharge as an invoice prints it. */
export interface Fee {
  label: string;
  amount: string;
}

/** `FUEL SURCHARGE 3%` → `fuel surcharge`: what makes two fees the same type. */
export function feeType(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `new_fee`: a surcharge type the vendor's earlier invoices never had. The vendor's first invoice
 * sets the baseline, so it raises nothing.
 */
export function newFees(input: {
  vendorId: string;
  vendorName: string;
  fees: readonly Fee[];
  priorFeeTypes: readonly string[];
  priorInvoices: number;
  evidence: string[];
}): AlertDraft[] {
  if (input.priorInvoices === 0) return [];
  const seen = new Set(input.priorFeeTypes.map(feeType));
  const out: AlertDraft[] = [];
  for (const fee of input.fees) {
    const type = feeType(fee.label);
    if (!type || seen.has(type) || dec(fee.amount).lessThanOrEqualTo(0)) continue;
    seen.add(type);
    out.push({
      kind: "new_fee",
      severity: "warning",
      catalogItemId: null,
      vendorId: input.vendorId,
      title: `New fee from ${input.vendorName}: ${fee.label}`,
      body: `${usd(fee.amount)} for "${fee.label}", which none of their ${input.priorInvoices} earlier invoices had.`,
      evidence: input.evidence,
      dollarImpact: toNumeric(fee.amount),
      facts: { label: fee.label, feeType: type, amount: toNumeric(fee.amount) },
    });
  }
  return out;
}

/** One open alert per (kind, item, vendor); a fee's per (vendor, fee type). */
export function dedupeKey(a: AlertDraft): string {
  return a.kind === "new_fee"
    ? `materials:new_fee:${a.vendorId}:${String(a.facts.feeType)}`
    : `materials:${a.kind}:${a.catalogItemId}:${a.vendorId}`;
}
