// What a client is billed (docs/plan.md §1.24, §1.32): the `usage_daily` rollup priced with the
// operator's unit costs and rounded up per day into credits; each client agent's price (its own,
// its template's, the platform's $0 for the supervisor, or the default); and the days each agent
// was active, recorded hourly with the price it had. Read inside the caller's transaction, so the
// same code serves the back office (operator scope), the portal (one client) and the cron (one
// client).

import {
  type AgentPrice,
  type BilledDay,
  type BuiltStatement,
  billingPeriod,
  buildStatement,
  costAmount,
  Decimal,
  type MeasureTotals,
  PLATFORM_FREE_TEMPLATE_SLUGS,
  type PricePoint,
  periodCredits,
  readTenantBilling,
  resolveAgentPrice,
  type TenantBilling,
  type UnitCost,
} from "@countersign/core";
import {
  agent,
  billingAgentDay,
  billingAgentPrice,
  billingSetting,
  billingTemplatePrice,
  billingUnitCost,
  type Tx,
  tenant,
  usageDaily,
  usagePlatformDaily,
} from "@countersign/db";
import { and, eq, getTableColumns, gte, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type BillingSettingRow = typeof billingSetting.$inferSelect;

export interface BillingConfig {
  settings: BillingSettingRow;
  unitCosts: UnitCost[];
}

/** The billing settings and unit costs (global rows every session may read). */
export async function loadBillingConfig(tx: Pick<Tx, "select">): Promise<BillingConfig> {
  const [settings] = await tx.select().from(billingSetting).where(eq(billingSetting.id, 1));
  if (!settings) throw new Error("billing_setting has no row: run the migrations");
  const costs = await tx.select().from(billingUnitCost).orderBy(billingUnitCost.measure);
  return {
    settings,
    unitCosts: costs.map((c) => ({
      measure: c.measure,
      unitCost: c.unitCost,
      perUnits: c.perUnits,
    })),
  };
}

/** The defaults an agent with no price of its own or from its template gets. */
export function defaultPrice(config: BillingConfig): PricePoint {
  return {
    monthlyPrice: config.settings.defaultAgentPrice,
    includedCredits: config.settings.allowanceCreditsPerAgent,
  };
}

// ── Measures: usage_daily's columns ─────────────────────────────────────────────────────────────

/**
 * The rollup table, or (in tests) a stand-in with more measure columns. `usage_platform_daily`
 * (v0.12 W1-H) has no agent: its rows are the client's own usage (background reading).
 */
export type UsageTable = PgTable & { tenantId: PgColumn; day: PgColumn; agentId?: PgColumn };

const KEY_COLUMNS = new Set(["tenant_id", "day", "agent_id"]);

/**
 * Every measure `usage_daily` has: each column but the key, by its SQL name. A column added by a
 * later migration is a measure as soon as the schema has it, and is billed once it has a unit
 * cost: no code names a measure.
 */
// DECISION: credit conversion is generic over measures (measure name = usage_daily column name →
// unit cost setting), so texts, calls and any later tool are billable without a new rule.
export function usageMeasures(
  table: UsageTable = usageDaily,
): { measure: string; column: PgColumn }[] {
  return Object.values(getTableColumns(table) as Record<string, PgColumn>)
    .filter((c) => !KEY_COLUMNS.has(c.name))
    .map((c) => ({ measure: c.name, column: c }));
}

/**
 * A client's per-day totals of the priced measures between two days (inclusive), leaving out test
 * copies' usage (template test runs run as test copies, separate agents).
 */
// DECISION: a client agent's own test runs share its usage_daily rows and can't be told apart, so
// they are still billed (open for the owner, plan §1.32); test copies' usage is not.
export async function dailyTotals(
  tx: Tx,
  input: { tenantId: string; from: string; to: string; unitCosts: readonly UnitCost[] },
  table: UsageTable = usageDaily,
): Promise<{ day: string; totals: MeasureTotals }[]> {
  const agents = await tableTotals(tx, input, table);
  // v0.12 W1-H: the client's own usage (background reading, ARCHITECTURE §13) counts into
  // credits like its agents': same-named measures are added day by day, as decimals.
  const platform = await tableTotals(tx, input, usagePlatformDaily);
  if (platform.length === 0) return agents;
  const byDay = new Map(agents.map((d) => [d.day, { ...d.totals }]));
  for (const d of platform) {
    const totals = byDay.get(d.day) ?? {};
    for (const [measure, value] of Object.entries(d.totals)) {
      totals[measure] = new Decimal(totals[measure] ?? 0).plus(value).toString();
    }
    byDay.set(d.day, totals);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, totals]) => ({ day, totals }));
}

