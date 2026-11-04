// What a client has used in a billing period (docs/plan.md §1.24): the `usage_daily` rollup priced
// with the operator's unit costs, rounded up per day into credits, against the pooled allowance of
// its active client agents. Read inside the caller's transaction, so the same code serves the
// back office (operator scope), the portal (one client) and the daily job (one client).

import {
  allowanceFor,
  billingPeriod,
  costAmount,
  type MeasureTotals,
  overageCredits,
  periodCredits,
  readTenantBilling,
  type TenantBilling,
  type UnitCost,
} from "@countersign/core";
import {
  agent,
  billingSetting,
  billingUnitCost,
  billingUsageReport,
  type Tx,
  tenant,
  usageDaily,
} from "@countersign/db";
import { and, eq, getTableColumns, gte, lte, type SQL, sql } from "drizzle-orm";
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

// ── Measures: usage_daily's columns ─────────────────────────────────────────────────────────────

/** The rollup table, or (in tests) a stand-in with more measure columns. */
export type UsageTable = PgTable & { tenantId: PgColumn; day: PgColumn };

const KEY_COLUMNS = new Set(["tenant_id", "day", "agent_id"]);

/**
 * Every measure `usage_daily` has: each column but the key, by its SQL name. A column added by a
 * later migration (`messages`, `call_seconds`) is a measure as soon as the schema has it, and is
 * billed once it has a unit cost: no code names a measure.
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

/** A client's per-day totals of the priced measures between two days (inclusive). */
export async function dailyTotals(
  tx: Tx,
  input: { tenantId: string; from: string; to: string; unitCosts: readonly UnitCost[] },
  table: UsageTable = usageDaily,
): Promise<{ day: string; totals: MeasureTotals }[]> {
  const priced = new Set(input.unitCosts.map((u) => u.measure));
  const cols = usageMeasures(table).filter((m) => priced.has(m.measure));
  if (cols.length === 0) return [];
  // Sums come back as numeric text: nothing passes through a JS float.
  const fields: Record<string, SQL<string>> = { day: sql<string>`${table.day}::text` };
  cols.forEach((c, i) => {
    fields[`m${i}`] = sql<string>`coalesce(sum(${c.column}), 0)::text`;
  });
  const rows = (await tx
    .select(fields)
    .from(table)
    .where(
      and(eq(table.tenantId, input.tenantId), gte(table.day, input.from), lte(table.day, input.to)),
    )
    .groupBy(table.day)) as Record<string, string>[];
  return rows.map((r) => ({
    day: r.day as string,
    totals: Object.fromEntries(cols.map((c, i) => [c.measure, r[`m${i}`] ?? "0"])),
  }));
}

// ── Agents ───────────────────────────────────────────────────────────────────────────────────────

/** A client's billed agents: client agents running now (not paused, retired, drafts or copies). */
// DECISION: the base fee counts client agents whose run status is `active` (owner: "per active
// client agent"); a paused agent is not billed until it is activated again.
export async function activeAgentCount(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(agent)
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.testCopy, false),
        eq(agent.status, "active"),
        eq(agent.runStatus, "active"),
      ),
    );
  return Number(row?.n ?? "0");
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

// ── The period ───────────────────────────────────────────────────────────────────────────────────

export interface ClientPeriod {
  period: { start: string; end: string; through: string };
  activeAgents: number;
  allowance: number;
  credits: number;
  overage: number;
  /** What the period's work cost us through `through`, as priced (numeric(14,4) text). */
  cost: string;
  /** Overage credits reported (or being reported) to Stripe this period. */
  reported: number;
}

/** A client's billing period through a day: credits, allowance, overage, what was reported. */
export async function clientPeriod(
  tx: Tx,
  input: { tenantId: string; through: string; config: BillingConfig },
  table: UsageTable = usageDaily,
): Promise<ClientPeriod> {
  const { start, end } = billingPeriod(input.through);
  const days = await dailyTotals(
    tx,
    { tenantId: input.tenantId, from: start, to: input.through, unitCosts: input.config.unitCosts },
    table,
  );
  const priced = periodCredits(days, input.config.unitCosts);
  const activeAgents = await activeAgentCount(tx, input.tenantId);
  const allowance = allowanceFor(activeAgents, input.config.settings.allowanceCreditsPerAgent);
  const [reported] = await tx
    .select({ n: sql<string>`coalesce(sum(${billingUsageReport.quantity}), 0)::text` })
    .from(billingUsageReport)
    .where(
      and(eq(billingUsageReport.tenantId, input.tenantId), eq(billingUsageReport.period, start)),
    );
  return {
    period: { start, end, through: input.through },
    activeAgents,
    allowance,
    credits: priced.credits,
    overage: overageCredits(priced.credits, allowance),
    cost: costAmount(priced.cost),
    reported: Number(reported?.n ?? "0"),
  };
}
