// Billing jobs (docs/plan.md §1.24): keep each client's base quantity equal to its active client
// agents, and once a day report the period's credits beyond the allowance to Stripe's meter,
// idempotently per client, period and day. They run on the cron (hourly, after the usage rollup)
// and, for the quantity, after an agent is activated, paused or retired. Stripe is reached only
// here and in the billing routes: it is Mezonas' infrastructure, never an agent tool.

import type { StripeClient } from "@countersign/connectors";
import {
  billingPeriod,
  endOfDaySeconds,
  readTenantBilling,
  reportDay,
  usageIncrement,
  usageReportIdentifier,
} from "@countersign/core";
import { billingUsageReport, type Db, type Tx, tenant, withTenant } from "@countersign/db";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import {
  activeAgentCount,
  type BillingConfig,
  clientPeriod,
  loadBillingConfig,
  patchTenantBilling,
  tenantBilling,
  type UsageTable,
} from "./ledger";

/** Runs work in a transaction scoped to the client: a fresh one (cron) or the request's own. */
export type Runner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export const tenantRunner =
  (db: Db, tenantId: string): Runner =>
  (fn) =>
    withTenant(db, tenantId, fn);

export const txRunner =
  (tx: Tx): Runner =>
  (fn) =>
    fn(tx);

export interface QuantitySync {
  before: number;
  after: number;
  changed: boolean;
}

/**
 * Sets the client's base quantity in Stripe to its active client agents, when they differ. Null
 * when the client isn't set up for billing.
 */
export async function syncAgentQuantity(
  run: Runner,
  stripe: StripeClient,
  tenantId: string,
): Promise<QuantitySync | null> {
  const state = await run(async (tx) => ({
    billing: (await tenantBilling(tx, tenantId))?.billing ?? null,
    count: await activeAgentCount(tx, tenantId),
  }));
  const item = state.billing?.baseItemId;
  if (!state.billing || !item) return null;
  const before = state.billing.quantity;
  if (before === state.count) return { before, after: before, changed: false };
  // Absolute, so a repeat (or a race with another sync) lands on the same number.
  await stripe.setItemQuantity(item, state.count);
  await run((tx) => patchTenantBilling(tx, tenantId, { quantity: state.count }));
  return { before, after: state.count, changed: true };
}

export type ReportRow = typeof billingUsageReport.$inferSelect;

/** Sends a pending (or earlier failed) report under its identifier, and records how it went. */
async function send(
  run: Runner,
  stripe: StripeClient,
  input: { row: ReportRow; customerId: string; eventName: string },
): Promise<ReportRow> {
  const { row } = input;
  let status: "sent" | "failed" = "sent";
  let error: string | null = null;
  try {
    await stripe.createMeterEvent({
      eventName: input.eventName,
      customerId: input.customerId,
      value: row.quantity,
      identifier: row.identifier,
      timestamp: endOfDaySeconds(row.day),
    });
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? e.message.slice(0, 500) : String(e);
  }
  const [updated] = await run((tx) =>
    tx
      .update(billingUsageReport)
      .set({ status, error, sentAt: status === "sent" ? new Date() : null })
      .where(and(eq(billingUsageReport.tenantId, row.tenantId), eq(billingUsageReport.id, row.id)))
      .returning(),
  );
  return updated ?? row;
}

export interface UsageReportResult {
  row: ReportRow;
  /** The day had a report already: nothing new was computed or sent. */
  repeated: boolean;
}

/**
 * Reports one day of a client's period: the overage credits through `day` not reported before.
 * A day reported before sends nothing new (a pending or failed one is retried under the same
 * identifier, which Stripe deduplicates). Null when the client isn't set up for billing.
 */