/** One rollup table's per-day totals of the priced measures. */
async function tableTotals(
  tx: Tx,
  input: { tenantId: string; from: string; to: string; unitCosts: readonly UnitCost[] },
  table: UsageTable,
): Promise<{ day: string; totals: Record<string, string> }[]> {
  const priced = new Set(input.unitCosts.map((u) => u.measure));
  const cols = usageMeasures(table).filter((m) => priced.has(m.measure));
  if (cols.length === 0 || input.from > input.to) return [];
  // Sums come back as numeric text: nothing passes through a JS float.
  const fields: Record<string, SQL<string>> = { day: sql<string>`${table.day}::text` };
  cols.forEach((c, i) => {
    fields[`m${i}`] = sql<string>`coalesce(sum(${c.column}), 0)::text`;
  });
  const rows = (await tx
    .select(fields)
    .from(table)
    .where(
      and(
        eq(table.tenantId, input.tenantId),
        gte(table.day, input.from),
        lte(table.day, input.to),
        table.agentId
          ? sql`${table.agentId} not in (select ${agent.id} from ${agent} where ${agent.tenantId} = ${input.tenantId} and ${agent.testCopy})`
          : undefined,
      ),
    )
    .groupBy(table.day)) as Record<string, string>[];
  return rows.map((r) => ({
    day: r.day as string,
    totals: Object.fromEntries(cols.map((c, i) => [c.measure, r[`m${i}`] ?? "0"])),
  }));
}

/** Credits a client used between two days (inclusive), and what that work cost us. */
export async function creditsBetween(
  tx: Tx,
  input: { tenantId: string; from: string; to: string; config: BillingConfig },
  table?: UsageTable,
): Promise<{ credits: number; cost: string }> {
  const days = await dailyTotals(
    tx,
    { tenantId: input.tenantId, from: input.from, to: input.to, unitCosts: input.config.unitCosts },
    table,
  );
  const priced = periodCredits(days, input.config.unitCosts);
  return { credits: priced.credits, cost: costAmount(priced.cost) };
}

// ── Prices ───────────────────────────────────────────────────────────────────────────────────────

/** Template prices (global) and which templates are the platform's own (free unless priced). */
export interface Pricing {
  defaults: PricePoint;
  templates: Map<string, PricePoint>;
  /** Template id → slug, for the platform's templates (the supervisor). */
  platform: Map<string, string>;
}

/**
 * Loads what prices a client agent. The platform's templates are template rows (tenant_id null),
 * which only an operator scope reads: pass one in `operatorTx` (the cron opens one; a back-office
 * request is one).
 */
export async function loadPricing(tx: Tx, operatorTx: Tx, config: BillingConfig): Promise<Pricing> {
  const rows = await tx.select().from(billingTemplatePrice);
  const platform = await operatorTx
    .select({ id: agent.id, slug: agent.slug })
    .from(agent)
    .where(and(isNull(agent.tenantId), inArray(agent.slug, [...PLATFORM_FREE_TEMPLATE_SLUGS])));
  return {
    defaults: defaultPrice(config),
    templates: new Map(
      rows.map((r) => [
        r.templateId,
        { monthlyPrice: r.monthlyPrice, includedCredits: r.includedCredits },
      ]),
    ),
    platform: new Map(platform.map((p) => [p.id, p.slug])),
  };
}

export type AgentRow = typeof agent.$inferSelect;
export type OverrideRow = typeof billingAgentPrice.$inferSelect;

/** A client agent's price from what `pricing` and its override say. */
export function priceOf(a: AgentRow, override: OverrideRow | null, pricing: Pricing): AgentPrice {
  return resolveAgentPrice({
    override: override
      ? { monthlyPrice: override.monthlyPrice, includedCredits: override.includedCredits }
      : null,
    template: a.templateId ? (pricing.templates.get(a.templateId) ?? null) : null,
    templateSlug: a.templateId ? (pricing.platform.get(a.templateId) ?? null) : null,
    defaults: pricing.defaults,
  });
}

/** The name a client knows an agent by: its service name, else its name. */
export const agentLabel = (a: AgentRow): string => a.serviceName ?? a.name;

