// Billing (docs/plan.md §1.32) over a throwaway database and a fake Stripe: Mezonas works out each
// bill and Stripe only bills it. The settings; prices (template, client agent override with a
// note, the supervisor free, the default) and their log; setting a client up (a customer only);
// the daily record of active agents (first price of the day sticks, paused days not billed); the
// statement (proration, a price change mid-month, the pooled credits and extra usage, rounding,
// built once); adjustments on drafts; a resumable, idempotent send; auto-send from the cron;
// Stripe's signed invoice events; isolation between clients and operators; and the portal without
// any cost, tokens or prompts.

import { createStripeClient } from "@countersign/connectors";
import { FAKE_STRIPE_KEY, fakeStripe } from "@countersign/connectors/testing";
import { FORBIDDEN_PORTAL_FIELD, readTenantBilling, type TenantBilling } from "@countersign/core";
import {
  agent,
  agentChange,
  billingAgentDay,
  billingEvent,
  billingStatement,
  billingStatementLine,
  tenant,
  usageDaily,
  usagePlatformDaily,
  withOperator,
  withTenant,
} from "@countersign/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { date, integer, numeric, pgTable, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR, user } from "./api.test-helper";
import { billingTick, buildMonthStatement } from "./billing/jobs";
import {
  creditsBetween,
  dailyTotals,
  loadBillingConfig,
  type UsageTable,
  usageMeasures,
} from "./billing/ledger";

