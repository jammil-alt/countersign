// Billing (docs/plan.md §1.17, §1.32). Mezonas works out each client's bill; Stripe only holds the
// customer and the invoice. The back office (`/api/ops/billing*`, operator only) sets the prices
// (defaults, templates, client agents), sets a client up (its Stripe customer), sees each client's
// month so far with what it cost us, and reviews, adjusts, sends or voids the monthly statements.
// The portal's `/api/billing` (client admin) shows the month so far by service, the credits and
// past statements: never our cost, tokens or prompts (invariant 11). Stripe's webhook is public,
// checked by its signature, and stored once per event id.

import {
  isHandledStripeEvent,
  STRIPE_SIGNATURE_HEADER,
  STRIPE_WEBHOOK_MAX_BYTES,
  type StripeClient,
  StripeError,
  StripeEvent,
  type StripeEventSummary,
  summarizeStripeEvent,
  verifyStripeSignature,
} from "@countersign/connectors";
import {
  type AgentPriceView,
  type BillingSettingsView,
  type BuiltStatement,
  type ClientAgentPrice,
  isUuid,
  type MonthSoFar,
  money,
  type OpsAgentPrice,
  type OpsBillingClient,
  type OpsStatement,
  type PortalStatement,
  type PricePoint,
  type PriceView,
  readTenantBilling,
  resolveAgentPrice,
  routes,
  type StatementLine,
  type StatementStatus,
  type TenantBilling,
} from "@countersign/core";
import {
  agent,
  agentChange,
  appUser,
  billingAgentPrice,
  billingEvent,
  billingSetting,
  billingStatement,
  billingStatementLine,
  billingTemplatePrice,
  billingUnitCost,
  type Tx,
  tenant,
  withTenant,
} from "@countersign/db";
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type LineRow,
  retotal,
  SendRefused,
  type StatementRow,
  sendStatement,
  statementLines,
  txRunner,
} from "../billing/jobs";
import {
  type AgentRow,
  agentLabel,
  type BillingConfig,
  clientAgents,
  isActive,
  loadBillingConfig,
  loadPricing,
  monthFor,
  type Pricing,
  patchTenantBilling,
  priceOf,
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
  stripeFor,
} from "../http";

const today = () => new Date().toISOString().slice(0, 10);
const USD = "USD";

// ── Views ────────────────────────────────────────────────────────────────────────────────────────

const priceView = (p: PricePoint, currency = USD): PriceView => ({
  monthlyPrice: money(p.monthlyPrice, currency),
  includedCredits: p.includedCredits,
});

const agentPriceView = (p: PricePoint & { source: AgentPriceView["source"] }): AgentPriceView => ({
  ...priceView(p),
  source: p.source,
});

function settingsView(config: BillingConfig): BillingSettingsView {
  const s = config.settings;
  return {
    defaultAgentPrice: s.defaultAgentPrice,
    defaultIncludedCredits: s.allowanceCreditsPerAgent,
    creditPrice: s.creditPrice,
    autoSend: s.autoSend,
    daysUntilDue: s.daysUntilDue,
    unitCosts: config.unitCosts,
    updatedAt: s.updatedAt.toISOString(),
  };
}

interface Detail {
  days?: number;
  prices?: { monthlyPrice: string; days: number }[];
}

function lineView(
  l: {
    id: string | null;
    kind: LineRow["kind"];
    agentId: string | null;
    description: string;
    amount: string;
    detail: unknown;
  },
  currency: string,
): StatementLine {
  const d = (l.detail ?? {}) as Detail;
  return {
    id: l.id,
    kind: l.kind,
    agentId: l.agentId,
    description: l.description,
    amount: money(l.amount, currency),
    days: l.kind === "agent" && typeof d.days === "number" ? d.days : null,
    prices:
      l.kind === "agent" && Array.isArray(d.prices)
        ? d.prices.map((p) => ({ monthlyPrice: money(p.monthlyPrice, currency), days: p.days }))
        : [],
  };
}

