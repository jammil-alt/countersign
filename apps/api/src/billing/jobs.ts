// Billing jobs (docs/plan.md §1.32): the daily record of billable agents, the monthly statement,
// and sending a statement to Stripe as an invoice. Mezonas works out each bill; Stripe only holds
// the customer and the invoice. The cron runs the record and the build hourly (at the usage sweep's
// minute, after the rollup) and, with auto-send on, the sends; the back office sends by hand.
// Stripe is reached only here and in the billing routes: it is Mezonas' infrastructure, never an
// agent tool.

import { type StripeClient, StripeError } from "@countersign/connectors";
import {
  billingPeriod,
  centsOf,
  dec,
  periodSeconds,
  previousPeriod,
  readTenantBilling,
  statementStripeKey,
  sumAmounts,
  utcDayOf,
} from "@countersign/core";
import {
  billingStatement,
  billingStatementLine,
  type Db,
  type Tx,
  tenant,
  withOperator,
  withTenant,
} from "@countersign/db";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
// v0.12 W2-G
import { DEFAULT_APP_ORIGIN } from "../notify/outbox";
import { creditsOutPass } from "./credits-out";
import {
  type BillingConfig,
  loadBillingConfig,
  loadPricing,
  monthFor,
  type Pricing,
  recordAgentDays,
  tenantBilling,
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

export type StatementRow = typeof billingStatement.$inferSelect;
export type LineRow = typeof billingStatementLine.$inferSelect;

// ── Building ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Builds a client's statement for a month from its agent days and the credits it used, once: a
 * second call returns the statement already there. A zero total is `nothing_due`.
 */
export async function buildMonthStatement(
  tx: Tx,
  input: { tenantId: string; period: string; config: BillingConfig },
): Promise<{ statement: StatementRow; created: boolean }> {
  const period = billingPeriod(input.period);
  const where = and(
    eq(billingStatement.tenantId, input.tenantId),
    eq(billingStatement.period, period.start),
  );
  const [existing] = await tx.select().from(billingStatement).where(where);
  if (existing) return { statement: existing, created: false };
  const billing = (await tenantBilling(tx, input.tenantId))?.billing ?? null;
  const { built } = await monthFor(tx, {
    tenantId: input.tenantId,
    period: period.start,
    through: period.end,
    config: input.config,
    billing,
  });
  const [inserted] = await tx
    .insert(billingStatement)
    .values({
      tenantId: input.tenantId,
      period: period.start,
      periodEnd: period.end,
      daysInMonth: built.daysInMonth,
      status: "draft",
      total: built.total,
      creditsUsed: built.creditsUsed,
      creditsIncluded: built.creditsIncluded,
      extraCredits: built.extraCredits,
      creditPrice: built.creditPrice,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    // Another pass built it between our read and our insert.
    const [raced] = await tx.select().from(billingStatement).where(where);
    if (!raced) throw new Error("statement vanished");
    return { statement: raced, created: false };
  }
  await tx.insert(billingStatementLine).values(
    built.lines.map((l, i) => ({
      tenantId: input.tenantId,
      statementId: inserted.id,
      position: i,
      kind: l.kind,
      agentId: l.agentId,
      description: l.description,
      amount: l.amount,
      detail: l.detail as unknown as Record<string, unknown>,
    })),
  );
  if (dec(built.total).isZero()) {
    const [none] = await tx
      .update(billingStatement)
      .set({ status: "nothing_due", updatedAt: new Date() })
      .where(eq(billingStatement.id, inserted.id))
      .returning();
    return { statement: none ?? inserted, created: true };
  }
  return { statement: inserted, created: true };
}

/** A statement's lines, in order. */
export async function statementLines(tx: Tx, statement: StatementRow): Promise<LineRow[]> {
  return tx
    .select()
    .from(billingStatementLine)
    .where(
      and(
        eq(billingStatementLine.tenantId, statement.tenantId),
        eq(billingStatementLine.statementId, statement.id),
      ),
    )
    .orderBy(asc(billingStatementLine.position), asc(billingStatementLine.createdAt));
}

/** Recomputes a draft's total from its lines. */
export async function retotal(tx: Tx, statement: StatementRow): Promise<StatementRow> {
  const lines = await statementLines(tx, statement);
  const [row] = await tx
    .update(billingStatement)
    .set({ total: sumAmounts(lines.map((l) => l.amount)), updatedAt: new Date() })
    .where(eq(billingStatement.id, statement.id))
    .returning();
  return row ?? statement;
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────────

export class SendRefused extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const monthName = (period: string) =>
  new Date(`${period}T00:00:00.000Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Sends a draft statement to Stripe in four steps, each stored as soon as Stripe answers and each
 * under its own Idempotency-Key, so a send that stopped resumes where it stopped: (1) a draft
 * invoice, (2) one item per non-zero line, (3) finalize, (4) send. Stripe's errors are recorded on
 * the statement (`send_error`) and returned, never thrown, so what was stored commits. A zero total
 * becomes `nothing_due` without Stripe. Refuses (SendRefused) a statement that isn't a draft, a
 * negative total and a client with no Stripe customer.
 */
export async function sendStatement(
  run: Runner,
  stripe: StripeClient,
  input: { tenantId: string; statementId: string; actorId: string | null; config: BillingConfig },
): Promise<{ statement: StatementRow; error: string | null }> {
  const { tenantId, statementId } = input;
  const state = await run(async (tx) => {
    const [s] = await tx
      .select()
      .from(billingStatement)
      .where(and(eq(billingStatement.tenantId, tenantId), eq(billingStatement.id, statementId)))
      .for("update");
    if (!s) throw new SendRefused(409, "not_found", "no such statement");
    return {
      statement: s,
      lines: await statementLines(tx, s),
      billing: (await tenantBilling(tx, tenantId))?.billing ?? null,
    };
  });
  let s = state.statement;
  if (s.status !== "draft") {
    throw new SendRefused(409, "not_draft", `this statement is ${s.status.replace("_", " ")}`);
  }
  const total = dec(s.total);
  if (!s.stripeInvoiceId && total.isZero()) {
    const [none] = await run((tx) =>
      tx
        .update(billingStatement)
        .set({ status: "nothing_due", updatedAt: new Date() })
        .where(eq(billingStatement.id, s.id))
        .returning(),
    );
    return { statement: none ?? s, error: null };
  }
  if (total.isNegative()) {
    throw new SendRefused(422, "negative_total", "a statement with a negative total can't be sent");
  }
  if (!state.billing) {
    throw new SendRefused(409, "not_set_up", "this client is not set up for billing");
  }
  const customerId = state.billing.customerId;
  const currency = s.currency.toLowerCase();
  const update = async (patch: Partial<typeof billingStatement.$inferInsert>) => {
    const [row] = await run((tx) =>
      tx
        .update(billingStatement)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(billingStatement.id, s.id))
        .returning(),
    );
    if (row) s = row;
  };
  try {
    // 1. The draft invoice.
    if (!s.stripeInvoiceId) {
      const invoice = await stripe.createInvoice(
        {
          customerId,
          currency,
          daysUntilDue: input.config.settings.daysUntilDue,
          description: `Mezonas, ${monthName(s.period)}`,
          metadata: { statement_id: s.id, tenant_id: tenantId },
        },
        statementStripeKey(s.id, "invoice"),
      );
      await update({ stripeInvoiceId: invoice.id });
    }
    const invoiceId = s.stripeInvoiceId as string;
    // Lines are frozen once the invoice id is stored (billing_statement_line_guard), so read them
    // again now: an adjustment added after the first read is sent too, and the total still matches.
    const lines = await run((tx) => statementLines(tx, s));
    const sent = sumAmounts(lines.map((l) => l.amount));
    if (!dec(sent).equals(dec(s.total))) {
      throw new Error(`the lines add up to ${sent}, not the statement's total ${s.total}`);
    }
    // 2. One item per line with an amount; zero lines stay on our statement only.
    // DECISION: zero-amount lines ("Included" agents, no extra usage) are not sent to Stripe.
    const period = periodSeconds(s.period);
    for (const line of lines) {
      if (line.stripeInvoiceItemId || dec(line.amount).isZero()) continue;
      const item = await stripe.createInvoiceItem(
        {
          customerId,
          invoiceId,
          amount: centsOf(line.amount),
          currency,
          description: line.description,
          period,
          metadata: { statement_id: s.id, line_id: line.id },
        },
        statementStripeKey(s.id, "item", line.id),
      );
      await run((tx) =>
        tx
          .update(billingStatementLine)
          .set({ stripeInvoiceItemId: item.id })
          .where(
            and(
              eq(billingStatementLine.id, line.id),
              isNull(billingStatementLine.stripeInvoiceItemId),
            ),
          ),
      );
    }
    // 3. Finalize: Stripe numbers it and gives its hosted page and PDF.
    if (!s.finalizedAt) {
      const inv = await stripe.finalizeInvoice(invoiceId, statementStripeKey(s.id, "finalize"));
      await update({
        finalizedAt: new Date(),
        stripeInvoiceNumber: inv.number ?? null,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        invoicePdfUrl: inv.invoice_pdf ?? null,
        dueAt: inv.due_date ? new Date(inv.due_date * 1000) : null,
      });
    }
    // 4. Send: Stripe emails it with the link to pay.
    await stripe.sendInvoice(invoiceId, statementStripeKey(s.id, "send"));
    await update({
      status: "sent",
      sentAt: new Date(),
      sentBy: input.actorId,
      sendError: null,
    });
    return { statement: s, error: null };
  } catch (error) {
    const message =
      error instanceof StripeError
        ? `Stripe: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    await update({ sendError: message.slice(0, 500) });
    return { statement: s, error: message };
  }
}

// ── The cron's pass ──────────────────────────────────────────────────────────────────────────────

/**
 * The hourly billing pass (at the usage sweep's minute, after the rollup): for each client set up
 * for billing, record today's active agents; build last month's statement if it isn't built; with
 * auto-send on, send it, and resume any draft whose send started and stopped.
 */
// DECISION: the build runs on every pass, not only on the 1st, and finds last month's statement
// already there after the first: a pass that failed is caught up an hour later (plan §1.32).
export async function billingTick(
  // v0.12 W2-G: `origin` (APP_ORIGIN) for the credits notifications' links.
  deps: { db: Db; stripe: StripeClient | null; origin?: string },
  at: Date,
): Promise<void> {
  // The tenant table is global: the clients set up for billing are found without a client scope.
  const clients = await deps.db
    .select({ id: tenant.id, settings: tenant.settings })
    .from(tenant)
    .where(isNotNull(sql`${tenant.settings} -> 'billing' ->> 'customerId'`));
  if (clients.length === 0) return;
  const config = await loadBillingConfig(deps.db);
  const pricing: Pricing = await withOperator(deps.db, [], (op) => loadPricing(op, op, config));
  const today = utcDayOf(at);
  const lastMonth = previousPeriod(at);
  const lastMonthEnd = billingPeriod(lastMonth).end;
  for (const client of clients) {
    const billing = readTenantBilling(client.settings);
    if (!billing) continue;
    const run = tenantRunner(deps.db, client.id);
    try {
      // v0.12 W2-G: credits running out (pause or tell), before today's agent days are recorded,
      // in its own transaction so a failure here never holds up the bill.
      await run((tx) =>
        creditsOutPass(tx, {
          tenantId: client.id,
          at,
          config,
          pricing,
          origin: deps.origin ?? DEFAULT_APP_ORIGIN,
        }),
      ).catch((error: unknown) => console.error(`credits for client ${client.id} failed`, error));
      const built = await run(async (tx) => {
        await recordAgentDays(tx, { tenantId: client.id, day: today, pricing });
        // A client set up after the month ended has no statement for it.
        if (billing.setUpAt.slice(0, 10) > lastMonthEnd) return null;
        return buildMonthStatement(tx, { tenantId: client.id, period: lastMonth, config });
      });
      if (!config.settings.autoSend || !deps.stripe) continue;
      const drafts = await run((tx) =>
        tx
          .select()
          .from(billingStatement)
          .where(
            and(eq(billingStatement.tenantId, client.id), eq(billingStatement.status, "draft")),
          ),
      );
      for (const d of drafts) {
        // The one just built, and any whose send started and stopped.
        const justBuilt = built?.created && built.statement.id === d.id;
        if (!justBuilt && !d.stripeInvoiceId) continue;
        await sendStatement(run, deps.stripe, {
          tenantId: client.id,
          statementId: d.id,
          actorId: null,
          config,
        }).catch((error: unknown) => {
          console.error(`sending statement ${d.id} failed`, error);
        });
      }
    } catch (error) {
      console.error(`billing for client ${client.id} failed`, error);
    }
  }
}
