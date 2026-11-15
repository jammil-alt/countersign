// The contract check (docs/plan.md §1.104): the price check's rules for a vendor with a contract,
// as pure functions beside OBSERVATION_RULES (./rules.ts). An invoice is checked against the
// contract that holds on its date: each priced line against the item's agreed price (in the
// item's standard unit, never across units without a conversion: invariant 7), each line's item
// against the contract's items, and the invoice's payment terms and freight against the
// contract's. Every alert carries its evidence (invariant 10) and, where money is at stake, its
// dollar impact; the same alert table, dedupe and test-run behaviour as the price rules.

import { Decimal, dec, formatAmount, toNumeric } from "@countersign/core";
import type { FreightTerm, StandardUom } from "../schema";
import type { AlertDraft, Names, Observation } from "./rules";

export const CONTRACT_ALERT_KINDS = [
  "above_contract",
  // Owner, 2026-11-15: every variance is noted.
  "below_contract",
  "within_tolerance",
  "not_on_contract",
  "contract_not_in_effect",
  "terms_mismatch",
] as const;
export type ContractAlertKind = (typeof CONTRACT_ALERT_KINDS)[number];

/** A vendor's contract as the rules see it (`vendor_contract`). */
export interface ContractTerms {
  id: string;
  vendorId: string;
  name: string;
  /** yyyy-mm-dd */
  effectiveFrom: string;
  effectiveTo: string | null;
  paymentTerms: string | null;
  netDays: number | null;
  earlyPayDiscountPct: string | null;
  earlyPayDays: number | null;
  freight: FreightTerm;
  minOrderAmount: string | null;
  currency: string;
  documentId: string | null;
  sources: string[];
}

/** One item's agreed price under a contract (a vendor item whose list price names it). */
export interface ContractPrice {
  vendorItemId: string;
  catalogItemId: string;
  /** The agreed price in the vendor's unit. */
  price: string;
  vendorUom: string | null;
  stdPerVendorUom: string | null;
  /** The client's tolerance on it (0052): an amount in the vendor's unit, a percent. */
  toleranceAmount?: string | null | undefined;
  tolerancePct?: string | null | undefined;
}

/** What an invoice says about its terms (its latest reading). */
export interface InvoiceTerms {
  documentId: string;
  extractionId: string;
  invoiceNumber: string | null;
  /** yyyy-mm-dd */
  invoiceDate: string;
  dueDate: string | null;
  paymentTerms: string | null;
  freight: string;
  currency: string;
}

/** The contract that holds on `day`: the latest to start on or before it, not yet ended. */
export function contractOn(contracts: readonly ContractTerms[], day: string): ContractTerms | null {
  const holding = contracts
    .filter((c) => c.effectiveFrom <= day && (c.effectiveTo === null || c.effectiveTo >= day))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return holding[0] ?? null;
}

/**
 * The agreed price per standard unit: the price itself when the vendor prices in the item's
 * standard unit (or names no unit), else through the vendor item's `std_per_vendor_uom`; null
 * when no conversion is known (never guessed, invariant 7).
 */
export function agreedPriceStd(p: ContractPrice, standardUom: StandardUom): Decimal | null {
  const unit = p.vendorUom?.trim().toLowerCase() ?? null;
  if (unit === null || unit === "" || unit === standardUom) return dec(p.price);
  if (p.stdPerVendorUom && dec(p.stdPerVendorUom).greaterThan(0)) {
    return dec(p.price).dividedBy(p.stdPerVendorUom);
  }
  return null;
}

/** Payment terms as words: net days, and an early-pay discount (percent within days). */
export interface ReadTerms {
  netDays: number | null;
  discountPct: string | null;
  discountDays: number | null;
}

// DECISION: payment terms are read from their usual spellings only: "Net 30", "N30", "2% 10 net
// 30", "2/10 net 30", "due on receipt" (0 days). Anything else reads as unknown, and an unknown
// term is never a mismatch (deterministic first: nothing is guessed).
export function readTerms(text: string | null | undefined): ReadTerms {
  const out: ReadTerms = { netDays: null, discountPct: null, discountDays: null };
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return out;
  if (/due (on|upon) receipt|cash on delivery|\bcod\b/.test(t)) out.netDays = 0;
  const net = t.match(/\bn(?:et)?\s*[-/]?\s*(\d{1,3})\b/);
  if (net?.[1]) out.netDays = Number(net[1]);
  const discount =
    t.match(/(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:in\s*|within\s*)?(\d{1,3})\s*(?:days?)?/) ??
    t.match(/\b(\d{1,2}(?:\.\d{1,2})?)\s*\/\s*(\d{1,3})\b/);
  if (discount?.[1] && discount[2]) {
    out.discountPct = dec(discount[1]).toFixed(2);
    out.discountDays = Number(discount[2]);
  }
  return out;
}