function monthView(built: BuiltStatement, through: string): MonthSoFar {
  return {
    period: { start: built.period.start, end: built.period.end, through },
    daysInMonth: built.daysInMonth,
    lines: built.lines.map((l) => lineView({ ...l, id: null }, USD)),
    creditsUsed: built.creditsUsed,
    creditsIncluded: built.creditsIncluded,
    extraCredits: built.extraCredits,
    creditPrice: money(built.creditPrice, USD),
    total: money(built.total, USD),
  };
}

function portalStatement(s: StatementRow, lines: LineRow[]): PortalStatement {
  return {
    id: s.id,
    period: { start: s.period, end: s.periodEnd },
    status: s.status,
    total: money(s.total, s.currency),
    creditsUsed: s.creditsUsed,
    creditsIncluded: s.creditsIncluded,
    extraCredits: s.extraCredits,
    creditPrice: money(s.creditPrice, s.currency),
    lines: lines.map((l) => lineView(l, s.currency)),
    invoiceNumber: s.stripeInvoiceNumber,
    hostedInvoiceUrl: s.hostedInvoiceUrl,
    pdfUrl: s.invoicePdfUrl,
    dueAt: iso(s.dueAt),
    sentAt: iso(s.sentAt),
    paidAt: iso(s.paidAt),
  };
}

function opsStatement(s: StatementRow, lines: LineRow[], clientName: string): OpsStatement {
  return {
    ...portalStatement(s, lines),
    clientId: s.tenantId,
    clientName,
    editable: s.status === "draft" && !s.stripeInvoiceId,
    sendStarted: Boolean(s.stripeInvoiceId),
    sendError: s.sendError,
    stripeInvoiceId: s.stripeInvoiceId,
    voidedAt: iso(s.voidedAt),
    createdAt: s.createdAt.toISOString(),
  };
}

async function clientNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function opsStatements(tx: Tx, rows: StatementRow[]): Promise<OpsStatement[]> {
  const names = await clientNames(tx, [...new Set(rows.map((r) => r.tenantId))]);
  const out: OpsStatement[] = [];
  for (const s of rows) {
    out.push(opsStatement(s, await statementLines(tx, s), names.get(s.tenantId) ?? ""));
  }
  return out;
}

async function opsClient(
  tx: Tx,
  tenantId: string,
  config: BillingConfig,
): Promise<OpsBillingClient> {
  const t = await tenantBilling(tx, tenantId);
  if (!t) throw notFound("client");
  const through = today();
  const period = through.slice(0, 7) + "-01";
  const month = await monthFor(tx, { tenantId, period, through, config, billing: t.billing });
  const agents = await clientAgents(tx, tenantId);
  const [latest] = await tx
    .select()
    .from(billingStatement)
    .where(eq(billingStatement.tenantId, tenantId))
    .orderBy(desc(billingStatement.period))
    .limit(1);
  return {
    id: tenantId,
    name: t.name,
    setUp: t.billing !== null,
    customerId: t.billing?.customerId ?? null,
    email: t.billing?.email ?? null,
    activeAgents: agents.filter((a) => isActive(a.agent)).length,
    monthSoFar: monthView(month.built, through),
    costUsd: month.cost,
    latestStatement: latest
      ? {
          id: latest.id,
          period: latest.period,
          status: latest.status,
          total: money(latest.total, latest.currency),
        }
      : null,
  };
}

/** Templates (operator scope) with their own price and what their client agents get. */
async function templateRows(tx: Tx, pricing: Pricing) {
  const rows = await tx
    .select()
    .from(agent)
    .where(and(isNull(agent.tenantId), eq(agent.kind, "template"), eq(agent.status, "active")))
    .orderBy(agent.name);
  return rows.map((t) => {
    const own = pricing.templates.get(t.id) ?? null;
    const effective = resolveAgentPrice({
      override: null,
      template: own,
      templateSlug: pricing.platform.get(t.id) ?? null,
      defaults: pricing.defaults,
    });
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      price: own ? priceView(own) : null,
      effective: agentPriceView(effective),
    };
  });
}