export async function reportUsage(
  run: Runner,
  stripe: StripeClient,
  input: { tenantId: string; day: string; config: BillingConfig },
  table?: UsageTable,
): Promise<UsageReportResult | null> {
  const { tenantId, day, config } = input;
  const period = billingPeriod(day).start;
  const prepared = await run(async (tx) => {
    const billing = (await tenantBilling(tx, tenantId))?.billing ?? null;
    if (!billing?.subscriptionId) return null;
    const where = and(
      eq(billingUsageReport.tenantId, tenantId),
      eq(billingUsageReport.period, period),
      eq(billingUsageReport.day, day),
    );
    const [existing] = await tx.select().from(billingUsageReport).where(where);
    if (existing) return { billing, row: existing, repeated: true };
    const p = await clientPeriod(tx, { tenantId, through: day, config }, table);
    const quantity = usageIncrement(p.overage, p.reported);
    const [inserted] = await tx
      .insert(billingUsageReport)
      .values({
        tenantId,
        period,
        day,
        agents: p.activeAgents,
        allowance: p.allowance,
        credits: p.credits,
        overage: p.overage,
        quantity,
        costUsd: p.cost,
        identifier: usageReportIdentifier(tenantId, period, day),
        status: quantity > 0 ? "pending" : "none",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { billing, row: inserted, repeated: false };
    // Another run reported the day between our read and our insert.
    const [raced] = await tx.select().from(billingUsageReport).where(where);
    return raced ? { billing, row: raced, repeated: true } : null;
  });
  if (!prepared) return null;
  let row = prepared.row;
  if ((row.status === "pending" || row.status === "failed") && row.quantity > 0) {
    row = await send(run, stripe, {
      row,
      customerId: prepared.billing.customerId,
      eventName: config.settings.meterEventName,
    });
  }
  return { row, repeated: prepared.repeated };
}

/** Retries a client's reports of the last 30 days that never reached Stripe. */
// DECISION: a report that failed is retried under its identifier on each hourly run for 30 days
// (Stripe accepts usage up to about 35 days back, NOTES.md); after that it needs the operator.
export async function retryUnsent(
  run: Runner,
  stripe: StripeClient,
  input: { tenantId: string; config: BillingConfig; now: Date },
): Promise<number> {
  const since = new Date(input.now.getTime() - 30 * 86_400_000);
  const state = await run(async (tx) => ({
    billing: (await tenantBilling(tx, input.tenantId))?.billing ?? null,
    rows: await tx
      .select()
      .from(billingUsageReport)
      .where(
        and(
          eq(billingUsageReport.tenantId, input.tenantId),
          inArray(billingUsageReport.status, ["pending", "failed"]),
          gte(billingUsageReport.createdAt, since),
        ),
      )
      .orderBy(desc(billingUsageReport.day)),
  }));
  if (!state.billing) return 0;
  let sent = 0;
  for (const row of state.rows) {
    const done = await send(run, stripe, {
      row,
      customerId: state.billing.customerId,
      eventName: input.config.settings.meterEventName,
    });
    if (done.status === "sent") sent += 1;
  }
  return sent;
}

/** The cron's hourly billing pass (at the usage sweep's minute, after the rollup). */
export async function billingTick(
  deps: { db: Db; stripe: StripeClient | null },
  at: Date,
): Promise<void> {
  if (!deps.stripe) return;
  const stripe = deps.stripe;
  // The tenant table is global: the clients set up for billing are found without a client scope.
  const clients = await deps.db
    .select({ id: tenant.id, settings: tenant.settings })
    .from(tenant)
    .where(isNotNull(sql`${tenant.settings} -> 'billing' ->> 'subscriptionId'`));
  if (clients.length === 0) return;
  const config = await loadBillingConfig(deps.db);
  const day = reportDay(at);
  for (const client of clients) {
    if (!readTenantBilling(client.settings)) continue;
    const run = tenantRunner(deps.db, client.id);
    try {
      await syncAgentQuantity(run, stripe, client.id);
      await reportUsage(run, stripe, { tenantId: client.id, day, config });
      await retryUnsent(run, stripe, { tenantId: client.id, config, now: at });
    } catch (error) {
      console.error(`billing for client ${client.id} failed`, error);
    }
  }
}