/** Whole days from one yyyy-mm-dd to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const usd = (v: Decimal | string) => `$${formatAmount(v)}`;
const contractEvidence = (c: ContractTerms) => [
  c.id,
  ...(c.documentId ? [c.documentId] : []),
  ...c.sources,
];
const lineEvidence = (o: Observation) => [o.id, ...(o.docLineId ? [o.docLineId] : [])];
const unique = (ids: string[]) => [...new Set(ids)];

/** `contract_not_in_effect`: the vendor has contracts, none holds on the invoice's date. */
export function contractNotInEffect(input: {
  vendorId: string;
  vendorName: string;
  contracts: readonly ContractTerms[];
  invoice: InvoiceTerms;
}): AlertDraft | null {
  const { contracts, invoice } = input;
  if (contracts.length === 0 || contractOn(contracts, invoice.invoiceDate)) return null;
  // The nearest: the last to end before the invoice, else the first to start after it.
  const before = contracts
    .filter((c) => c.effectiveTo !== null && c.effectiveTo < invoice.invoiceDate)
    .sort((a, b) => (b.effectiveTo ?? "").localeCompare(a.effectiveTo ?? ""))[0];
  const after = contracts
    .filter((c) => c.effectiveFrom > invoice.invoiceDate)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  const near = (before ?? after) as ContractTerms;
  const expired = near === before;
  return {
    kind: "contract_not_in_effect",
    severity: "warning",
    catalogItemId: null,
    vendorId: input.vendorId,
    title: expired
      ? `${input.vendorName}'s contract had ended by this invoice`
      : `${input.vendorName}'s contract hadn't started by this invoice`,
    body: expired
      ? `The invoice is dated ${invoice.invoiceDate}; "${near.name}" ended on ${near.effectiveTo}. Its prices and terms were not checked.`
      : `The invoice is dated ${invoice.invoiceDate}; "${near.name}" starts on ${near.effectiveFrom}. Its prices and terms were not checked.`,
    evidence: unique([invoice.documentId, invoice.extractionId, ...contractEvidence(near)]),
    dollarImpact: null,
    facts: {
      contractId: near.id,
      invoiceDate: invoice.invoiceDate,
      effectiveFrom: near.effectiveFrom,
      effectiveTo: near.effectiveTo,
      expired,
    },
  };
}

// DECISION: a line varies from its agreed price when the difference on this invoice (per standard
// unit, times the line's quantity) is at least a cent either way, so a conversion's rounding never
// raises one. Its dollar impact is that amount: positive to claim back, negative a saving.
const MIN_VARIANCE = dec("0.01");

/**
 * The client's allowance per standard unit on an agreed price: its amount (in the vendor's unit,
 * converted as the price is) or its percent of the agreed price, whichever allows more. Zero when
 * the item has none.
 */
// DECISION (owner, 2026-11-15: "tolerance at an item level"): a vendor item may carry an amount, a
// percent, or both; with both, the larger allowance holds (each is something the client accepts).
// An amount with no conversion to the line's unit counts as none (invariant 7).
export function toleranceStd(
  p: ContractPrice,
  agreedStd: Decimal,
  standardUom: StandardUom,
): Decimal {
  const pct = p.tolerancePct ? agreedStd.abs().times(p.tolerancePct).dividedBy(100) : dec("0");
  const amount = p.toleranceAmount
    ? (agreedPriceStd({ ...p, price: p.toleranceAmount }, standardUom) ?? dec("0"))
    : dec("0");
  return Decimal.max(pct, amount);
}

/**
 * The agreed-price rule (owner, 2026-11-15: "all variances should be highlighted"): a priced line
 * above its agreed price is `above_contract` (a warning); below it, `below_contract` (info, a
 * saving); either within the item's tolerance, `within_tolerance` (info, noted, with its
 * direction). Nothing for a difference under a cent on the invoice.
 */