/** People's names (else their email) by id. */
async function userNames(tx: Tx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (wanted.length === 0) return new Map();
  const users = await tx
    .select({ id: appUser.id, name: appUser.name, email: appUser.email })
    .from(appUser)
    .where(inArray(appUser.id, wanted));
  return new Map(users.map((u) => [u.id, u.name ?? u.email]));
}

/** A template's price, as `PricePoint` changes are logged on the agent. */
const logged = (p: PricePoint | null) =>
  p ? { monthlyPrice: p.monthlyPrice, includedCredits: p.includedCredits } : null;

/** The agent's price, where it comes from, and its last price changes (operator scope). */
async function agentPriceDetail(
  tx: Tx,
  row: AgentRow,
  config: BillingConfig,
): Promise<OpsAgentPrice> {
  const pricing = await loadPricing(tx, tx, config);
  const names = (ids: (string | null)[]) => userNames(tx, ids);
  const changes = await tx
    .select()
    .from(agentChange)
    .where(and(eq(agentChange.agentId, row.id), sql`${agentChange.change} ? 'billing'`))
    .orderBy(desc(agentChange.createdAt))
    .limit(10);
  let own: OpsAgentPrice["own"] = null;
  let price: AgentPriceView;
  let template: OpsAgentPrice["template"] = null;
  const ownerIds: (string | null)[] = changes.map((c) => c.actorId);
  if (row.kind === "template") {
    const [t] = await tx
      .select()
      .from(billingTemplatePrice)
      .where(eq(billingTemplatePrice.templateId, row.id));
    ownerIds.push(t?.updatedBy ?? null);
    const who = await names(ownerIds);
    own = t
      ? {
          ...priceView(t),
          note: null,
          setBy: t.updatedBy ? (who.get(t.updatedBy) ?? null) : null,
          setAt: t.updatedAt.toISOString(),
        }
      : null;
    price = agentPriceView(
      resolveAgentPrice({
        override: null,
        template: t ?? null,
        templateSlug: pricing.platform.get(row.id) ?? null,
        defaults: pricing.defaults,
      }),
    );
    return {
      agentId: row.id,
      kind: "template",
      price,
      own,
      template: null,
      defaults: priceView(pricing.defaults),
      history: history(changes, who),
    };
  }
  const [o] = await tx
    .select()
    .from(billingAgentPrice)
    .where(
      and(
        eq(billingAgentPrice.tenantId, row.tenantId as string),
        eq(billingAgentPrice.agentId, row.id),
      ),
    );
  ownerIds.push(o?.setBy ?? null);
  const who = await names(ownerIds);
  own = o
    ? {
        ...priceView(o),
        note: o.note,
        setBy: o.setBy ? (who.get(o.setBy) ?? null) : null,
        setAt: o.setAt.toISOString(),
      }
    : null;
  price = agentPriceView(priceOf(row, o ?? null, pricing));
  if (row.templateId) {
    const [t] = await tx
      .select({ id: agent.id, name: agent.name })
      .from(agent)
      .where(eq(agent.id, row.templateId));
    const tp = pricing.templates.get(row.templateId) ?? null;
    template = t ? { id: t.id, name: t.name, price: tp ? priceView(tp) : null } : null;
  }
  return {
    agentId: row.id,
    kind: "client",
    price,
    own,
    template,
    defaults: priceView(pricing.defaults),
    history: history(changes, who),
  };
}

