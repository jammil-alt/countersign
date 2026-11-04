// Billing (docs/plan.md §1.17, §1.24). The back office (`/api/ops/billing*`, operator only) keeps
// the settings, sets up a client in Stripe (a customer and a subscription: the base fee per active
// client agent, and metered overage) and sees each client's period with what it cost us. The
// portal's `/api/billing` (client admin) shows the plan, the allowance, credits used and Stripe's
// invoices: never our cost, tokens or prompts (invariant 11). Stripe's webhook is public, checked
// by its signature, and stored once per event id.

import {
  invoiceView,
  isHandledStripeEvent,
  priceAmount,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_MAX_BYTES,
  type StripeClient,
  StripeError,
  StripeEvent,
  type StripePrice,
  summarizeStripeEvent,
  verifyStripeSignature,
} from "@countersign/connectors";
import {
  type BillingInvoice,
  type BillingSettingsView,
  dec,
  type Money,
  money,
  nextPeriodAnchor,
  type OpsBillingClient,
  readTenantBilling,
  reportDay,
  routes,
  type TenantBilling,
} from "@countersign/core";
import {
  billingEvent,
  billingSetting,
  billingUnitCost,
  billingUsageReport,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type Runner,
  reportUsage,
  syncAgentQuantity,
  tenantRunner,
  txRunner,
} from "../billing/jobs";
import {
  type BillingConfig,
  type ClientPeriod,
  clientPeriod,
  loadBillingConfig,
  patchTenantBilling,
  tenantBilling,
  usageMeasures,
} from "../billing/ledger";
import {
  type AppContext,
  type AppEnv,
  ensureClient,
  errorResponse,
  HttpError,
  iso,
  mount,
  notFound,
  type Services,
  stripeFor,
} from "../http";

const today = () => new Date().toISOString().slice(0, 10);