// DECISION: three kinds rather than one with a direction, so each keeps its own severity and its
// own open alert per (kind, item, vendor): a note within tolerance never swallows a later
// variance outside it, and a saving never hides an overcharge.
export function contractVariance(
  current: Observation,
  agreed: ContractPrice | null,
  contract: ContractTerms,
  names: Names,
): AlertDraft | null {
  if (!agreed) return null;
  const agreedStd = agreedPriceStd(agreed, current.standardUom);
  if (agreedStd === null) return null;
  const perUnit = dec(current.unitPriceStd).minus(agreedStd);
  const variance = perUnit.times(current.qtyStd);
  if (variance.abs().lessThan(MIN_VARIANCE)) return null;
  const allowance = toleranceStd(agreed, agreedStd, current.standardUom);
  const within = perUnit.abs().lessThanOrEqualTo(allowance);
  const above = variance.greaterThan(0);
  const pct = agreedStd.isZero()
    ? null
    : perUnit.dividedBy(agreedStd).times(100).toDecimalPlaces(2);
  const item = names.item;
  const at = names.vendor(current.vendorId);
  const against = `${usd(current.unitPriceStd)} against ${usd(agreedStd)} agreed in "${contract.name}"`;
  const amount = usd(variance.abs());
  const toleranceWords = allowance.isZero() ? "" : ` (tolerance ${usd(allowance)})`;
  const kind = within ? "within_tolerance" : above ? "above_contract" : "below_contract";
  return {
    kind,
    severity: kind === "above_contract" ? "warning" : "info",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: within
      ? `${item} ${above ? "above" : "below"} the agreed price at ${at}, within tolerance`
      : `${item} ${above ? "above" : "below"} the agreed price at ${at}`,
    body: `${against}${toleranceWords}: ${amount} ${above ? "more" : "less"} on this invoice.`,
    evidence: unique([
      ...lineEvidence(current),
      agreed.vendorItemId,
      ...contractEvidence(contract),
    ]),
    dollarImpact: toNumeric(variance),
    facts: {
      contractId: contract.id,
      vendorItemId: agreed.vendorItemId,
      direction: above ? "above" : "below",
      withinTolerance: within,
      tolerance: toNumeric(allowance),
      agreed: toNumeric(agreedStd),
      current: current.unitPriceStd,
      changePct: pct?.toString() ?? null,
      qtyStd: current.qtyStd,
      standardUom: current.standardUom,
    },
  };
}

/** `not_on_contract`: the contract lists agreed prices, and this line's item isn't among them. */
export function notOnContract(
  current: Observation,
  agreed: ContractPrice | null,
  contract: ContractTerms,
  names: Names,
  contractHasPrices: boolean,
): AlertDraft | null {
  // DECISION: a contract with no item prices is terms only: its items are not checked.
  if (agreed || !contractHasPrices) return null;
  return {
    kind: "not_on_contract",
    severity: "info",
    catalogItemId: current.catalogItemId,
    vendorId: current.vendorId,
    title: `${names.item} isn't on ${names.vendor(current.vendorId)}'s contract`,
    body: `Bought at ${usd(current.unitPriceStd)}; "${contract.name}" has no agreed price for it.`,
    evidence: unique([...lineEvidence(current), ...contractEvidence(contract)]),
    dollarImpact: null,
    facts: {
      contractId: contract.id,
      current: current.unitPriceStd,
      standardUom: current.standardUom,
    },
  };
}

/**
 * `terms_mismatch`: the invoice's payment terms (its net days, from its terms or its due date, or
 * its early-pay discount) differ from the contract's, or it charges freight the contract includes.
 * One alert per term that differs; a term either side doesn't state is never a mismatch.
 */