function history(
  changes: (typeof agentChange.$inferSelect)[],
  who: Map<string, string>,
): OpsAgentPrice["history"] {
  return changes.map((c) => {
    const b =
      (
        c.change as {
          billing?: { from?: PricePoint | null; to?: PricePoint | null; note?: string | null };
        }
      ).billing ?? {};
    return {
      at: c.createdAt.toISOString(),
      by: c.actorId ? (who.get(c.actorId) ?? null) : null,
      from: b.from ? priceView(b.from) : null,
      to: b.to ? priceView(b.to) : null,
      note: b.note ?? null,
    };
  });
}

// ── Stripe ───────────────────────────────────────────────────────────────────────────────────────

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

/** What the statement actions need from a request. */
interface Scope {
  tx: Tx;
  tenantIds: readonly string[];
  session: { user: { id: string } };
}

/** A statement of the request's clients, or 404 (ids in paths are untrusted). */
async function statementInScope(
  ctx: Pick<Scope, "tx" | "tenantIds">,
  id: string,
): Promise<StatementRow> {
  const [s] = await ctx.tx
    .select()
    .from(billingStatement)
    .where(eq(billingStatement.id, id))
    .for("update");
  if (!s || !ctx.tenantIds.includes(s.tenantId)) throw notFound("statement");
  return s;
}

function mustBeEditable(s: StatementRow): void {
  if (s.status !== "draft" || s.stripeInvoiceId) {
    throw new HttpError(409, "not_editable", "only a draft that hasn't gone to Stripe can change");
  }
}

async function opsStatementOf(tx: Tx, s: StatementRow): Promise<OpsStatement> {
  const [view] = await opsStatements(tx, [s]);
  if (!view) throw notFound("statement");
  return view;
}

