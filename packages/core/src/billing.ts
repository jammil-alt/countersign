// Billing arithmetic (docs/plan.md §1.17, §1.24, §1.32). One credit is one cent of what the work
// cost us: each usage measure (a `usage_daily` column: model cost in USD, messages, call seconds,
// …) is priced with its unit cost, and a client's day is summed and rounded up to whole credits.
// Mezonas works out each bill (§1.32): agents' monthly prices prorated by the days they were
// active, their credits pooled, and the credits beyond the pool at the credit price. All of it in
// decimal.js, never JS floats (invariant 6). Prices and settings are the operator's, never
// constants here.

import { z } from "zod";
import { Decimal, type DecimalInput, DecimalString, dec, toNumeric } from "./money";

/** A measure is named after its `usage_daily` column (SQL name): `cost_usd`, `messages`, … */
export const MeasureName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, "a usage_daily column name: lowercase, digits, underscores");

/** What one unit of a measure costs us: `unitCost` (USD) per `perUnits` units. */
export const UnitCost = z.object({
  measure: MeasureName,
  unitCost: DecimalString.refine((v) => !v.startsWith("-"), "not negative"),
  perUnits: z.number().int().min(1).max(1_000_000),
});
export type UnitCost = z.infer<typeof UnitCost>;

/** One day's totals per measure, as decimal or integer strings (never floats). */
export type MeasureTotals = Readonly<Record<string, DecimalInput | number>>;

export interface PricedMeasure {
  measure: string;
  quantity: string;
  cost: string;
}

/**
 * What a day's measures cost us, in USD: each measure with a unit cost, priced; measures without
 * one count nothing and are listed as `unpriced`.
 */
export function priceMeasures(
  totals: MeasureTotals,
  unitCosts: readonly UnitCost[],
): { cost: Decimal; byMeasure: PricedMeasure[]; unpriced: string[] } {
  const byName = new Map(unitCosts.map((u) => [u.measure, u]));
  let cost = new Decimal(0);
  const byMeasure: PricedMeasure[] = [];
  const unpriced: string[] = [];
  for (const [measure, raw] of Object.entries(totals)) {
    const quantity = typeof raw === "number" ? new Decimal(String(raw)) : dec(raw);
    const u = byName.get(measure);
    if (!u) {
      if (!quantity.isZero()) unpriced.push(measure);
      continue;
    }
    const c = quantity.times(dec(u.unitCost)).div(u.perUnits);
    cost = cost.plus(c);
    byMeasure.push({ measure, quantity: quantity.toString(), cost: c.toString() });
  }
  return { cost, byMeasure, unpriced: unpriced.sort() };
}

/**
 * Whole credits for a cost in USD: one credit per cent, rounded up, so any work at all is at
 * least one credit; nothing (or a negative correction) is zero.
 */
// DECISION: credits are integers, rounded up per client per day (owner, 2026-11-04): a client's
// day is priced across all its agents and measures first, then rounded once, so many small runs
// don't each round up.
export function creditsForCost(costUsd: DecimalInput): number {
  const cents = dec(costUsd).times(100);
  if (cents.lte(0)) return 0;
  return cents.toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
}

export interface DayCredits {
  day: string;
  /** What the day's work cost us, as priced (USD, full precision). */
  cost: string;
  credits: number;
}

/** A period's days, each priced and rounded up, then summed. */
export function periodCredits(
  days: readonly { day: string; totals: MeasureTotals }[],
  unitCosts: readonly UnitCost[],
): { credits: number; cost: string; days: DayCredits[]; unpriced: string[] } {
  let credits = 0;
  let cost = new Decimal(0);
  const unpriced = new Set<string>();
  const out: DayCredits[] = [];
  for (const d of [...days].sort((a, b) => a.day.localeCompare(b.day))) {
    const priced = priceMeasures(d.totals, unitCosts);
    const c = creditsForCost(priced.cost);
    credits += c;
    cost = cost.plus(priced.cost);
    for (const m of priced.unpriced) unpriced.add(m);
    out.push({ day: d.day, cost: priced.cost.toString(), credits: c });
  }
  return { credits, cost: cost.toString(), days: out, unpriced: [...unpriced].sort() };
}

/** Credits beyond the allowance; none while within it. */
export function overageCredits(used: number, allowance: number): number {
  return Math.max(0, used - allowance);
}

/** A cost in USD to money's 4 places, for the database and the back office. */
export function costAmount(cost: DecimalInput): string {
  return toNumeric(cost);
}

// ── Periods ──────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** `YYYY-MM-DD` of a moment, in UTC. */
export function utcDayOf(at: Date): string {
  return isoDay(at);
}