const WEBHOOK_SECRET = "whsec_test_billing";
const fake = fakeStripe({ webhookSecret: WEBHOOK_SECRET });
const stripe = createStripeClient({ secretKey: FAKE_STRIPE_KEY, fetch: fake.fetch });
const h = await createApiHarness({ stripe, env: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** Every key in a JSON value that a portal response may never carry. */
function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) || /cost|token|prompt|model/i.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

const SETTINGS = {
  defaultAgentPrice: "200.0000",
  defaultIncludedCredits: 1000,
  creditPrice: "0.0200",
  autoSend: false,
  daysUntilDue: 14,
  unitCosts: [
    { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
    { measure: "messages", unitCost: "0.0083", perUnits: 1 },
  ],
};

/** `n` days from `from` (YYYY-MM-DD), as YYYY-MM-DD. */
function daysFrom(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

describe.skipIf(!h)("billing", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const db = H.t.db;
  const ids = {
    ordersTemplate: "",
    supervisorTemplate: "",
    orders: "",
    clerk: "",
    supervisor: "",
    testCopy: "",
    bAgent: "",
  };

  async function insertAgent(values: typeof agent.$inferInsert): Promise<string> {
    const [a] = await db.insert(agent).values(values).returning();
    if (!a) throw new Error("no agent");
    return a.id;
  }

  async function billingOf(tenantId: string): Promise<TenantBilling | null> {
    const [t] = await db.select().from(tenant).where(eq(tenant.id, tenantId));
    return readTenantBilling(t?.settings);
  }

  async function setUpAt(tenantId: string, at: string) {
    await db
      .update(tenant)
      .set({
        settings: sql`jsonb_set(${tenant.settings}, '{billing,setUpAt}', ${JSON.stringify(at)}::jsonb)`,
      })
      .where(eq(tenant.id, tenantId));
  }

  async function usage(tenantId: string, agentId: string, day: string, costUsd: string) {
    await db
      .insert(usageDaily)
      .values({ tenantId, agentId, day, runs: 1, costUsd })
      .onConflictDoUpdate({
        target: [usageDaily.tenantId, usageDaily.day, usageDaily.agentId],
        set: { costUsd },
      });
  }

  async function agentDays(
    tenantId: string,
    agentId: string,
    agentName: string,
    from: string,
    n: number,
    monthlyPrice: string,
    includedCredits: number,
  ) {
    await db.insert(billingAgentDay).values(
      daysFrom(from, n).map((day) => ({
        tenantId,
        agentId,
        agentName,
        day,
        monthlyPrice,
        includedCredits,
        priceSource: "override" as const,
      })),
    );
  }

  const config = () => withOperator(H.db, [], (tx) => loadBillingConfig(tx));
  const build = async (tenantId: string, period: string) =>
    withTenant(H.db, tenantId, async (tx) =>
      buildMonthStatement(tx, { tenantId, period, config: await config() }),
    );
  const statementOf = async (tenantId: string, period: string) => {
    const [s] = await db
      .select()
      .from(billingStatement)
      .where(and(eq(billingStatement.tenantId, tenantId), eq(billingStatement.period, period)));
    if (!s) throw new Error(`no statement for ${period}`);
    return s;
  };

  beforeAll(async () => {
    const A = H.A.tenantId;
    ids.ordersTemplate = await insertAgent({
      kind: "template",
      slug: "orders-desk",
      name: "Orders desk",
    });
    ids.supervisorTemplate = await insertAgent({
      kind: "template",
      slug: "supervisor",
      name: "Supervisor",
    });
    ids.orders = await insertAgent({
      tenantId: A,
      kind: "client",
      slug: "orders",
      name: "Orders agent",
      serviceName: "Orders desk",
      templateId: ids.ordersTemplate,
      runStatus: "active",
    });
    ids.clerk = await insertAgent({
      tenantId: A,
      kind: "client",
      slug: "clerk",
      name: "Invoice clerk",
      runStatus: "active",
    });
    ids.supervisor = await insertAgent({
      tenantId: A,
      kind: "client",
      slug: "supervisor",
      name: "Supervisor",
      serviceName: "Account check",
      templateId: ids.supervisorTemplate,
      runStatus: "active",
    });
    ids.testCopy = await insertAgent({
      tenantId: A,
      kind: "client",
      slug: "orders-test",
      name: "Orders desk (test)",
      templateId: ids.ordersTemplate,
      testCopy: true,
    });
    ids.bAgent = await insertAgent({
      tenantId: H.B.tenantId,
      kind: "client",
      slug: "b-agent",
      name: "Sorting",
      runStatus: "active",
    });
  });

  describe("settings", () => {
    it("start from the placeholders and save as decimal strings", async () => {
      const before = await call(OPERATOR, "GET", "/api/ops/billing");
      expect(before.status, JSON.stringify(before.json)).toBe(200);
      expect(j(before.json)).toMatchObject({
        stripeConfigured: true,
        webhookConfigured: true,
        settings: {
          defaultAgentPrice: "250.0000",
          defaultIncludedCredits: 2000,
          creditPrice: "0.0200",
          autoSend: false,
          daysUntilDue: 30,
        },
      });
      const measures = j(before.json).measures as { measure: string; available: boolean }[];
      expect(measures.find((m) => m.measure === "cost_usd")).toEqual({
        measure: "cost_usd",
        available: true,
        priced: true,
      });
      const saved = await call(OPERATOR, "PUT", "/api/ops/billing/settings", SETTINGS);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(j(saved.json)).toMatchObject({
        defaultAgentPrice: "200.0000",
        defaultIncludedCredits: 1000,
        creditPrice: "0.0200",
        daysUntilDue: 14,
      });
      expect(j(saved.json).unitCosts.map((u: { measure: string }) => u.measure)).toEqual([
        "cost_usd",
        "messages",
      ]);
    });

    it("refuse floats, negative prices and a measure twice", async () => {
      const float = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        creditPrice: 0.02,
      });
      expect(float.status).toBe(400);
      const negative = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        defaultAgentPrice: "-1.00",
      });
      expect(negative.status).toBe(400);
      const twice = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        unitCosts: [SETTINGS.unitCosts[0], SETTINGS.unitCosts[0]],
      });
      expect(twice.status).toBe(422);
    });

    it("can only be changed in an operator session, even by the Worker's role", async () => {
      const changed = await withTenant(H.db, H.A.tenantId, (tx) =>
        tx.execute(sql`update billing_setting set credit_price = 9`),
      );
      expect(changed.count).toBe(0);
      expect((await config()).settings.creditPrice).toBe("0.0200");
    });
  });

  describe("prices", () => {
    const priceOf = (id: string) => call(OPERATOR, "GET", `/api/ops/billing/agents/${id}/price`);

    it("set a template's price on its page, listed on /ops/billing and logged", async () => {
      const set = await call(
        OPERATOR,
        "PUT",
        `/api/ops/billing/agents/${ids.ordersTemplate}/price`,
        {
          price: { monthlyPrice: "300.00", includedCredits: 3000 },
        },
      );
      expect(set.status, JSON.stringify(set.json)).toBe(200);
      expect(j(set.json)).toMatchObject({
        kind: "template",
        price: { monthlyPrice: { amount: "300.0000", currency: "USD" }, source: "template" },
        own: { includedCredits: 3000 },
      });
      const list = await call(OPERATOR, "GET", "/api/ops/billing");
      const templates = j(list.json).templates as {
        id: string;
        price: unknown;
        effective: unknown;
      }[];
      expect(templates.find((t) => t.id === ids.ordersTemplate)?.price).toEqual({
        monthlyPrice: { amount: "300.0000", currency: "USD" },
        includedCredits: 3000,
      });
      // The supervisor's template, unpriced, is free for its client agents.
      expect(templates.find((t) => t.id === ids.supervisorTemplate)?.effective).toMatchObject({
        monthlyPrice: { amount: "0.0000" },
        includedCredits: 0,
        source: "platform",
      });
      const log = await db
        .select()
        .from(agentChange)
        .where(and(eq(agentChange.agentId, ids.ordersTemplate), isNull(agentChange.tenantId)));
      expect(log.map((l) => l.change)).toEqual([
        {
          billing: {
            from: null,
            to: { monthlyPrice: "300.0000", includedCredits: 3000 },
            note: null,
          },
        },
      ]);
    });

    it("price a client agent: its template's, else the supervisor's $0, else the default", async () => {
      expect(j((await priceOf(ids.orders)).json)).toMatchObject({
        kind: "client",
        price: { monthlyPrice: { amount: "300.0000" }, includedCredits: 3000, source: "template" },
        template: { id: ids.ordersTemplate, name: "Orders desk" },
        own: null,
      });
      expect(j((await priceOf(ids.supervisor)).json).price).toMatchObject({
        monthlyPrice: { amount: "0.0000" },
        includedCredits: 0,
        source: "platform",
      });
      expect(j((await priceOf(ids.clerk)).json).price).toMatchObject({
        monthlyPrice: { amount: "200.0000" },
        includedCredits: 1000,
        source: "default",
      });
    });

    it("override a client agent's price only with a note, and log each change", async () => {
      const path = `/api/ops/billing/agents/${ids.orders}/price`;
      const noNote = await call(OPERATOR, "PUT", path, {
        price: { monthlyPrice: "280", includedCredits: 3000 },
      });
      expect(noNote.status).toBe(422);
      expect(j(noNote.json).error.code).toBe("note_required");
      const set = await call(OPERATOR, "PUT", path, {
        price: { monthlyPrice: "280", includedCredits: 3000 },
        note: "Agreed discount for the first year",
      });
      expect(set.status, JSON.stringify(set.json)).toBe(200);
      expect(j(set.json)).toMatchObject({
        price: { monthlyPrice: { amount: "280.0000" }, source: "override" },
        own: { note: "Agreed discount for the first year", setBy: "Operator" },
      });
      const cleared = await call(OPERATOR, "PUT", path, {
        price: null,
        note: "Back to the list price",
      });
      expect(j(cleared.json).price.source).toBe("template");
      expect(j(cleared.json).history.map((c: { note: string }) => c.note)).toEqual([
        "Back to the list price",
        "Agreed discount for the first year",
      ]);
      expect(j(cleared.json).history[1]).toMatchObject({
        from: null,
        to: { monthlyPrice: { amount: "280.0000" } },
        by: "Operator",
      });
      // Set again for the daily record below.
      await call(OPERATOR, "PUT", path, {
        price: { monthlyPrice: "280", includedCredits: 3000 },
        note: "Agreed discount for the first year",
      });
    });

    it("refuse a test copy, another operator's client and a client admin", async () => {
      const copy = await call(OPERATOR, "PUT", `/api/ops/billing/agents/${ids.testCopy}/price`, {
        price: { monthlyPrice: "1", includedCredits: 0 },
        note: "x",
      });
      expect(copy.status).toBe(422);
      expect(
        (await call(OTHER_OPERATOR, "GET", `/api/ops/billing/agents/${ids.orders}/price`)).status,
      ).toBe(404);
      expect(
        (await call(admin("a"), "GET", `/api/ops/billing/agents/${ids.orders}/price`)).status,
      ).toBe(403);
    });
  });

  describe("setting up a client", () => {
    it("creates the Stripe customer and nothing else", async () => {
      const res = await call(OPERATOR, "POST", `/api/ops/billing/clients/${H.A.tenantId}/setup`, {
        email: "billing@a.example.com",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toMatchObject({
        setUp: true,
        email: "billing@a.example.com",
        activeAgents: 3,
      });
      const b = await billingOf(H.A.tenantId);
      expect(b?.customerId).toMatch(/^cus_/);
      expect(fake.customers.get(b?.customerId ?? "")).toMatchObject({
        name: "Client A",
        email: "billing@a.example.com",
        metadata: { tenant_id: H.A.tenantId },
      });
      // Only the customer: no invoice, item, price or subscription call.
      expect(fake.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/customers"]);
    });

    it("refuses a second set-up, and a client the operator doesn't serve", async () => {
      const again = await call(
        OPERATOR,
        "POST",
        `/api/ops/billing/clients/${H.A.tenantId}/setup`,
        {},
      );
      expect(again.status).toBe(409);
      expect(j(again.json).error.code).toBe("already_set_up");
      expect(fake.customers.size).toBe(1);
      const other = await call(
        OTHER_OPERATOR,
        "POST",
        `/api/ops/billing/clients/${H.A.tenantId}/setup`,
        {},
      );
      expect(other.status).toBe(404);
      expect(
        (await call(OTHER_OPERATOR, "GET", `/api/ops/billing/clients/${H.A.tenantId}`)).status,
      ).toBe(404);
    });
  });

  describe("the daily record", () => {
    const rowsOn = async (tenantId: string, day: string) =>
      db
        .select()
        .from(billingAgentDay)
        .where(and(eq(billingAgentDay.tenantId, tenantId), eq(billingAgentDay.day, day)))
        .orderBy(billingAgentDay.agentName);

    it("records each active agent of a billed client once a day, with its price then", async () => {
      await billingTick({ db: H.db, stripe }, new Date("2026-10-20T10:07:00Z"));
      const rows = await rowsOn(H.A.tenantId, "2026-10-20");
      expect(
        rows.map((r) => [r.agentName, r.monthlyPrice, r.includedCredits, r.priceSource]),
      ).toEqual([
        ["Account check", "0.0000", 0, "platform"],
        ["Invoice clerk", "200.0000", 1000, "default"],
        ["Orders desk", "280.0000", 3000, "override"],
      ]);
      // B is not set up: nothing recorded. The test copy never is.
      expect(await rowsOn(H.B.tenantId, "2026-10-20")).toEqual([]);
      expect(rows.some((r) => r.agentId === ids.testCopy)).toBe(false);
    });

    it("keeps the first price seen in a day, and skips paused days", async () => {
      await call(OPERATOR, "PUT", `/api/ops/billing/agents/${ids.clerk}/price`, {
        price: { monthlyPrice: "260", includedCredits: 1000 },
        note: "Bigger mailbox",
      });
      await billingTick({ db: H.db, stripe }, new Date("2026-10-20T11:07:00Z"));
      const same = await rowsOn(H.A.tenantId, "2026-10-20");
      expect(same.find((r) => r.agentId === ids.clerk)?.monthlyPrice).toBe("200.0000");
      await db.update(agent).set({ runStatus: "paused" }).where(eq(agent.id, ids.supervisor));
      await billingTick({ db: H.db, stripe }, new Date("2026-10-21T00:07:00Z"));
      const next = await rowsOn(H.A.tenantId, "2026-10-21");
      expect(next.map((r) => [r.agentName, r.monthlyPrice])).toEqual([
        ["Invoice clerk", "260.0000"],
        ["Orders desk", "280.0000"],
      ]);
      await db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, ids.supervisor));
    });
  });

  describe("statements", () => {
    // September 2026 (30 days), from days put in directly.
    beforeAll(async () => {
      const A = H.A.tenantId;
      await setUpAt(A, "2026-08-01T00:00:00.000Z");
      // Orders desk: 10 of 30 days at $300 with 3,000 credits.
      await agentDays(A, ids.orders, "Orders desk", "2026-09-01", 10, "300.0000", 3000);
      // Invoice clerk: 15 days at $200, then 15 at $260, 1,000 credits.
      await agentDays(A, ids.clerk, "Invoice clerk", "2026-09-01", 15, "200.0000", 1000);
      await agentDays(A, ids.clerk, "Invoice clerk", "2026-09-16", 15, "260.0000", 1000);
      // The supervisor all month, free.
      await agentDays(A, ids.supervisor, "Account check", "2026-09-01", 30, "0.0000", 0);
      // 2,500 credits of work; the test copy's 500 are not the client's.
      await usage(A, ids.orders, "2026-09-05", "20.0000");
      await usage(A, ids.clerk, "2026-09-20", "5.0000");
      await usage(A, ids.testCopy, "2026-09-06", "5.0000");
    });

    it("prorate each agent by its days and prices, pool the credits and bill the extra", async () => {
      const { statement, created } = await build(H.A.tenantId, "2026-09-01");
      expect(created).toBe(true);
      // Pool: 3,000 × 10/30 + 1,000 = 2,000; used 2,500; 500 extra × $0.02 = $10.00.
      expect(statement).toMatchObject({
        status: "draft",
        daysInMonth: 30,
        creditsUsed: 2500,
        creditsIncluded: 2000,
        extraCredits: 500,
        creditPrice: "0.0200",
        // 0 + 100 + 230 + 10.
        total: "340.0000",
      });
      const lines = await db
        .select()
        .from(billingStatementLine)
        .where(eq(billingStatementLine.statementId, statement.id))
        .orderBy(billingStatementLine.position);
      expect(lines.map((l) => [l.kind, l.description, l.amount])).toEqual([
        ["agent", "Account check", "0.0000"],
        ["agent", "Invoice clerk", "230.0000"],
        ["agent", "Orders desk", "100.0000"],
        ["usage", "Extra usage", "10.0000"],
      ]);
      expect(lines[1]?.detail).toMatchObject({
        days: 30,
        prices: [
          { monthlyPrice: "200.0000", days: 15 },
          { monthlyPrice: "260.0000", days: 15 },
        ],
      });
    });

    it("are built once per client and month", async () => {
      const first = await statementOf(H.A.tenantId, "2026-09-01");
      const again = await build(H.A.tenantId, "2026-09-01");
      expect(again.created).toBe(false);
      expect(again.statement.id).toBe(first.id);
      const lines = await db
        .select()
        .from(billingStatementLine)
        .where(eq(billingStatementLine.statementId, first.id));
      expect(lines).toHaveLength(4);
    });

    it("take adjustments on a draft, in whole cents, and remove them", async () => {
      const s = await statementOf(H.A.tenantId, "2026-09-01");
      const path = `/api/ops/billing/statements/${s.id}/adjustments`;
      const add = await call(OPERATOR, "POST", path, {
        description: "Credit for a slow week",
        amount: "-15.00",
      });
      expect(add.status, JSON.stringify(add.json)).toBe(200);
      expect(j(add.json)).toMatchObject({ total: { amount: "325.0000" }, editable: true });
      expect((await call(OPERATOR, "POST", path, { description: "x", amount: "0" })).status).toBe(
        400,
      );
      expect(
        (await call(OPERATOR, "POST", path, { description: "x", amount: "1.234" })).status,
      ).toBe(400);
      expect((await call(OPERATOR, "POST", path, { description: "x", amount: 5 })).status).toBe(
        400,
      );
      const extra = await call(OPERATOR, "POST", path, {
        description: "Set-up help",
        amount: "40",
      });
      const lineId = j(extra.json).lines.at(-1).id;
      expect(j(extra.json).total.amount).toBe("365.0000");
      const removed = await call(OPERATOR, "DELETE", `${path}/${lineId}`);
      expect(j(removed.json).total.amount).toBe("325.0000");
      // An agent line is not an adjustment.
      const agentLine = j(removed.json).lines[0].id;
      expect((await call(OPERATOR, "DELETE", `${path}/${agentLine}`)).status).toBe(404);
    });

    it("never send a zero total to Stripe, and void a draft that hasn't gone", async () => {
      // August: no days, no usage → nothing due.
      const { statement: august } = await build(H.A.tenantId, "2026-08-01");
      expect(august).toMatchObject({ status: "nothing_due", total: "0.0000" });
      const send = await call(OPERATOR, "POST", `/api/ops/billing/statements/${august.id}/send`);
      expect(send.status).toBe(409);
      // July had a day of the clerk (before set-up, but days are what was recorded).
      await setUpAt(H.A.tenantId, "2026-07-01T00:00:00.000Z");
      await agentDays(H.A.tenantId, ids.clerk, "Invoice clerk", "2026-07-01", 1, "310.0000", 0);
      const { statement: july } = await build(H.A.tenantId, "2026-07-01");
      expect(july).toMatchObject({ status: "draft", total: "10.0000" });
      const voided = await call(OPERATOR, "POST", `/api/ops/billing/statements/${july.id}/void`);
      expect(voided.status, JSON.stringify(voided.json)).toBe(200);
      expect(j(voided.json)).toMatchObject({ status: "void", editable: false });
      expect(
        (await call(OPERATOR, "POST", `/api/ops/billing/statements/${july.id}/void`)).status,
      ).toBe(409);
      expect(
        (await call(OPERATOR, "POST", `/api/ops/billing/statements/${july.id}/send`)).status,
      ).toBe(409);
      expect(fake.calls("POST", "/v1/invoices")).toHaveLength(0);
      await setUpAt(H.A.tenantId, "2026-08-01T00:00:00.000Z");
    });

    it("send in four steps and resume after a failure, each step once", async () => {
      const s = await statementOf(H.A.tenantId, "2026-09-01");
      const path = `/api/ops/billing/statements/${s.id}/send`;
      // Stripe fails at the finalize, after the invoice and its items.
      fake.failNext(500, "/v1/invoices/");
      const first = await call(OPERATOR, "POST", path);
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(j(first.json)).toMatchObject({
        status: "draft",
        sendStarted: true,
        editable: false,
        sendError: expect.stringMatching(/fail/),
      });
      const invoiceId = j(first.json).stripeInvoiceId as string;
      // Every non-zero line is on the invoice, once; the free supervisor's line is not.
      expect(fake.invoices.get(invoiceId)?.lines.map((l) => [l.description, l.amount])).toEqual([
        ["Invoice clerk", 23000],
        ["Orders desk", 10000],
        ["Extra usage", 1000],
        ["Credit for a slow week", -1500],
      ]);
      // Once Stripe has it, nothing can be adjusted.
      const late = await call(OPERATOR, "POST", `/api/ops/billing/statements/${s.id}/adjustments`, {
        description: "Late",
        amount: "1.00",
      });
      expect(late.status).toBe(409);

      const second = await call(OPERATOR, "POST", path);
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      expect(j(second.json)).toMatchObject({
        status: "sent",
        sendError: null,
        invoiceNumber: expect.stringMatching(/^MZ-/),
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
        pdfUrl: expect.stringMatching(/\/pdf$/),
      });
      const invoice = fake.invoices.get(invoiceId);
      expect(invoice).toMatchObject({
        status: "open",
        total: 32500,
        sent: 1,
        collection_method: "send_invoice",
        days_until_due: 14,
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        metadata: { statement_id: s.id, tenant_id: H.A.tenantId },
      });
      expect(invoice?.lines).toHaveLength(4);
      expect(fake.calls("POST", "/v1/invoices")).toHaveLength(1 + 2 + 1);
      const keys = fake.requests.map((r) => r.headers["idempotency-key"]).filter(Boolean);
      expect(keys).toContain(`mezonas:${s.id}:invoice`);
      expect(keys).toContain(`mezonas:${s.id}:finalize`);
      expect(keys).toContain(`mezonas:${s.id}:send`);
      expect(keys.filter((k) => k?.startsWith(`mezonas:${s.id}:item:`))).toHaveLength(4);
      expect((await call(OPERATOR, "POST", path)).status).toBe(409);
    });

    it("send from the cron with auto-send on, once", async () => {
      // B: set up, with a month of days in October.
      await call(OPERATOR, "POST", `/api/ops/billing/clients/${H.B.tenantId}/setup`, {});
      await setUpAt(H.B.tenantId, "2026-10-01T00:00:00.000Z");
      await agentDays(H.B.tenantId, ids.bAgent, "Sorting", "2026-10-01", 31, "155.0000", 0);
      await call(OPERATOR, "PUT", "/api/ops/billing/settings", { ...SETTINGS, autoSend: true });
      await billingTick({ db: H.db, stripe }, new Date("2026-11-01T00:07:00Z"));
      const b = await statementOf(H.B.tenantId, "2026-10-01");
      expect(b).toMatchObject({ status: "sent", total: "155.0000" });
      expect(fake.invoices.get(b.stripeInvoiceId ?? "")?.sent).toBe(1);
      // A's October (two recorded days) went too.
      expect((await statementOf(H.A.tenantId, "2026-10-01")).status).toBe("sent");
      const invoices = fake.invoices.size;
      await billingTick({ db: H.db, stripe }, new Date("2026-11-01T01:07:00Z"));
      expect(fake.invoices.size).toBe(invoices);
      await call(OPERATOR, "PUT", "/api/ops/billing/settings", SETTINGS);
    });

    it("send every draft at once from the back office", async () => {
      await agentDays(H.A.tenantId, ids.clerk, "Invoice clerk", "2026-06-01", 3, "300.0000", 0);
      await setUpAt(H.A.tenantId, "2026-06-01T00:00:00.000Z");
      const { statement: june } = await build(H.A.tenantId, "2026-06-01");
      await setUpAt(H.A.tenantId, "2026-08-01T00:00:00.000Z");
      expect(june.status).toBe("draft");
      const res = await call(OPERATOR, "POST", "/api/ops/billing/statements/send-drafts");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).results).toEqual([
        { statementId: june.id, clientId: H.A.tenantId, status: "sent", error: null },
      ]);
      // The other operator serves neither client: nothing of theirs is sent, nothing of A's seen.
      const other = await call(OTHER_OPERATOR, "POST", "/api/ops/billing/statements/send-drafts");
      expect(j(other.json).results).toEqual([]);
      expect(
        (await call(OTHER_OPERATOR, "POST", `/api/ops/billing/statements/${june.id}/void`)).status,
      ).toBe(404);
    });
  });

  describe("Stripe's webhook", () => {
    async function deliver(payload: string, header: string | null) {
      const res = await H.app.request(
        "/api/billing/stripe/webhook",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header ? { "stripe-signature": header } : {}),
          },
          body: payload,
        },
        H.env,
      );
      return { status: res.status, json: await res.json() };
    }
    const base = Math.floor(Date.now() / 1000) - 3600;
    let n = 0;
    async function event(type: string, object: Record<string, unknown>, created: number) {
      const e = await fake.signedEvent({ id: `evt_${++n}`, type, object, created }, new Date());
      return { ...e, result: await deliver(e.payload, e.header) };
    }
    const september = () => statementOf(H.A.tenantId, "2026-09-01");

    it("move a sent statement through failed and paid, once per event, in order", async () => {
      const s = await september();
      const invoice = () => fake.invoiceObject(s.stripeInvoiceId ?? "");
      const failed = await event("invoice.payment_failed", invoice(), base + 10);
      expect(failed.result).toEqual({
        status: 200,
        json: { received: true, duplicate: false, handled: true },
      });
      expect((await september()).status).toBe("payment_failed");
      const portal = await call(admin("a"), "GET", "/api/billing");
      expect(j(portal.json).paymentProblem).toBe(true);
      // The same delivery again: stored once, applied once.
      expect((await deliver(failed.payload, failed.header)).json).toEqual({
        received: true,
        duplicate: true,
        handled: true,
      });
      fake.setInvoiceStatus(s.stripeInvoiceId ?? "", "paid");
      await event("invoice.paid", invoice(), base + 20);
      expect(await september()).toMatchObject({
        status: "paid",
        paidAt: new Date((base + 20) * 1000),
      });
      // A failure delivered late, or after the payment, never undoes it.
      await event("invoice.payment_failed", invoice(), base + 15);
      await event("invoice.payment_failed", invoice(), base + 30);
      expect((await september()).status).toBe("paid");
      const stored = await withTenant(H.db, H.A.tenantId, (tx) =>
        tx
          .select()
          .from(billingEvent)
          .where(eq(billingEvent.objectId, s.stripeInvoiceId ?? "")),
      );
      expect(stored).toHaveLength(4);
    });

    it("void and mark uncollectible what Stripe says, and find a statement by its metadata", async () => {
      const b = await statementOf(H.B.tenantId, "2026-10-01");
      await event("invoice.voided", fake.invoiceObject(b.stripeInvoiceId ?? ""), base + 40);
      expect((await statementOf(H.B.tenantId, "2026-10-01")).status).toBe("void");
      const a = await statementOf(H.A.tenantId, "2026-10-01");
      await event(
        "invoice.marked_uncollectible",
        fake.invoiceObject(a.stripeInvoiceId ?? ""),
        base + 41,
      );
      expect((await statementOf(H.A.tenantId, "2026-10-01")).status).toBe("payment_failed");
      // A draft whose invoice id never got stored (the Worker stopped): found by statement_id.
      await agentDays(H.A.tenantId, ids.clerk, "Invoice clerk", "2026-05-01", 1, "310.0000", 0);
      await setUpAt(H.A.tenantId, "2026-05-01T00:00:00.000Z");
      const { statement: may } = await build(H.A.tenantId, "2026-05-01");
      await setUpAt(H.A.tenantId, "2026-08-01T00:00:00.000Z");
      const customerId = (await billingOf(H.A.tenantId))?.customerId;
      const lost = await event(
        "invoice.finalized",
        {
          id: "in_lost",
          customer: customerId,
          currency: "usd",
          total: 1000,
          number: "MZ-9999",
          hosted_invoice_url: "https://invoice.stripe.com/i/acct_fake/in_lost",
          invoice_pdf: "https://pay.stripe.com/invoice/acct_fake/in_lost/pdf",
          metadata: { statement_id: may.id, tenant_id: H.A.tenantId },
        },
        base + 50,
      );
      expect(lost.result.json).toMatchObject({ handled: true });
      expect(await statementOf(H.A.tenantId, "2026-05-01")).toMatchObject({
        status: "draft",
        stripeInvoiceId: "in_lost",
        stripeInvoiceNumber: "MZ-9999",
      });
    });

    it("refuse a bad, missing, expired or forged signature", async () => {
      const object = { id: "in_x", customer: "cus_x", currency: "usd", total: 1 };
      const { payload, header } = await fake.signedEvent(
        { id: "evt_sig", type: "invoice.paid", object },
        new Date(),
      );
      expect(
        (await deliver(payload, header.replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`))).status,
      ).toBe(400);
      expect((await deliver(payload, null)).status).toBe(400);
      expect((await deliver(`${payload} `, header)).status).toBe(400);
      const old = await fake.signedEvent(
        { id: "evt_old", type: "invoice.paid", object },
        new Date(Date.now() - 10 * 60_000),
      );
      const expired = await deliver(old.payload, old.header);
      expect(expired.status).toBe(400);
      expect(j(expired.json).error.message).toMatch(/expired/);
      const forged = await fake.signedEvent(
        { id: "evt_forged", type: "invoice.paid", object },
        new Date(),
        "whsec_someone_else",
      );
      expect((await deliver(forged.payload, forged.header)).status).toBe(400);
    });

    it("acknowledge and drop other events, old subscription events and strangers' invoices", async () => {
      const customer = (await billingOf(H.A.tenantId))?.customerId;
      const sub = await event(
        "customer.subscription.updated",
        { id: "sub_1", customer, status: "active", items: { data: [] } },
        base + 60,
      );
      expect(sub.result.json).toEqual({ received: true, duplicate: false, handled: false });
      const refund = await event("charge.refunded", { id: "ch_1" }, base + 61);
      expect(refund.result.json).toMatchObject({ handled: false });
      const stranger = await event(
        "invoice.paid",
        {
          id: "in_o",
          customer: "cus_unknown",
          currency: "usd",
          total: 1,
          metadata: { tenant_id: H.A.tenantId },
        },
        base + 62,
      );
      expect(stranger.result.json).toMatchObject({ handled: false });
      const notOurs = await event(
        "invoice.paid",
        { id: "in_not_ours", customer, currency: "usd", total: 1 },
        base + 63,
      );
      expect(notOurs.result.json).toMatchObject({ handled: false });
    });
  });

  describe("the back office", () => {
    it("lists the clients this operator serves with their month so far and our cost", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await usage(H.A.tenantId, ids.orders, today, "0.0150");
      const res = await call(OPERATOR, "GET", "/api/ops/billing");
      expect(res.status).toBe(200);
      const clients = j(res.json).clients as { id: string; setUp: boolean; costUsd: string }[];
      expect(clients.map((c) => c.id)).toEqual([H.A.tenantId, H.B.tenantId]);
      expect(clients[0]).toMatchObject({
        setUp: true,
        monthSoFar: { creditsUsed: expect.any(Number), lines: expect.any(Array) },
      });
      expect(Number(clients[0]?.costUsd)).toBeGreaterThan(0);
      // To review: drafts and failed payments.
      const review = j(res.json).toReview as { status: string; clientId: string }[];
      expect(review.map((s) => s.status).sort()).toEqual(["draft", "payment_failed"]);
      const other = await call(OTHER_OPERATOR, "GET", "/api/ops/billing");
      expect(j(other.json).clients.map((c: { id: string }) => c.id)).toEqual([H.C.tenantId]);
      expect(j(other.json).toReview).toEqual([]);
    });

    it("shows a client's agents with their prices, statements with links, and events", async () => {
      const res = await call(OPERATOR, "GET", `/api/ops/billing/clients/${H.A.tenantId}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const agents = j(res.json).agents as { agentId: string; price: { source: string } }[];
      expect(agents.find((a) => a.agentId === ids.orders)?.price.source).toBe("override");
      expect(agents.some((a) => a.agentId === ids.testCopy)).toBe(false);
      const sept = j(res.json).statements.find(
        (s: { period: { start: string } }) => s.period.start === "2026-09-01",
      );
      expect(sept).toMatchObject({
        status: "paid",
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
      });
      expect(j(res.json).events.length).toBeGreaterThan(0);
    });
  });

  describe("isolation", () => {
    it("keeps each client's prices, days and statements to itself", async () => {
      for (const table of [
        "billing_agent_price",
        "billing_agent_day",
        "billing_statement",
        "billing_statement_line",
      ]) {
        const rows = await withTenant(H.db, H.B.tenantId, (tx) =>
          tx.execute<{ tenant_id: string }>(sql`select tenant_id from ${sql.identifier(table)}`),
        );
        expect(
          [...rows].every((r) => r.tenant_id === H.B.tenantId),
          `${table} shows only B's rows`,
        ).toBe(true);
      }
      const s = await statementOf(H.A.tenantId, "2026-05-01");
      const inserted = withTenant(H.db, H.B.tenantId, (tx) =>
        tx.insert(billingStatementLine).values({
          tenantId: H.A.tenantId,
          statementId: s.id,
          position: 9,
          kind: "adjustment",
          description: "Sneaky",
          amount: "-100.0000",
        }),
      );
      await expect(inserted).rejects.toThrow();
    });
  });

  describe("the portal", () => {
    it("shows the client admin the month so far, credits and statements, never our cost", async () => {
      const res = await call(admin("a"), "GET", "/api/billing");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const body = j(res.json);
      expect(body).toMatchObject({
        setUp: true,
        monthSoFar: {
          creditPrice: { amount: "0.0200", currency: "USD" },
          creditsUsed: expect.any(Number),
        },
      });
      // Sent statements only: no drafts (May), no void that never went (July).
      const periods = body.statements.map((s: { period: { start: string } }) => s.period.start);
      expect(periods).toEqual(["2026-10-01", "2026-09-01", "2026-08-01", "2026-06-01"]);
      const sept = body.statements[1];
      expect(sept).toMatchObject({
        status: "paid",
        total: { amount: "325.0000", currency: "USD" },
        pdfUrl: expect.stringMatching(/\/pdf$/),
      });
      expect(sept.lines.map((l: { kind: string }) => l.kind)).toEqual([
        "agent",
        "agent",
        "agent",
        "usage",
        "adjustment",
      ]);
      expect(forbiddenKeys(res.json)).toEqual([]);
    });

    it("is the client admin's alone, and each client sees only its own", async () => {
      expect((await call(user("a"), "GET", "/api/billing")).status).toBe(403);
      const b = await call(admin("b"), "GET", "/api/billing");
      expect(b.status).toBe(200);
      expect(j(b.json).statements.map((s: { status: string }) => s.status)).toEqual(["void"]);
      expect(forbiddenKeys(b.json)).toEqual([]);
      const c = await call(admin("c"), "GET", "/api/billing");
      expect(j(c.json)).toEqual({
        setUp: false,
        monthSoFar: null,
        paymentProblem: false,
        statements: [],
      });
    });
  });

  describe("credits", () => {
    it("count a new usage_daily measure once it has a unit cost, with no code change", async () => {
      await H.t.db.execute(
        sql`alter table usage_daily add column widgets integer not null default 0`,
      );
      const usageWithWidgets = pgTable("usage_daily", {
        tenantId: uuid("tenant_id").notNull(),
        day: date("day").notNull(),
        agentId: uuid("agent_id").notNull(),
        costUsd: numeric("cost_usd", { precision: 14, scale: 4 }).notNull(),
        widgets: integer("widgets").notNull(),
      }) as unknown as UsageTable;
      expect(usageMeasures(usageWithWidgets).map((m) => m.measure)).toEqual([
        "cost_usd",
        "widgets",
      ]);
      await usage(H.A.tenantId, ids.orders, "2026-04-10", "0.0000");
      await H.t.db.execute(
        sql`update usage_daily set widgets = 7 where tenant_id = ${H.A.tenantId} and day = '2026-04-10'`,
      );
      const base = await config();
      const range = { tenantId: H.A.tenantId, from: "2026-04-01", to: "2026-04-30" };
      const unpriced = await withTenant(H.db, H.A.tenantId, (tx) =>
        creditsBetween(tx, { ...range, config: base }, usageWithWidgets),
      );
      expect(unpriced.credits).toBe(0);
      const priced = await withTenant(H.db, H.A.tenantId, (tx) =>
        creditsBetween(
          tx,
          {
            ...range,
            config: {
              ...base,
              unitCosts: [
                ...base.unitCosts,
                { measure: "widgets", unitCost: "0.0300", perUnits: 2 },
              ],
            },
          },
          usageWithWidgets,
        ),
      );
      // 7 × 0.03 / 2 = 0.105: 11 credits.
      expect(priced).toEqual({ credits: 11, cost: "0.1050" });
    });

    // v0.12 W1-H (ARCHITECTURE §13): reading no agent asked for is the client's usage, priced
    // with its agents' work, day by day.
    it("count the client's own usage (background reading) with its agents'", async () => {
      const base = await config();
      const range = { tenantId: H.A.tenantId, from: "2026-05-01", to: "2026-05-31" };
      const credits = () =>
        withTenant(H.db, H.A.tenantId, (tx) => creditsBetween(tx, { ...range, config: base }));
      await usage(H.A.tenantId, ids.orders, "2026-05-04", "0.0420");
      const agentsOnly = await credits();
      await db.insert(usagePlatformDaily).values([
        { tenantId: H.A.tenantId, day: "2026-05-04", documents: 2, costUsd: "0.0130" },
        { tenantId: H.A.tenantId, day: "2026-05-05", documents: 1, costUsd: "0.0061" },
        // Another client's reading never counts here.
        { tenantId: H.B.tenantId, day: "2026-05-04", documents: 9, costUsd: "1.0000" },
      ]);
      const both = await credits();
      expect(Number(both.cost)).toBeCloseTo(Number(agentsOnly.cost) + 0.0191, 4);
      expect(both.credits).toBeGreaterThan(agentsOnly.credits);
      const days = await withTenant(H.db, H.A.tenantId, (tx) =>
        dailyTotals(tx, { ...range, unitCosts: base.unitCosts }),
      );
      expect(days.map((d) => d.day)).toEqual(["2026-05-04", "2026-05-05"]);
    });
  });
});