export function billingRouteHandlers(app: Hono<AppEnv>): void {
  // ── Back office ─────────────────────────────────────────────────────────────────────────────

  mount(app, routes.opsBilling, async ({ tx, tenantIds, query, services }) => {
    const config = await loadBillingConfig(tx);
    const pricing = await loadPricing(tx, tx, config);
    const ids = query.client ? tenantIds.filter((id) => id === query.client) : tenantIds;
    const clients: OpsBillingClient[] = [];
    for (const id of ids) clients.push(await opsClient(tx, id, config));
    clients.sort((a, b) => Number(b.setUp) - Number(a.setUp) || a.name.localeCompare(b.name));
    const available = new Set(usageMeasures().map((m) => m.measure));
    const priced = new Set(config.unitCosts.map((u) => u.measure));
    const review =
      ids.length === 0
        ? []
        : await tx
            .select()
            .from(billingStatement)
            .where(
              and(
                inArray(billingStatement.tenantId, [...ids]),
                inArray(billingStatement.status, ["draft", "payment_failed"]),
              ),
            )
            .orderBy(desc(billingStatement.period), billingStatement.createdAt);
    return {
      stripeConfigured: stripeFor(services.deps, services.env) !== null,
      webhookConfigured: Boolean(services.env.STRIPE_WEBHOOK_SECRET?.trim()),
      settings: settingsView(config),
      measures: [...new Set([...available, ...priced])].sort().map((measure) => ({
        measure,
        available: available.has(measure),
        priced: priced.has(measure),
      })),
      templates: await templateRows(tx, pricing),
      clients,
      toReview: await opsStatements(tx, review),
    };
  });

  mount(app, routes.opsBillingSettings, async ({ tx, body, session }) => {
    const measures = body.unitCosts.map((u) => u.measure);
    if (new Set(measures).size !== measures.length) {
      throw new HttpError(422, "invalid_settings", "each measure has one unit cost");
    }
    await tx
      .update(billingSetting)
      .set({
        allowanceCreditsPerAgent: body.defaultIncludedCredits,
        defaultAgentPrice: body.defaultAgentPrice,
        creditPrice: body.creditPrice,
        autoSend: body.autoSend,
        daysUntilDue: body.daysUntilDue,
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

  async function agentFor(ctx: Pick<Scope, "tx" | "tenantIds">, id: string) {
    const [row] = await ctx.tx.select().from(agent).where(eq(agent.id, id));
    if (!row || (row.tenantId !== null && !ctx.tenantIds.includes(row.tenantId))) {
      throw notFound("agent");
    }
    return row;
  }

  mount(app, routes.opsAgentPrice, async (ctx) => {
    const row = await agentFor(ctx, ctx.params.id);
    return agentPriceDetail(ctx.tx, row, await loadBillingConfig(ctx.tx));
  });

  mount(app, routes.opsSetAgentPrice, async (ctx) => {
    const { tx, body, session } = ctx;
    const row = await agentFor(ctx, ctx.params.id);
    const config = await loadBillingConfig(tx);
    const note = body.note?.trim() || null;
    const to = body.price;
    if (row.testCopy) throw new HttpError(422, "test_copy", "a test copy is never billed");
    let from: PricePoint | null;
    if (row.kind === "template") {
      const [current] = await tx
        .select()
        .from(billingTemplatePrice)
        .where(eq(billingTemplatePrice.templateId, row.id));
      from = current ?? null;
      if (to) {
        await tx
          .insert(billingTemplatePrice)
          .values({ templateId: row.id, ...to, updatedBy: session.user.id })
          .onConflictDoUpdate({
            target: billingTemplatePrice.templateId,
            set: { ...to, updatedAt: new Date(), updatedBy: session.user.id },
          });
      } else {
        await tx.delete(billingTemplatePrice).where(eq(billingTemplatePrice.templateId, row.id));
      }
    } else {
      // DECISION: a client agent's own price needs a note, and so does clearing it: the log says why.
      if (!note) throw new HttpError(422, "note_required", "say why this agent's price differs");
      const tenantId = row.tenantId as string;
      const where = and(
        eq(billingAgentPrice.tenantId, tenantId),
        eq(billingAgentPrice.agentId, row.id),
      );
      const [current] = await tx.select().from(billingAgentPrice).where(where);
      from = current ?? null;
      if (to) {
        await tx
          .insert(billingAgentPrice)
          .values({ tenantId, agentId: row.id, ...to, note, setBy: session.user.id })
          .onConflictDoUpdate({
            target: [billingAgentPrice.tenantId, billingAgentPrice.agentId],
            set: { ...to, note, setBy: session.user.id, setAt: new Date() },
          });
      } else if (current) {
        await tx.delete(billingAgentPrice).where(where);
      }
    }
    // Every price change is in the agent's log (its audit trail).
    await tx.insert(agentChange).values({
      tenantId: row.tenantId,
      agentId: row.id,
      actorId: session.user.id,
      change: {
        billing: {
          from: logged(from),
          to: to
            ? {
                monthlyPrice: money(to.monthlyPrice, USD).amount,
                includedCredits: to.includedCredits,
              }
            : null,
          note,
        },
      },
    });
    return agentPriceDetail(tx, row, config);
  });

  mount(app, routes.opsBillingClient, async (ctx) => {
    ensureClient(ctx, ctx.params.id);
    const { tx, services } = ctx;
    const tenantId = ctx.params.id;
    const config = await loadBillingConfig(tx);
    const pricing = await loadPricing(tx, tx, config);
    const client = await opsClient(tx, tenantId, config);
    const rows = await clientAgents(tx, tenantId);
    const templateIds = [
      ...new Set(rows.map((r) => r.agent.templateId).filter((i): i is string => Boolean(i))),
    ];
    const templates =
      templateIds.length === 0
        ? new Map<string, string>()
        : new Map(
            (
              await tx
                .select({ id: agent.id, name: agent.name })
                .from(agent)
                .where(inArray(agent.id, templateIds))
            ).map((t) => [t.id, t.name]),
          );
    const setters = await userNames(
      tx,
      rows.map((r) => r.override?.setBy ?? null),
    );
    const agents: ClientAgentPrice[] = rows
      .filter((r) => r.agent.runStatus !== "retired")
      .map(({ agent: a, override }) => ({
        agentId: a.id,
        slug: a.slug,
        name: agentLabel(a),
        runStatus: a.runStatus,
        price: agentPriceView(priceOf(a, override, pricing)),
        override: override
          ? {
              ...priceView(override),
              note: override.note,
              setBy: override.setBy ? (setters.get(override.setBy) ?? null) : null,
              setAt: override.setAt.toISOString(),
            }
          : null,
        template: a.templateId
          ? { id: a.templateId, name: templates.get(a.templateId) ?? "Template" }
          : null,
      }));
    const statements = await tx
      .select()
      .from(billingStatement)
      .where(eq(billingStatement.tenantId, tenantId))
      .orderBy(desc(billingStatement.period));
    const events = await tx
      .select()
      .from(billingEvent)
      .where(eq(billingEvent.tenantId, tenantId))
      .orderBy(desc(billingEvent.createdAt))
      .limit(20);
    return {
      stripeConfigured: stripeFor(services.deps, services.env) !== null,
      client,
      agents,
      statements: await opsStatements(tx, statements),
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
    // Locks the client's row: two set-ups at once can't both create a customer.
    const [row] = await tx
      .select({ name: tenant.name, settings: tenant.settings })
      .from(tenant)
      .where(eq(tenant.id, tenantId))
      .for("update");
    if (!row) throw notFound("client");
    if (readTenantBilling(row.settings)) {
      throw new HttpError(409, "already_set_up", "this client is already set up for billing");
    }
    const email = ctx.body.email ?? null;
    try {
      // Keyed per client: a retry after a failure finds the same customer.
      const customer = await stripe.createCustomer(
        { name: row.name, ...(email ? { email } : {}), metadata: { tenant_id: tenantId } },
        `mezonas-customer-${tenantId}`,
      );
      const billing: TenantBilling = {
        customerId: customer.id,
        email,
        setUpAt: new Date().toISOString(),
        setUpBy: session.user.id,
      };
      await patchTenantBilling(tx, tenantId, billing);
    } catch (error) {
      throw stripeFailure(error);
    }
    return opsClient(tx, tenantId, await loadBillingConfig(tx));
  });

  mount(app, routes.opsAddAdjustment, async (ctx) => {
    const s = await statementInScope(ctx, ctx.params.id);
    mustBeEditable(s);
    const lines = await statementLines(ctx.tx, s);
    await ctx.tx.insert(billingStatementLine).values({
      tenantId: s.tenantId,
      statementId: s.id,
      position: Math.max(-1, ...lines.map((l) => l.position)) + 1,
      kind: "adjustment",
      agentId: null,
      description: ctx.body.description,
      amount: money(ctx.body.amount, s.currency).amount,
      currency: s.currency,
      createdBy: ctx.session.user.id,
    });
    return opsStatementOf(ctx.tx, await retotal(ctx.tx, s));
  });

  mount(app, routes.opsRemoveAdjustment, async (ctx) => {
    const s = await statementInScope(ctx, ctx.params.id);
    mustBeEditable(s);
    const removed = await ctx.tx
      .delete(billingStatementLine)
      .where(
        and(
          eq(billingStatementLine.tenantId, s.tenantId),
          eq(billingStatementLine.statementId, s.id),
          eq(billingStatementLine.id, ctx.params.lineId),
          eq(billingStatementLine.kind, "adjustment"),
        ),
      )
      .returning({ id: billingStatementLine.id });
    if (removed.length === 0) throw notFound("adjustment");
    return opsStatementOf(ctx.tx, await retotal(ctx.tx, s));
  });

  /** Sends in the request's transaction; Stripe's errors are recorded on the statement, not thrown. */
  async function send(ctx: Scope, stripe: StripeClient, s: StatementRow) {
    try {
      return await sendStatement(txRunner(ctx.tx), stripe, {
        tenantId: s.tenantId,
        statementId: s.id,
        actorId: ctx.session.user.id,
        config: await loadBillingConfig(ctx.tx),
      });
    } catch (error) {
      if (error instanceof SendRefused)
        throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  mount(app, routes.opsSendStatement, async (ctx) => {
    const stripe = needStripe(ctx.c);
    const s = await statementInScope(ctx, ctx.params.id);
    const out = await send(ctx, stripe, s);
    return opsStatementOf(ctx.tx, out.statement);
  });

  mount(app, routes.opsVoidStatement, async (ctx) => {
    const s = await statementInScope(ctx, ctx.params.id);
    if (s.status !== "draft" || s.stripeInvoiceId) {
      throw new HttpError(
        409,
        "not_editable",
        "only a draft that hasn't gone to Stripe is voided here; void a sent invoice in Stripe",
      );
    }
    const [row] = await ctx.tx
      .update(billingStatement)
      .set({
        status: "void",
        voidedAt: new Date(),
        voidedBy: ctx.session.user.id,
        updatedAt: new Date(),
      })
      .where(eq(billingStatement.id, s.id))
      .returning();
    return opsStatementOf(ctx.tx, row ?? s);
  });

  mount(app, routes.opsSendDrafts, async (ctx) => {
    const stripe = needStripe(ctx.c);
    const drafts =
      ctx.tenantIds.length === 0
        ? []
        : await ctx.tx
            .select()
            .from(billingStatement)
            .where(
              and(
                inArray(billingStatement.tenantId, [...ctx.tenantIds]),
                eq(billingStatement.status, "draft"),
              ),
            )
            .orderBy(billingStatement.createdAt);
    const results: {
      statementId: string;
      clientId: string;
      status: StatementStatus;
      error: string | null;
    }[] = [];
    for (const d of drafts) {
      try {
        const out = await send(ctx, stripe, d);
        results.push({
          statementId: d.id,
          clientId: d.tenantId,
          status: out.statement.status,
          error: out.error,
        });
      } catch (error) {
        results.push({
          statementId: d.id,
          clientId: d.tenantId,
          status: d.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  });

  // ── Portal ──────────────────────────────────────────────────────────────────────────────────

  mount(app, routes.portalBilling, async ({ tx, tenantIds }) => {
    const tenantId = tenantIds[0] as string;
    const t = await tenantBilling(tx, tenantId);
    if (!t) throw notFound("client");
    if (!t.billing)
      return { setUp: false, monthSoFar: null, paymentProblem: false, statements: [] };
    const config = await loadBillingConfig(tx);
    const through = today();
    const month = await monthFor(tx, {
      tenantId,
      period: `${through.slice(0, 7)}-01`,
      through,
      config,
      billing: t.billing,
    });
    // DECISION: the client sees statements once they are sent (or nothing is due); drafts and
    // drafts voided before sending stay with the operator.
    const rows = (
      await tx
        .select()
        .from(billingStatement)
        .where(eq(billingStatement.tenantId, tenantId))
        .orderBy(desc(billingStatement.period))
    ).filter((s) => s.status !== "draft" && !(s.status === "void" && !s.sentAt));
    const statements: PortalStatement[] = [];
    for (const s of rows) statements.push(portalStatement(s, await statementLines(tx, s)));
    return {
      setUp: true,
      monthSoFar: monthView(month.built, through),
      // Any statement whose payment failed and isn't settled yet.
      paymentProblem: rows.some((s) => s.status === "payment_failed"),
      statements,
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

/** The client an invoice event belongs to: by its Stripe customer, else by the invoice's metadata. */
async function ownerOf(c: AppContext, summary: StripeEventSummary): Promise<string | null> {
  const { db } = c.get("req").services();
  const [byCustomer] = await db
    .select({ id: tenant.id })
    .from(tenant)
    .where(sql`${tenant.settings} -> 'billing' ->> 'customerId' = ${summary.customerId}`)
    .limit(1);
  if (byCustomer) return byCustomer.id;
  if (!summary.tenantId || !isUuid(summary.tenantId)) return null;
  const [byMeta] = await db
    .select({ id: tenant.id, settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, summary.tenantId));
  // Only a client we bill, and only for its own customer.
  return byMeta && readTenantBilling(byMeta.settings)?.customerId === summary.customerId
    ? byMeta.id
    : null;
}

/**
 * Stores a verified event once for the client it belongs to and applies it to the statement whose
 * invoice it is (by invoice id, else by the invoice's `metadata.statement_id`). Events of other
 * types, or for invoices that aren't ours, are acknowledged and dropped.
 */
async function handleStripeEvent(
  c: AppContext,
  event: StripeEvent,
): Promise<{ duplicate: boolean; handled: boolean }> {
  if (!isHandledStripeEvent(event.type)) return { duplicate: false, handled: false };
  const summary = summarizeStripeEvent(event);
  if (!summary) return { duplicate: false, handled: false };
  const tenantId = await ownerOf(c, summary);
  if (!tenantId) return { duplicate: false, handled: false };
  const { db } = c.get("req").services();
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
    const mine = eq(billingStatement.tenantId, tenantId);
    let [s] = await tx
      .select()
      .from(billingStatement)
      .where(and(mine, eq(billingStatement.stripeInvoiceId, summary.objectId)))
      .for("update");
    if (!s && summary.statementId && isUuid(summary.statementId)) {
      [s] = await tx
        .select()
        .from(billingStatement)
        .where(and(mine, eq(billingStatement.id, summary.statementId)))
        .for("update");
      if (s?.stripeInvoiceId && s.stripeInvoiceId !== summary.objectId) s = undefined;
    }
    if (!s) return { duplicate: false, handled: false };
    await applyInvoiceEvent(tx, s, summary, new Date(event.created * 1000));
    return { duplicate: false, handled: true };
  });
}

/** What an invoice event does to its statement; an event older than the last one applied, nothing. */
// DECISION: uncollectible is `payment_failed` (still owed, not collected); a failure never undoes
// `paid`; `void` and `nothing_due` are final (the table's trigger too).
async function applyInvoiceEvent(
  tx: Tx,
  s: StatementRow,
  summary: StripeEventSummary,
  at: Date,
): Promise<void> {
  const links = {
    stripeInvoiceId: s.stripeInvoiceId ?? summary.objectId,
    ...(summary.number ? { stripeInvoiceNumber: summary.number } : {}),
    ...(summary.hostedInvoiceUrl ? { hostedInvoiceUrl: summary.hostedInvoiceUrl } : {}),
    ...(summary.pdfUrl ? { invoicePdfUrl: summary.pdfUrl } : {}),
    ...(summary.dueAt ? { dueAt: new Date(summary.dueAt) } : {}),
  };
  if (s.status === "void" || s.status === "nothing_due") return;
  const stale = s.stripeEventAt !== null && at < s.stripeEventAt;
  let status: StatementStatus = s.status;
  const patch: Partial<typeof billingStatement.$inferInsert> = {};
  if (!stale) {
    switch (summary.outcome) {
      case "finalized":
        if (!s.finalizedAt) patch.finalizedAt = at;
        break;
      case "paid":
        status = "paid";
        patch.paidAt = at;
        break;
      case "payment_failed":
      case "uncollectible":
        if (s.status !== "paid") status = "payment_failed";
        break;
      case "voided":
        status = "void";
        patch.voidedAt = at;
        break;
    }
    patch.stripeEventAt = at;
  }
  // A paid or voided invoice was sent, even if our own send hadn't recorded it yet.
  if ((status === "paid" || status === "payment_failed") && !s.sentAt) patch.sentAt = at;
  await tx
    .update(billingStatement)
    .set({ ...links, ...patch, status, updatedAt: new Date() })
    .where(eq(billingStatement.id, s.id));
}