/** The billing period holding `day`: its calendar month in UTC (both ends inclusive). */
// DECISION: billing periods are calendar months in UTC, like usage_daily's days.
export function billingPeriod(day: string): { start: string; end: string } {
  const start = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: isoDay(start), end: isoDay(new Date(next.getTime() - DAY_MS)) };
}

/** How many days the month holding `day` has (28 to 31). */
export function daysInMonth(day: string): number {
  const { end } = billingPeriod(day);
  return Number(end.slice(8, 10));
}

/** The first day of the month before `at`'s (UTC): the month a statement is built for on the 1st. */
export function previousPeriod(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1));
  return isoDay(d);
}

/** A period's first and last moments as Unix seconds (an invoice item's service period). */
export function periodSeconds(period: string): { start: number; end: number } {
  const { start, end } = billingPeriod(period);
  return {
    start: Math.floor(new Date(`${start}T00:00:00.000Z`).getTime() / 1000),
    end: Math.floor(new Date(`${end}T23:59:59.000Z`).getTime() / 1000),
  };
}

// ── Prices (docs/plan.md §1.32) ─────────────────────────────────────────────────────────────────

export const PRICE_SOURCES = ["override", "template", "platform", "default"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** A monthly price (USD, decimal string) and the credits it includes each month. */
export interface PricePoint {
  monthlyPrice: string;
  includedCredits: number;
}

export interface AgentPrice extends PricePoint {
  source: PriceSource;
}

/**
 * Templates whose client agents are the platform's own (the supervisor, §1.28): free and with no
 * credits unless the operator prices the template.
 */
// DECISION: platform agents are identified by their template's slug (a template has tenant_id
// null); only the supervisor is one today. The Builder and the coordinator never run as client
// agents, and the document clerk does a client's work, so it is billed.
export const PLATFORM_FREE_TEMPLATE_SLUGS: readonly string[] = ["supervisor"];

/**
 * What a client agent costs a month: its own override, else its template's price, else free for a
 * platform agent, else the defaults.
 */
export function resolveAgentPrice(input: {
  override: PricePoint | null;
  template: PricePoint | null;
  /** The slug of the template it was forked from (null for an agent with no template). */
  templateSlug: string | null;
  defaults: PricePoint;
}): AgentPrice {
  if (input.override) return { ...pricePoint(input.override), source: "override" };
  if (input.template) return { ...pricePoint(input.template), source: "template" };
  if (input.templateSlug && PLATFORM_FREE_TEMPLATE_SLUGS.includes(input.templateSlug)) {
    return { monthlyPrice: "0.0000", includedCredits: 0, source: "platform" };
  }
  return { ...pricePoint(input.defaults), source: "default" };
}

function pricePoint(p: PricePoint): PricePoint {
  return { monthlyPrice: toNumeric(p.monthlyPrice), includedCredits: p.includedCredits };
}

/** An amount rounded half up to whole cents, as `numeric(14,4)` text. */
export function toCents(value: DecimalInput): string {
  return dec(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(4);
}

// ── Statements (docs/plan.md §1.32) ─────────────────────────────────────────────────────────────

/** One day a client agent was active, with the price it had that day (`billing_agent_day`). */
export interface BilledDay extends PricePoint {
  agentId: string;
  agentName: string;
  day: string;
}

export interface AgentLineDetail {
  /** Days the agent was billed this month. */
  days: number;
  daysInMonth: number;
  /** Each price it had, with its days (one entry unless the price changed). */
  prices: { monthlyPrice: string; days: number }[];
  /** The credits it brings to the pool: its credits × days ÷ days in the month, unrounded. */
  credits: string;
}

export interface UsageLineDetail {
  creditsUsed: number;
  creditsIncluded: number;
  extraCredits: number;
  creditPrice: string;
}

export type BuiltLine =
  | {
      kind: "agent";
      agentId: string;
      description: string;
      amount: string;
      detail: AgentLineDetail;
    }
  | {
      kind: "usage";
      agentId: null;
      description: string;
      amount: string;
      detail: UsageLineDetail;
    };

export interface BuiltStatement {
  period: { start: string; end: string };
  daysInMonth: number;
  lines: BuiltLine[];
  creditsUsed: number;
  creditsIncluded: number;
  extraCredits: number;
  creditPrice: string;
  /** The lines' sum, `numeric(14,4)` text in whole cents. */
  total: string;
}

export const EXTRA_USAGE_DESCRIPTION = "Extra usage";

/**
 * A month's statement lines from the days its agents were billed and the credits it used:
 * one line per agent (the sum of its daily prices ÷ days in the month, half up to cents), and one
 * line for the credits past the pooled allowance at the credit price. Also the month so far, given
 * the days recorded so far.
 */
// DECISION: each agent line is rounded once (not each day), and the pooled allowance is rounded
// half up to whole credits once, over every agent's days.
export function buildStatement(input: {
  period: string;
  days: readonly BilledDay[];
  creditsUsed: number;
  creditPrice: string;
}): BuiltStatement {
  const period = billingPeriod(input.period);
  const dim = daysInMonth(period.start);
  const byAgent = new Map<string, BilledDay[]>();
  for (const d of input.days) {
    if (d.day < period.start || d.day > period.end) continue;
    const list = byAgent.get(d.agentId) ?? [];
    list.push(d);
    byAgent.set(d.agentId, list);
  }
  const agentLines: Extract<BuiltLine, { kind: "agent" }>[] = [];
  let pooled = new Decimal(0);
  for (const [agentId, days] of byAgent) {
    days.sort((a, b) => a.day.localeCompare(b.day));
    let priceDays = new Decimal(0);
    let creditDays = new Decimal(0);
    const prices = new Map<string, number>();
    for (const d of days) {
      const p = toNumeric(d.monthlyPrice);
      priceDays = priceDays.plus(dec(p));
      creditDays = creditDays.plus(new Decimal(d.includedCredits));
      prices.set(p, (prices.get(p) ?? 0) + 1);
    }
    const credits = creditDays.div(dim);
    pooled = pooled.plus(credits);
    agentLines.push({
      kind: "agent",
      agentId,
      description: days[days.length - 1]?.agentName ?? "Agent",
      amount: toCents(priceDays.div(dim)),
      detail: {
        days: days.length,
        daysInMonth: dim,
        prices: [...prices].map(([monthlyPrice, n]) => ({ monthlyPrice, days: n })),
        credits: credits.toDecimalPlaces(4).toFixed(4),
      },
    });
  }
  agentLines.sort(
    (a, b) => a.description.localeCompare(b.description) || a.agentId.localeCompare(b.agentId),
  );
  const creditsIncluded = pooled.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  const creditsUsed = Math.max(0, input.creditsUsed);
  const extraCredits = overageCredits(creditsUsed, creditsIncluded);
  const creditPrice = toNumeric(input.creditPrice);
  const usage: Extract<BuiltLine, { kind: "usage" }> = {
    kind: "usage",
    agentId: null,
    description: EXTRA_USAGE_DESCRIPTION,
    amount: toCents(new Decimal(extraCredits).times(dec(creditPrice))),
    detail: { creditsUsed, creditsIncluded, extraCredits, creditPrice },
  };
  const lines: BuiltLine[] = [...agentLines, usage];
  return {
    period,
    daysInMonth: dim,
    lines,
    creditsUsed,
    creditsIncluded,
    extraCredits,
    creditPrice,
    total: sumAmounts(lines.map((l) => l.amount)),
  };
}

/** Line amounts summed, `numeric(14,4)` text. */
export function sumAmounts(amounts: readonly string[]): string {
  return toNumeric(amounts.reduce((s, a) => s.plus(dec(a)), new Decimal(0)));
}

/**
 * The Idempotency-Key of one step of sending a statement to Stripe:
 * `mezonas:<statement id>:<step>[:<line id>]`.
 */
export function statementStripeKey(
  statementId: string,
  step: "invoice" | "item" | "finalize" | "send",
  lineId?: string,
): string {
  return `mezonas:${statementId}:${step}${lineId ? `:${lineId}` : ""}`;
}

/** An amount in whole cents (an integer), from `numeric(14,4)` text already rounded to cents. */
export function centsOf(amount: DecimalInput): number {
  const cents = dec(amount).times(100);
  if (!cents.isInteger()) throw new RangeError(`not a whole number of cents: ${String(amount)}`);
  return cents.toNumber();
}

// ── A client's billing record (tenant.settings.billing) ─────────────────────────────────────────

/**
 * A client set up for billing: its Stripe customer, kept in `tenant.settings.billing`. Since §1.32
 * nothing else is set up in Stripe; the subscription fields older rows carry are ignored.
 */
export const TenantBilling = z.object({
  customerId: z.string(),
  email: z.string().nullable().default(null),
  setUpAt: z.string(),
  setUpBy: z.string().nullable(),
});
export type TenantBilling = z.infer<typeof TenantBilling>;

/** A client's billing record from its settings, or null when billing isn't set up. */
export function readTenantBilling(settings: unknown): TenantBilling | null {
  const raw = (settings as { billing?: unknown } | null)?.billing;
  if (raw === undefined || raw === null) return null;
  const parsed = TenantBilling.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
