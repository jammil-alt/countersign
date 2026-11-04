// Billing arithmetic (docs/plan.md §1.17, §1.24). One credit is one cent of what the work cost us:
// each usage measure (a `usage_daily` column: model cost in USD, messages, call seconds, …) is
// priced with its unit cost, a client's day is summed and rounded up to whole credits, and the
// period's credits beyond the allowance are billed as overage. All of it in decimal.js, never JS
// floats (invariant 6). The settings (unit costs, allowance, prices) are the operator's, never
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

/** The pooled allowance: every active client agent brings its credits to the client's pool. */
// DECISION: a client's allowances are pooled across its agents (owner's simplest default).
export function allowanceFor(activeAgents: number, creditsPerAgent: number): number {
  return Math.max(0, activeAgents) * Math.max(0, creditsPerAgent);
}

/** Credits beyond the allowance; none while within it. */
export function overageCredits(used: number, allowance: number): number {
  return Math.max(0, used - allowance);
}

/**
 * What to report now: the overage not reported yet. Never negative: usage reported to Stripe is
 * not taken back (a later drop, e.g. a new agent raising the allowance, reports nothing).
 */
export function usageIncrement(overage: number, alreadyReported: number): number {
  return Math.max(0, overage - alreadyReported);
}

/** A cost in USD to money's 4 places, for the database and the back office. */
export function costAmount(cost: DecimalInput): string {
  return toNumeric(cost);
}

// ── Periods ──────────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The billing period holding `day`: its calendar month in UTC (both ends inclusive). */
// DECISION: billing periods are calendar months in UTC, like usage_daily's days; subscriptions are
// anchored to the 1st of the month so Stripe's periods line up.
export function billingPeriod(day: string): { start: string; end: string } {
  const start = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start: isoDay(start), end: isoDay(new Date(next.getTime() - DAY_MS)) };
}

/** The UTC day before `at`'s: what the daily report covers. */
export function reportDay(at: Date): string {
  return isoDay(new Date(at.getTime() - DAY_MS));
}

/** Midnight UTC on the 1st of the month after `at` (Unix seconds): the subscription's anchor. */
export function nextPeriodAnchor(at: Date): number {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return Math.floor(d.getTime() / 1000);
}

/** The last second of a UTC day (Unix seconds): the reported usage's timestamp. */
export function endOfDaySeconds(day: string): number {
  return Math.floor(new Date(`${day}T23:59:59.000Z`).getTime() / 1000);
}

/** The meter event's identifier (and idempotency key) for a client, period and day. */
export function usageReportIdentifier(tenantId: string, period: string, day: string): string {
  return `mezonas:${tenantId}:${period}:${day}`;
}

// ── A client's billing record (tenant.settings.billing) ─────────────────────────────────────────

/** The Stripe ids of a client set up for billing, kept in `tenant.settings.billing`. */
export const TenantBilling = z.object({
  customerId: z.string(),
  subscriptionId: z.string().nullable(),
  /** The subscription items: the base fee (quantity = active client agents) and the overage. */
  baseItemId: z.string().nullable(),
  overageItemId: z.string().nullable(),
  /** The base quantity Stripe has: active client agents when last synced. */
  quantity: z.number().int().min(0),
  subscriptionStatus: z.string().nullable(),
  /** The `created` time of the last subscription event applied, so older events are ignored. */
  subscriptionEventAt: z.number().int().nullable().default(null),
  lastInvoice: z
    .object({
      id: z.string(),
      number: z.string().nullable(),
      status: z.enum(["paid", "payment_failed"]),
      total: DecimalString.nullable(),
      currency: z.string().nullable(),
      at: z.string(),
    })
    .nullable()
    .default(null),
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