/** A client's agents (not test copies, not discarded), with their overrides. */
export async function clientAgents(
  tx: Tx,
  tenantId: string,
): Promise<{ agent: AgentRow; override: OverrideRow | null }[]> {
  const rows = await tx
    .select()
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        eq(agent.status, "active"),
      ),
    )
    .orderBy(agent.name);
  const overrides = await tx
    .select()
    .from(billingAgentPrice)
    .where(eq(billingAgentPrice.tenantId, tenantId));
  const byAgent = new Map(overrides.map((o) => [o.agentId, o]));
  return rows.map((a) => ({ agent: a, override: byAgent.get(a.id) ?? null }));
}

/** Billed: a client agent running now (not paused, retired, a draft or a test copy). */
// DECISION: an agent is billed for a day when its run status is `active` at an hourly pass;
// paused and retired days are not billed (plan §1.32).
export const isActive = (a: AgentRow): boolean => a.status === "active" && a.runStatus === "active";

// ── The days agents were active ─────────────────────────────────────────────────────────────────

/**
 * Records today's row for each active client agent, with its price and credits now. The first
 * price seen in a day sticks (`on conflict do nothing`). Returns the rows it added.
 */
export async function recordAgentDays(
  tx: Tx,
  input: { tenantId: string; day: string; pricing: Pricing },
): Promise<number> {
  const agents = (await clientAgents(tx, input.tenantId)).filter((r) => isActive(r.agent));
  if (agents.length === 0) return 0;
  const added = await tx
    .insert(billingAgentDay)
    .values(
      agents.map(({ agent: a, override }) => {
        const p = priceOf(a, override, input.pricing);
        return {
          tenantId: input.tenantId,
          day: input.day,
          agentId: a.id,
          agentName: agentLabel(a),
          monthlyPrice: p.monthlyPrice,
          includedCredits: p.includedCredits,
          priceSource: p.source,
        };
      }),
    )
    .onConflictDoNothing()
    .returning({ agentId: billingAgentDay.agentId });
  return added.length;
}

/** The days a client's agents were billed in a month, up to `through`. */
export async function billedDays(
  tx: Tx,
  input: { tenantId: string; period: string; through?: string },
): Promise<BilledDay[]> {
  const { start, end } = billingPeriod(input.period);
  const rows = await tx
    .select()
    .from(billingAgentDay)
    .where(
      and(
        eq(billingAgentDay.tenantId, input.tenantId),
        gte(billingAgentDay.day, start),
        lte(billingAgentDay.day, input.through && input.through < end ? input.through : end),
      ),
    );
  return rows.map((r) => ({
    agentId: r.agentId,
    agentName: r.agentName,
    day: r.day,
    monthlyPrice: r.monthlyPrice,
    includedCredits: r.includedCredits,
  }));
}

/** The first day usage is billed for a client: the later of the month's start and its set-up. */
export function usageFrom(period: string, billing: TenantBilling | null): string {
  const start = billingPeriod(period).start;
  const setUp = billing?.setUpAt?.slice(0, 10);
  return setUp && setUp > start ? setUp : start;
}

/**
 * A month worked out from the days recorded and the credits used up to `through`: the month so
 * far, or (through its last day) the statement as it would be built.
 */
export async function monthFor(
  tx: Tx,
  input: {
    tenantId: string;
    period: string;
    through: string;
    config: BillingConfig;
    billing: TenantBilling | null;
  },
  table?: UsageTable,
): Promise<{ built: BuiltStatement; cost: string }> {
  const days = await billedDays(tx, input);
  const used = await creditsBetween(
    tx,
    {
      tenantId: input.tenantId,
      from: usageFrom(input.period, input.billing),
      to: input.through,
      config: input.config,
    },
    table,
  );
  const built = buildStatement({
    period: input.period,
    days,
    creditsUsed: used.credits,
    creditPrice: input.config.settings.creditPrice,
  });
  return { built, cost: used.cost };
}

// ── A client's billing record ───────────────────────────────────────────────────────────────────

export async function tenantBilling(
  tx: Tx,
  tenantId: string,
): Promise<{ name: string; billing: TenantBilling | null } | null> {
  const [row] = await tx
    .select({ name: tenant.name, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  return row ? { name: row.name, billing: readTenantBilling(row.settings) } : null;
}

/** Merges fields into `tenant.settings.billing` in one statement (other settings untouched). */
export async function patchTenantBilling(
  tx: Tx,
  tenantId: string,
  patch: Partial<TenantBilling>,
): Promise<void> {
  await tx
    .update(tenant)
    .set({
      settings: sql`jsonb_set(${tenant.settings}, '{billing}', coalesce(${tenant.settings} -> 'billing', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
    })
    .where(eq(tenant.id, tenantId));
}