function settingsView(config: BillingConfig): BillingSettingsView {
  const s = config.settings;
  const m = (amount: string | null): Money | null => (amount ? money(amount, s.currency) : null);
  return {
    allowanceCreditsPerAgent: s.allowanceCreditsPerAgent,
    basePriceId: s.basePriceId,
    overagePriceId: s.overagePriceId,
    meterEventName: s.meterEventName,
    daysUntilDue: s.daysUntilDue,
    unitCosts: config.unitCosts,
    baseFee: m(s.baseFee),
    overagePrice: m(s.overagePrice),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** The base fee for `agents` agents, from the price snapshot. */
function baseFor(config: BillingConfig, agents: number): Money | null {
  const fee = config.settings.baseFee;
  return fee ? money(dec(fee).times(agents), config.settings.currency) : null;
}

function opsClientRow(
  client: { id: string; name: string; billing: TenantBilling | null },
  p: ClientPeriod,
  config: BillingConfig,
): OpsBillingClient {
  const b = client.billing;
  return {
    id: client.id,
    name: client.name,
    setUp: Boolean(b?.subscriptionId),
    customerId: b?.customerId ?? null,
    subscriptionId: b?.subscriptionId ?? null,
    subscriptionStatus: b?.subscriptionStatus ?? null,
    billedAgents: b?.quantity ?? 0,
    activeAgents: p.activeAgents,
    period: p.period,
    base: baseFor(config, p.activeAgents),
    allowance: p.allowance,
    creditsUsed: p.credits,
    overageCredits: p.overage,
    reportedCredits: p.reported,
    costUsd: p.cost,
    lastInvoice: b?.lastInvoice
      ? {
          id: b.lastInvoice.id,
          number: b.lastInvoice.number,
          status: b.lastInvoice.status,
          at: b.lastInvoice.at,
        }
      : null,
  };
}

async function opsClient(tx: Tx, tenantId: string, config: BillingConfig) {
  const t = await tenantBilling(tx, tenantId);
  if (!t) throw notFound("client");
  const p = await clientPeriod(tx, { tenantId, through: today(), config });
  return opsClientRow({ id: tenantId, name: t.name, billing: t.billing }, p, config);
}

/** A client's invoices from Stripe; on failure, none and a flag (the page still loads). */
async function invoicesFor(
  stripe: StripeClient | null,
  billing: TenantBilling | null,
): Promise<{ invoices: BillingInvoice[]; invoicesUnavailable: boolean }> {
  if (!stripe || !billing) return { invoices: [], invoicesUnavailable: Boolean(billing) };
  try {
    return {
      invoices: (await stripe.listInvoices(billing.customerId, 24)).map(invoiceView),
      invoicesUnavailable: false,
    };
  } catch (error) {
    console.error("listing a client's invoices failed", error);
    return { invoices: [], invoicesUnavailable: true };
  }
}

function needStripe(c: AppContext): StripeClient {
  const stripe = stripeFor(c.get("req").services().deps, c.env);
  if (!stripe) {
    throw new HttpError(409, "billing_not_configured", "Stripe is not set up: STRIPE_SECRET_KEY");
  }
  return stripe;
}

function stripeFailure(error: unknown): HttpError {
  if (error instanceof StripeError) {
    return new HttpError(502, "stripe_error", `Stripe: ${error.message}`);
  }
  return error instanceof HttpError ? error : new HttpError(502, "stripe_error", String(error));
}

/** Checks a saved price id against Stripe: it exists, is monthly, licensed or metered. */
async function checkPrice(
  stripe: StripeClient,
  id: string,
  kind: "base" | "overage",
): Promise<StripePrice> {
  let price: StripePrice;
  try {
    price = await stripe.getPrice(id);
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      throw new HttpError(422, "invalid_price", `Stripe has no price ${id}`);
    }
    throw stripeFailure(error);
  }
  const r = price.recurring;
  const metered = r?.usage_type === "metered";
  if (r?.interval !== "month") {
    throw new HttpError(422, "invalid_price", `${id} is not a monthly recurring price`);
  }
  if (kind === "base" && metered) {
    throw new HttpError(
      422,
      "invalid_price",
      `${id} is metered: the base fee needs a licensed price`,
    );
  }
  if (kind === "overage" && !metered) {
    throw new HttpError(
      422,
      "invalid_price",
      `${id} is not metered: overage needs a metered price`,
    );
  }
  if (price.active === false) throw new HttpError(422, "invalid_price", `${id} is archived`);
  return price;
}

/** After an agent's run status changes: brings the client's base quantity in line, after the response. */
export function syncQuantityLater(
  ctx: { defer(task: () => Promise<unknown>): void; services: Services },
  tenantId: string | null,
): void {
  if (!tenantId) return;
  const stripe = stripeFor(ctx.services.deps, ctx.services.env);
  if (!stripe) return;
  ctx.defer(async () => {
    try {
      await syncAgentQuantity(tenantRunner(ctx.services.db, tenantId), stripe, tenantId);
    } catch (error) {
      // The hourly pass catches up.
      console.error(`billing quantity for client ${tenantId} could not be synced`, error);
    }
  });
}

export function billingRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ─────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsBilling, async ({ tx, tenantIds, query, services }) => {
    const config = await loadBillingConfig(tx);
    const ids = query.client ? tenantIds.filter((id) => id === query.client) : tenantIds;
    const clients: OpsBillingClient[] = [];
    for (const id of ids) clients.push(await opsClient(tx, id, config));
    clients.sort((a, b) => Number(b.setUp) - Number(a.setUp) || a.name.localeCompare(b.name));
    const available = new Set(usageMeasures().map((m) => m.measure));
    const priced = new Set(config.unitCosts.map((u) => u.measure));
    return {
      stripeConfigured: stripeFor(services.deps, services.env) !== null,
      webhookConfigured: Boolean(services.env.STRIPE_WEBHOOK_SECRET?.trim()),
      settings: settingsView(config),
      measures: [...new Set([...available, ...priced])].sort().map((measure) => ({
        measure,
        available: available.has(measure),
        priced: priced.has(measure),
      })),
      clients,
    };
  });

  mount(app, routes.opsBillingSettings, async ({ tx, body, session, c }) => {
    const measures = body.unitCosts.map((u) => u.measure);
    if (new Set(measures).size !== measures.length) {
      throw new HttpError(422, "invalid_settings", "each measure has one unit cost");
    }
    const current = await loadBillingConfig(tx);
    const s = current.settings;
    let baseFee = s.baseFee;
    let overagePrice = s.overagePrice;
    let currency = s.currency;
    const changed = body.basePriceId !== s.basePriceId || body.overagePriceId !== s.overagePriceId;
    if (changed || (body.basePriceId && !s.baseFee)) {
      const stripe = stripeFor(c.get("req").services().deps, c.env);
      baseFee = null;
      overagePrice = null;
      // DECISION: price ids are checked against Stripe and their amounts kept when they are
      // saved; without a Stripe key they are saved unchecked and the amounts stay unknown.
      if (stripe) {
        const base = body.basePriceId ? await checkPrice(stripe, body.basePriceId, "base") : null;
        const over = body.overagePriceId
          ? await checkPrice(stripe, body.overagePriceId, "overage")
          : null;
        if (base && over && base.currency !== over.currency) {
          throw new HttpError(422, "invalid_price", "the two prices are in different currencies");
        }
        const b = base ? priceAmount(base) : null;
        const o = over ? priceAmount(over) : null;
        baseFee = b?.amount ?? null;
        overagePrice = o?.amount ?? null;
        currency = b?.currency ?? o?.currency ?? currency;
      }
    }
    await tx
      .update(billingSetting)
      .set({
        allowanceCreditsPerAgent: body.allowanceCreditsPerAgent,
        basePriceId: body.basePriceId,
        overagePriceId: body.overagePriceId,
        meterEventName: body.meterEventName,
        daysUntilDue: body.daysUntilDue,
        baseFee,
        overagePrice,
        currency,
        updatedAt: new Date(),
        updatedBy: session.user.id,
      })
      .where(eq(billingSetting.id, 1));
    for (const u of body.unitCosts) {
      await tx
        .insert(billingUnitCost)
        .values({ ...u, updatedBy: session.user.id })
        .onConflictDoUpdate({
          target: billingUnitCost.measure,
          set: {
            unitCost: u.unitCost,
            perUnits: u.perUnits,
            updatedAt: new Date(),
            updatedBy: session.user.id,
          },
        });
    }
    await tx
      .delete(billingUnitCost)
      .where(measures.length > 0 ? notInArray(billingUnitCost.measure, measures) : sql`true`);
    return settingsView(await loadBillingConfig(tx));
  });

  mount(app, routes.opsBillingClient, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx } = ctx;
    const tenantId = ctx.params.id;
    const config = await loadBillingConfig(tx);
    const client = await opsClient(tx, tenantId, config);
    const billing = (await tenantBilling(tx, tenantId))?.billing ?? null;
    const reports = await tx
      .select()
      .from(billingUsageReport)
      .where(
        and(
          eq(billingUsageReport.tenantId, tenantId),
          eq(billingUsageReport.period, client.period.start),
        ),
      )
      .orderBy(desc(billingUsageReport.day));
    const events = await tx
      .select()
      .from(billingEvent)
      .where(eq(billingEvent.tenantId, tenantId))
      .orderBy(desc(billingEvent.createdAt))
      .limit(20);
    const stripe = stripeFor(ctx.services.deps, ctx.services.env);
    return {
      stripeConfigured: stripe !== null,
      client,
      reports: reports.map((r) => ({
        id: r.id,
        day: r.day,
        agents: r.agents,
        allowance: r.allowance,
        credits: r.credits,
        overage: r.overage,
        quantity: r.quantity,
        costUsd: r.costUsd,
        status: r.status,
        error: r.error,
        sentAt: iso(r.sentAt),
      })),
      ...(await invoicesFor(stripe, billing)),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        objectId: e.objectId,
        at: e.createdAt.toISOString(),
      })),
    };
  });

  mount(app, routes.opsBillingSetup, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, session } = ctx;
    const tenantId = ctx.params.id;
    const stripe = needStripe(ctx.c);
    const config = await loadBillingConfig(tx);
    const { basePriceId, overagePriceId } = config.settings;
    if (!basePriceId || !overagePriceId) {
      throw new HttpError(
        409,
        "billing_settings_incomplete",
        "save the base and overage price ids in the billing settings first",
      );
    }
    // Locks the client's row: two set-ups at once can't both create a subscription.
    const [row] = await tx
      .select({ name: tenant.name, settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .for("update");
    if (!row) throw notFound("client");
    const existing = readTenantBilling(row.settings);
    if (existing?.subscriptionId) {
      throw new HttpError(409, "already_set_up", "this client is already set up for billing");
    }
    const run: Runner = txRunner(tx);
    const p = await clientPeriod(tx, { tenantId, through: today(), config });
    try {
      // Keys per client: a retry after a failure finds the same customer and subscription.
      const customer = existing?.customerId
        ? await stripe.updateCustomer(existing.customerId, {
            name: row.name,
            ...(ctx.body.email ? { email: ctx.body.email } : {}),
          })
        : await stripe.createCustomer(
            {
              name: row.name,
              ...(ctx.body.email ? { email: ctx.body.email } : {}),
              metadata: { tenant_id: tenantId },
            },
            `mezonas-customer-${tenantId}`,
          );
      const sub = await stripe.createSubscription(
        {
          customerId: customer.id,
          basePriceId,
          quantity: p.activeAgents,
          overagePriceId,
          billingCycleAnchor: nextPeriodAnchor(new Date()),
          daysUntilDue: config.settings.daysUntilDue,
          metadata: { tenant_id: tenantId },
        },
        `mezonas-subscription-${tenantId}-${customer.id}`,
      );
      const base = sub.items.data.find((i) => i.price.id === basePriceId);
      const over = sub.items.data.find((i) => i.price.id === overagePriceId);
      const billing: TenantBilling = {
        customerId: customer.id,
        subscriptionId: sub.id,
        baseItemId: base?.id ?? null,
        overageItemId: over?.id ?? null,
        quantity: base?.quantity ?? p.activeAgents,
        subscriptionStatus: sub.status,
        subscriptionEventAt: null,
        lastInvoice: null,
        setUpAt: new Date().toISOString(),
        setUpBy: session.user.id,
      };
      await run((t) => patchTenantBilling(t, tenantId, billing));
    } catch (error) {
      throw stripeFailure(error);
    }
    return opsClient(tx, tenantId, config);
  });

  mount(app, routes.opsBillingSync, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const stripe = needStripe(ctx.c);
    const tenantId = ctx.params.id;
    const run = txRunner(ctx.tx);
    const t = await tenantBilling(ctx.tx, tenantId);
    if (!t?.billing?.subscriptionId) {
      throw new HttpError(409, "not_set_up", "this client is not set up for billing");
    }
    const config = await loadBillingConfig(ctx.tx);
    try {
      const quantity = await syncAgentQuantity(run, stripe, tenantId);
      const report = await reportUsage(run, stripe, {
        tenantId,
        day: reportDay(new Date()),
        config,
      });
      return {
        quantity: quantity ?? { before: 0, after: 0, changed: false },
        report: report
          ? {
              day: report.row.day,
              status: report.row.status,
              quantity: report.row.quantity,
              repeated: report.repeated,
            }
          : null,
      };
    } catch (error) {
      throw stripeFailure(error);
    }
  });

  // ── Portal ──────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalBilling, async ({ tx, tenantIds, services }) => {
    const tenantId = tenantIds[0] as string;
    const config = await loadBillingConfig(tx);
    const t = await tenantBilling(tx, tenantId);
    if (!t) throw notFound("client");
    const p = await clientPeriod(tx, { tenantId, through: today(), config });
    const billing = t.billing?.subscriptionId ? t.billing : null;
    const s = config.settings;
    const fee = s.baseFee ? money(s.baseFee, s.currency) : null;
    return {
      setUp: billing !== null,
      plan: billing
        ? { agents: p.activeAgents, baseFee: fee, monthly: baseFor(config, p.activeAgents) }
        : null,
      period: p.period,
      allowance: p.allowance,
      creditsUsed: p.credits,
      extraCredits: p.overage,
      extraCreditPrice: s.overagePrice ? money(s.overagePrice, s.currency) : null,
      paymentProblem: billing?.lastInvoice?.status === "payment_failed",
      ...(await invoicesFor(billing ? stripeFor(services.deps, services.env) : null, billing)),
    };
  });

  // ── Stripe's webhook ────────────────────────────────────────────────────────────────────────

  app.post(routes.stripeWebhook.path, async (c) => {
    try {
      const secret = c.env.STRIPE_WEBHOOK_SECRET?.trim();
      if (!secret) {
        throw new HttpError(503, "billing_not_configured", "Stripe's webhook secret is not set");
      }
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > STRIPE_WEBHOOK_MAX_BYTES) {
        throw new HttpError(413, "too_large", "Stripe events are smaller than this");
      }
      // The signature covers the body exactly as sent: read it as text, parse after.
      const payload = await c.req.text();
      if (payload.length > STRIPE_WEBHOOK_MAX_BYTES) {
        throw new HttpError(413, "too_large", "Stripe events are smaller than this");
      }
      const verified = await verifyStripeSignature({
        payload,
        header: c.req.header(STRIPE_SIGNATURE_HEADER),
        secret,
        now: new Date(),
      });
      if (!verified.ok) {
        throw new HttpError(400, "invalid_signature", `the signature is ${verified.reason}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new HttpError(400, "invalid_request", "the body is not JSON");
      }
      const event = StripeEvent.safeParse(json);
      if (!event.success) throw new HttpError(400, "invalid_request", "not a Stripe event");
      const answer = await handleStripeEvent(c, event.data);
      return c.json(routes.stripeWebhook.response.parse({ received: true, ...answer }));
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}

/**
 * Stores a verified event once for the client it belongs to (found by its Stripe customer in the
 * global tenant table) and applies it: an invoice's outcome, a subscription's status and quantity.
 * Events of other types, or for customers we don't bill, are acknowledged and dropped.
 */
async function handleStripeEvent(
  c: AppContext,
  event: StripeEvent,
): Promise<{ duplicate: boolean; handled: boolean }> {
  if (!isHandledStripeEvent(event.type)) return { duplicate: false, handled: false };
  const summary = summarizeStripeEvent(event);
  if (!summary) return { duplicate: false, handled: false };
  const { db } = c.get("req").services();
  const [owner] = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} -> 'billing' ->> 'customerId' = ${summary.customerId}`)
    .limit(1);
  if (!owner) return { duplicate: false, handled: false };
  const tenantId = owner.id;
  return withTenant(db, tenantId, async (tx) => {
    const [stored] = await tx
      .insert(billingEvent)
      .values({
        tenantId,
        stripeEventId: event.id,
        type: event.type,
        objectId: summary.objectId,
        summary: summary as unknown as Record<string, unknown>,
        stripeCreatedAt: new Date(event.created * 1000),
      })
      .onConflictDoNothing()
      .returning({ id: billingEvent.id });
    if (!stored) return { duplicate: true, handled: true };
    // Locks the client's settings row while applying, so two events don't interleave.
    const [row] = await tx
      .select({ settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .for("update");
    const billing = readTenantBilling(row?.settings);
    if (!billing) return { duplicate: false, handled: true };
    if (summary.kind === "invoice") {
      await patchTenantBilling(tx, tenantId, {
        lastInvoice: {
          id: summary.objectId,
          number: summary.number,
          status: summary.outcome,
          total: summary.total,
          currency: summary.currency,
          at: new Date(event.created * 1000).toISOString(),
        },
      });
    } else if (summary.objectId === billing.subscriptionId) {
      // Stripe may deliver out of order: an older subscription event changes nothing.
      if ((billing.subscriptionEventAt ?? 0) <= event.created) {
        const base = summary.items.find((i) => i.id === billing.baseItemId);
        await patchTenantBilling(tx, tenantId, {
          subscriptionStatus: summary.deleted ? "canceled" : summary.status,
          subscriptionEventAt: event.created,
          ...(base?.quantity !== undefined && base.quantity !== null
            ? { quantity: base.quantity }
            : {}),
        });
      }
    }
    return { duplicate: false, handled: true };
  });
}