export function termsMismatch(input: {
  vendorId: string;
  vendorName: string;
  contract: ContractTerms;
  invoice: InvoiceTerms;
}): AlertDraft[] {
  const { contract: c, invoice } = input;
  const out: AlertDraft[] = [];
  const evidence = unique([invoice.documentId, invoice.extractionId, ...contractEvidence(c)]);
  const which = invoice.invoiceNumber ? `invoice ${invoice.invoiceNumber}` : "the invoice";
  const read = readTerms(invoice.paymentTerms);
  // DECISION: the invoice's net days are its printed terms', else its due date less its date.
  const invoiceNet =
    read.netDays ?? (invoice.dueDate ? daysBetween(invoice.invoiceDate, invoice.dueDate) : null);
  if (c.netDays !== null && invoiceNet !== null && invoiceNet !== c.netDays) {
    const sooner = invoiceNet < c.netDays;
    out.push({
      kind: "terms_mismatch",
      // Asking to be paid sooner costs the client; later is in its favour.
      severity: sooner ? "warning" : "info",
      catalogItemId: null,
      vendorId: input.vendorId,
      title: `${input.vendorName}'s invoice asks for payment in ${invoiceNet} days, not ${c.netDays}`,
      body: `"${c.name}" gives ${c.netDays} days${c.paymentTerms ? ` (${c.paymentTerms})` : ""}; ${which} ${read.netDays !== null ? `says "${invoice.paymentTerms}"` : `is due ${invoice.dueDate}`}.`,
      evidence,
      dollarImpact: null,
      facts: {
        term: "payment",
        contractId: c.id,
        contractNetDays: c.netDays,
        invoiceNetDays: invoiceNet,
        invoiceTerms: invoice.paymentTerms,
        dueDate: invoice.dueDate,
      },
    });
  }
  if (c.earlyPayDiscountPct !== null && read.discountPct !== null) {
    const same =
      dec(read.discountPct).equals(c.earlyPayDiscountPct) && read.discountDays === c.earlyPayDays;
    if (!same) {
      out.push({
        kind: "terms_mismatch",
        severity: "warning",
        catalogItemId: null,
        vendorId: input.vendorId,
        title: `${input.vendorName}'s invoice offers a different early-pay discount`,
        body: `"${c.name}" gives ${dec(c.earlyPayDiscountPct).toString()}% within ${c.earlyPayDays} days; the invoice says "${invoice.paymentTerms}".`,
        evidence,
        dollarImpact: null,
        facts: {
          term: "discount",
          contractId: c.id,
          contractDiscountPct: c.earlyPayDiscountPct,
          contractDiscountDays: c.earlyPayDays,
          invoiceDiscountPct: read.discountPct,
          invoiceDiscountDays: read.discountDays,
        },
      });
    }
  }
  if (c.freight === "included" && dec(invoice.freight).greaterThan(0)) {
    out.push({
      kind: "terms_mismatch",
      severity: "warning",
      catalogItemId: null,
      vendorId: input.vendorId,
      title: `${input.vendorName} charged ${usd(invoice.freight)} freight the contract includes`,
      body: `"${c.name}" includes freight in its prices; ${which} charges ${usd(invoice.freight)} for it.`,
      evidence,
      dollarImpact: toNumeric(invoice.freight),
      facts: {
        term: "freight",
        contractId: c.id,
        documentId: invoice.documentId,
        freight: toNumeric(invoice.freight),
      },
    });
  }
  return out;
}

/** The per-line contract rules, in a fixed order (beside OBSERVATION_RULES). */
export const CONTRACT_RULES = [contractVariance, notOnContract] as const;

/**
 * Every contract alert for one invoice: whether a contract holds on its date, then each priced
 * line against it, then its terms. Lines whose item has no agreed price in a contract that lists
 * prices are named once each.
 */
export function checkContract(input: {
  vendorId: string;
  vendorName: string;
  contracts: readonly ContractTerms[];
  /** The agreed price of a priced line's item under the contract in effect, if it has one. */
  agreedFor: (line: Observation, contract: ContractTerms) => ContractPrice | null;
  /** Whether the contract lists any agreed prices (else it is terms only). */
  hasPrices: (contract: ContractTerms) => boolean;
  invoice: InvoiceTerms;
  lines: readonly Observation[];
  names: (catalogItemId: string) => Names;
}): { contract: ContractTerms | null; alerts: AlertDraft[] } {
  if (input.contracts.length === 0) return { contract: null, alerts: [] };
  const contract = contractOn(input.contracts, input.invoice.invoiceDate);
  if (!contract) {
    const off = contractNotInEffect(input);
    return { contract: null, alerts: off ? [off] : [] };
  }
  const alerts: AlertDraft[] = [];
  const hasPrices = input.hasPrices(contract);
  for (const o of input.lines) {
    const agreed = input.agreedFor(o, contract);
    const names = input.names(o.catalogItemId);
    const variance = contractVariance(o, agreed, contract, names);
    if (variance) alerts.push(variance);
    const missing = notOnContract(o, agreed, contract, names, hasPrices);
    if (missing) alerts.push(missing);
  }
  alerts.push(...termsMismatch({ ...input, contract }));
  return { contract, alerts };
}

/** The dedupe key of a contract alert (`dedupeKey` in ./rules.ts calls it). */
// DECISION: one open alert per (kind, item, vendor) for a line's, as the price rules; per (vendor,
// contract) for a contract not in effect; per (vendor, term) for payment terms and the discount,
// which stand until the contract or the vendor changes; and per invoice for freight, since each
// invoice's freight is its own money to claim back.
export function contractDedupeKey(a: AlertDraft): string {
  switch (a.kind as ContractAlertKind) {
    case "contract_not_in_effect":
      return `materials:contract_not_in_effect:${a.vendorId}:${String(a.facts.contractId)}`;
    case "terms_mismatch":
      return a.facts.term === "freight"
        ? `materials:terms_mismatch:${a.vendorId}:freight:${String(a.facts.documentId)}`
        : `materials:terms_mismatch:${a.vendorId}:${String(a.facts.term)}`;
    default:
      return `materials:${a.kind}:${a.catalogItemId}:${a.vendorId}`;
  }
}
