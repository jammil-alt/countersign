// Billing (docs/plan.md §1.24) over a throwaway database and a fake Stripe: the settings, setting up
// a client (customer and subscription), the base quantity following activation and retirement, the
// daily usage report (credits from usage_daily, the pooled allowance, the increment only, once per
// day), Stripe's signed webhook stored once per event, the back office's period with our cost, and
// the portal's plan, credits and invoices without any cost, tokens or prompts.

import { createStripeClient } from "@countersign/connectors";
import {
  FAKE_BASE_PRICE,
  FAKE_OVERAGE_PRICE,
  FAKE_STRIPE_KEY,
  fakeStripe,
} from "@countersign/connectors/testing";
import { FORBIDDEN_PORTAL_FIELD, readTenantBilling, type TenantBilling } from "@countersign/core";
import {
  agent,
  agentVersion,
  billingEvent,
  billingUsageReport,
  run,
  tenant,
  usageDaily,
  withOperator,
  withTenant,
} from "@countersign/db";
import { and, eq, sql } from "drizzle-orm";
import { date, integer, numeric, pgTable, uuid } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { billingTick, reportUsage, retryUnsent, tenantRunner } from "./billing/jobs";
import { clientPeriod, loadBillingConfig, type UsageTable, usageMeasures } from "./billing/ledger";

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
  allowanceCreditsPerAgent: 100,
  basePriceId: FAKE_BASE_PRICE,
  overagePriceId: FAKE_OVERAGE_PRICE,
  meterEventName: "mezonas_credits",
  daysUntilDue: 14,
  unitCosts: [
    { measure: "cost_usd", unitCost: "1.0000", perUnits: 1 },
    { measure: "messages", unitCost: "0.0083", perUnits: 1 },
  ],
};

describe.skipIf(!h)("billing", () => {
  const H = h as NonNullable<typeof h>;
  const call = H.call.bind(H);
  const db = H.t.db;
  const agents: string[] = [];

  /** A client agent with a live version, bound and test-run, ready to activate. */
  async function readyAgent(tenantId: string, connectionId: string, slug: string) {
    const [a] = await db
      .insert(agent)
      .values({
        tenantId,
        kind: "client",
        slug,
        name: slug,
        bindings: { testkit: connectionId },
        runStatus: "testing",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId,
        agentId: a.id,
        version: 1,
        bundle: testBundle(),
        bundleHash: `hash-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    await db.insert(run).values({
      tenantId,
      agentId: a.id,
      agentVersionId: v.id,
      workflowSlug: "fix-record",
      mode: "test",
      status: "succeeded",
    });
    return a.id;
  }

  async function billingOf(tenantId: string): Promise<TenantBilling | null> {
    const [t] = await db.select().from(tenant).where(eq(tenant.id, tenantId));
    return readTenantBilling(t?.settings);
  }

  const baseItem = async (tenantId: string) => {
    const b = await billingOf(tenantId);
    const sub = fake.subscriptions.get(b?.subscriptionId ?? "");
    return sub?.items.data.find((i) => i.price.id === FAKE_BASE_PRICE);
  };

  async function usage(tenantId: string, agentId: string, day: string, costUsd: string) {
    await db
      .insert(usageDaily)
      .values({ tenantId, agentId, day, runs: 1, costUsd })
      .onConflictDoUpdate({
        target: [usageDaily.tenantId, usageDaily.day, usageDaily.agentId],
        set: { costUsd },
      });
  }

  beforeAll(async () => {
    agents.push(await readyAgent(H.A.tenantId, H.A.connectionId, "billing-one"));
    agents.push(await readyAgent(H.A.tenantId, H.A.connectionId, "billing-two"));
  });

  describe("settings", () => {
    it("start from the placeholders and save the prices with their amounts from Stripe", async () => {
      const before = await call(OPERATOR, "GET", "/api/ops/billing");
      expect(before.status, JSON.stringify(before.json)).toBe(200);
      expect(j(before.json)).toMatchObject({
        stripeConfigured: true,
        webhookConfigured: true,
        settings: {
          allowanceCreditsPerAgent: 2000,
          basePriceId: null,
          overagePriceId: null,
          baseFee: null,
        },
      });
      // Every usage_daily column is a measure. Texts (messages) and calls (call_seconds) are
      // columns now, so their seeded unit costs count as soon as they're priced.
      const measures = j(before.json).measures as { measure: string; available: boolean }[];
      expect(measures.find((m) => m.measure === "cost_usd")).toEqual({
        measure: "cost_usd",
        available: true,
        priced: true,
      });
      expect(measures.find((m) => m.measure === "call_seconds")).toMatchObject({
        available: true,
        priced: true,
      });
      expect(measures.find((m) => m.measure === "messages")).toMatchObject({ available: true });

      const saved = await call(OPERATOR, "PUT", "/api/ops/billing/settings", SETTINGS);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(j(saved.json)).toMatchObject({
        allowanceCreditsPerAgent: 100,
        daysUntilDue: 14,
        baseFee: { amount: "250.0000", currency: "USD" },
        overagePrice: { amount: "0.0150", currency: "USD" },
      });
      // call_seconds was dropped from the unit costs.
      expect(j(saved.json).unitCosts.map((u: { measure: string }) => u.measure)).toEqual([
        "cost_usd",
        "messages",
      ]);
    });

    it("refuse prices of the wrong kind, unknown prices and a measure twice", async () => {
      const swapped = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        basePriceId: FAKE_OVERAGE_PRICE,
        overagePriceId: FAKE_BASE_PRICE,
      });
      expect(swapped.status).toBe(422);
      expect(j(swapped.json).error.code).toBe("invalid_price");
      const unknown = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        basePriceId: "price_nope",
      });
      expect(j(unknown.json).error.message).toMatch(/no price price_nope/);
      const twice = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        unitCosts: [SETTINGS.unitCosts[0], SETTINGS.unitCosts[0]],
      });
      expect(twice.status).toBe(422);
      const float = await call(OPERATOR, "PUT", "/api/ops/billing/settings", {
        ...SETTINGS,
        unitCosts: [{ measure: "cost_usd", unitCost: 1.5, perUnits: 1 }],
      });
      expect(float.status).toBe(400);
    });

    it("can only be changed in an operator session, even by the Worker's role", async () => {
      const changed = await withTenant(H.db, H.A.tenantId, (tx) =>
        tx.execute(sql`update billing_setting set allowance_credits_per_agent = 1`),
      );
      expect(changed.count).toBe(0);
      const config = await withOperator(H.db, [], (tx) => loadBillingConfig(tx));
      expect(config.settings.allowanceCreditsPerAgent).toBe(100);
    });
  });

  describe("setting up a client", () => {
    it("creates the customer and a subscription for the active agents", async () => {
      const first = agents[0] as string;
      const act = await call(OPERATOR, "POST", `/api/ops/agents/${first}/activate`);
      expect(act.status, JSON.stringify(act.json)).toBe(200);
      await H.settle();

      const res = await call(OPERATOR, "POST", `/api/ops/billing/clients/${H.A.tenantId}/setup`, {
        email: "billing@a.example.com",
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toMatchObject({
        setUp: true,
        billedAgents: 1,
        activeAgents: 1,
        base: { amount: "250.0000", currency: "USD" },
        allowance: 100,
      });
      const b = await billingOf(H.A.tenantId);
      expect(b?.customerId).toMatch(/^cus_/);
      const customer = fake.customers.get(b?.customerId ?? "");
      expect(customer).toMatchObject({
        name: "Client A",
        email: "billing@a.example.com",
        metadata: { tenant_id: H.A.tenantId },
      });
      const sub = fake.subscriptions.get(b?.subscriptionId ?? "");
      expect(sub).toMatchObject({ collection_method: "send_invoice", days_until_due: 14 });
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(1);
      expect(sub?.items.data.find((i) => i.price.id === FAKE_OVERAGE_PRICE)?.quantity).toBe(
        undefined,
      );
      // The anchor is the 1st of next month, midnight UTC.
      const anchor = new Date(Number(sub?.billing_cycle_anchor) * 1000);
      expect(anchor.getUTCDate()).toBe(1);
      expect(anchor.getUTCHours()).toBe(0);
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
      expect(fake.subscriptions.size).toBe(1);
      const other = await call(
        OTHER_OPERATOR,
        "POST",
        `/api/ops/billing/clients/${H.A.tenantId}/setup`,
        {},
      );
      expect(other.status).toBe(404);
      const detail = await call(OTHER_OPERATOR, "GET", `/api/ops/billing/clients/${H.A.tenantId}`);
      expect(detail.status).toBe(404);
    });
  });

  describe("the base quantity", () => {
    it("follows activation, pausing and retirement", async () => {
      const [first, second] = agents as [string, string];
      const act = await call(OPERATOR, "POST", `/api/ops/agents/${second}/activate`);
      expect(act.status, JSON.stringify(act.json)).toBe(200);
      await H.settle();
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(2);
      expect((await billingOf(H.A.tenantId))?.quantity).toBe(2);

      await call(OPERATOR, "POST", `/api/ops/agents/${second}/pause`);
      await H.settle();
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(1);

      await call(OPERATOR, "POST", `/api/ops/agents/${second}/activate`);
      await H.settle();
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(2);

      await call(OPERATOR, "POST", `/api/ops/agents/${second}/retire`);
      await H.settle();
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(1);
      expect((await billingOf(H.A.tenantId))?.quantity).toBe(1);
      expect(first).toBeTruthy();
    });

    it("is not sent again when it hasn't changed, and the cron catches up a missed change", async () => {
      const before = fake.calls("POST", "/v1/subscription_items").length;
      const sync = await call(OPERATOR, "POST", `/api/ops/billing/clients/${H.A.tenantId}/sync`);
      expect(sync.status, JSON.stringify(sync.json)).toBe(200);
      expect(j(sync.json).quantity).toEqual({ before: 1, after: 1, changed: false });
      expect(fake.calls("POST", "/v1/subscription_items").length).toBe(before);

      // A change the request missed (Stripe was down): the hourly pass brings it in line.
      await db
        .update(tenant)
        .set({ settings: sql`jsonb_set(${tenant.settings}, '{billing,quantity}', '3')` })
        .where(eq(tenant.id, H.A.tenantId));
      await billingTick({ db: H.db, stripe }, new Date("2026-11-04T10:07:00Z"));
      expect((await baseItem(H.A.tenantId))?.quantity).toBe(1);
      expect((await billingOf(H.A.tenantId))?.quantity).toBe(1);
    });
  });

  describe("usage reports", () => {
    // September 2026: a period of its own, away from the days other tests use.
    const run = () => tenantRunner(H.db, H.A.tenantId);
    const config = () => withOperator(H.db, [], (tx) => loadBillingConfig(tx));
    const report = async (day: string) =>
      reportUsage(run(), stripe, { tenantId: H.A.tenantId, day, config: await config() });
    const first = () => agents[0] as string;
    const second = () => agents[1] as string;

    it("sends nothing while the period is within the allowance, up to the boundary", async () => {
      // One active agent: an allowance of 100 credits. 0.5 + 0.4999 rounds to 50 + 50 = 100.
      await usage(H.A.tenantId, first(), "2026-09-01", "0.5000");
      await usage(H.A.tenantId, first(), "2026-09-02", "0.4999");
      const d1 = await report("2026-09-01");
      expect(d1?.row).toMatchObject({
        credits: 50,
        allowance: 100,
        overage: 0,
        quantity: 0,
        status: "none",
      });
      const d2 = await report("2026-09-02");
      expect(d2?.row).toMatchObject({ credits: 100, overage: 0, quantity: 0, status: "none" });
      expect(fake.meterEvents).toHaveLength(0);
    });

    it("reports the credits past the allowance, rounded up per day across agents", async () => {
      // Two agents' work on one day is priced together, then rounded once: 0.0050 + 0.0051 is
      // 1.01 cents, two credits (not one each).
      await usage(H.A.tenantId, first(), "2026-09-03", "0.0050");
      await usage(H.A.tenantId, second(), "2026-09-03", "0.0051");
      const d3 = await report("2026-09-03");
      expect(d3?.repeated).toBe(false);
      expect(d3?.row).toMatchObject({
        credits: 102,
        overage: 2,
        quantity: 2,
        status: "sent",
        costUsd: "1.0100",
        identifier: `mezonas:${H.A.tenantId}:2026-09-01:2026-09-03`,
      });
      const b = await billingOf(H.A.tenantId);
      expect(fake.meterEvents).toEqual([
        {
          identifier: `mezonas:${H.A.tenantId}:2026-09-01:2026-09-03`,
          event_name: "mezonas_credits",
          customer: b?.customerId,
          value: 2,
          timestamp: Math.floor(new Date("2026-09-03T23:59:59Z").getTime() / 1000),
        },
      ]);
    });

    it("sends nothing new when a day is reported again, even if usage changed since", async () => {
      await usage(H.A.tenantId, first(), "2026-09-03", "0.2000");
      const again = await report("2026-09-03");
      expect(again?.repeated).toBe(true);
      expect(again?.row.quantity).toBe(2);
      expect(fake.meterEvents).toHaveLength(1);
      // The next day reports only the increment, including the change to the earlier day.
      const d4 = await report("2026-09-04");
      // 50 + 50 + ceil(20.51) + 0 = 121 credits; 21 over; 2 reported before.
      expect(d4?.row).toMatchObject({ credits: 121, overage: 21, quantity: 19, status: "sent" });
      expect(fake.meterEvents.map((e) => e.value)).toEqual([2, 19]);
      const rows = await withTenant(H.db, H.A.tenantId, (tx) =>
        tx
          .select()
          .from(billingUsageReport)
          .where(
            and(
              eq(billingUsageReport.tenantId, H.A.tenantId),
              eq(billingUsageReport.period, "2026-09-01"),
            ),
          ),
      );
      expect(rows).toHaveLength(4);
    });

    it("keeps a failed send and retries it under the same identifier", async () => {
      await usage(H.A.tenantId, first(), "2026-09-05", "0.0500");
      fake.failNext(500, "/v1/billing/meter_events");
      const d5 = await report("2026-09-05");
      expect(d5?.row).toMatchObject({ quantity: 5, status: "failed" });
      expect(d5?.row.error).toMatch(/fail/);
      expect(fake.meterEvents).toHaveLength(2);
      const sent = await retryUnsent(run(), stripe, {
        tenantId: H.A.tenantId,
        config: await config(),
        now: new Date(),
      });
      expect(sent).toBe(1);
      expect(fake.meterEvents.map((e) => e.value)).toEqual([2, 19, 5]);
      // A day already sent is not sent again by a retry.
      expect(
        await retryUnsent(run(), stripe, {
          tenantId: H.A.tenantId,
          config: await config(),
          now: new Date(),
        }),
      ).toBe(0);
    });

    it("reports yesterday on the hourly pass, once a day, for clients set up only", async () => {
      await usage(H.A.tenantId, first(), "2026-09-06", "0.0300");
      await billingTick({ db: H.db, stripe }, new Date("2026-09-07T00:07:00Z"));
      expect(fake.meterEvents.map((e) => e.value)).toEqual([2, 19, 5, 3]);
      await billingTick({ db: H.db, stripe }, new Date("2026-09-07T01:07:00Z"));
      expect(fake.meterEvents).toHaveLength(4);
      // B is not set up: no report row.
      const b = await withTenant(H.db, H.B.tenantId, (tx) => tx.select().from(billingUsageReport));
      expect(b).toHaveLength(0);
    });

    it("counts a new usage_daily measure once it has a unit cost, with no code change", async () => {
      // A column a later migration adds (like `messages`), on this throwaway database.
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
      await usage(H.A.tenantId, first(), "2026-08-10", "0.0000");
      await H.t.db.execute(
        sql`update usage_daily set widgets = 7 where tenant_id = ${H.A.tenantId} and day = '2026-08-10'`,
      );
      const base = await config();
      const unpriced = await withTenant(H.db, H.A.tenantId, (tx) =>
        clientPeriod(
          tx,
          { tenantId: H.A.tenantId, through: "2026-08-31", config: base },
          usageWithWidgets,
        ),
      );
      expect(unpriced.credits).toBe(0);
      const priced = await withTenant(H.db, H.A.tenantId, (tx) =>
        clientPeriod(
          tx,
          {
            tenantId: H.A.tenantId,
            through: "2026-08-31",
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
      expect(priced).toMatchObject({ credits: 11, cost: "0.1050" });
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
    const customer = async () => (await billingOf(H.A.tenantId))?.customerId ?? "";

    it("applies a paid invoice once, however often it is delivered", async () => {
      const { payload, header } = await fake.signedEvent(
        {
          id: "evt_paid_1",
          type: "invoice.paid",
          object: {
            id: "in_a1",
            customer: await customer(),
            currency: "usd",
            total: 26500,
            number: "MZ-0001",
            status: "paid",
          },
        },
        new Date(),
      );
      const first = await deliver(payload, header);
      expect(first).toEqual({
        status: 200,
        json: { received: true, duplicate: false, handled: true },
      });
      const again = await deliver(payload, header);
      expect(again.json).toEqual({ received: true, duplicate: true, handled: true });
      expect((await billingOf(H.A.tenantId))?.lastInvoice).toMatchObject({
        id: "in_a1",
        status: "paid",
        total: "265.0000",
        currency: "USD",
      });
      const stored = await withTenant(H.db, H.A.tenantId, (tx) =>
        tx.select().from(billingEvent).where(eq(billingEvent.stripeEventId, "evt_paid_1")),
      );
      expect(stored).toHaveLength(1);
    });

    it("refuses a bad, missing or expired signature", async () => {
      const { payload, header } = await fake.signedEvent(
        {
          id: "evt_x",
          type: "invoice.paid",
          object: { id: "in_x", customer: await customer(), currency: "usd", total: 1 },
        },
        new Date(),
      );
      expect(
        (await deliver(payload, header.replace(/v1=[0-9a-f]+/, `v1=${"0".repeat(64)}`))).status,
      ).toBe(400);
      expect((await deliver(payload, null)).status).toBe(400);
      expect((await deliver(`${payload} `, header)).status).toBe(400);
      const old = await fake.signedEvent(
        {
          id: "evt_old",
          type: "invoice.paid",
          object: { id: "in_x", customer: await customer(), currency: "usd", total: 1 },
        },
        new Date(Date.now() - 10 * 60_000),
      );
      const expired = await deliver(old.payload, old.header);
      expect(expired.status).toBe(400);
      expect(j(expired.json).error.message).toMatch(/expired/);
      const forged = await fake.signedEvent(
        {
          id: "evt_forged",
          type: "invoice.paid",
          object: { id: "in_x", customer: await customer(), currency: "usd", total: 1 },
        },
        new Date(),
        "whsec_someone_else",
      );
      expect((await deliver(forged.payload, forged.header)).status).toBe(400);
      const stored = await withTenant(H.db, H.A.tenantId, (tx) => tx.select().from(billingEvent));
      expect(stored.map((e) => e.stripeEventId)).toEqual(["evt_paid_1"]);
    });

    it("applies subscription changes in order and ignores what isn't ours", async () => {
      const b = await billingOf(H.A.tenantId);
      const sub = (status: string, quantity: number) => ({
        id: b?.subscriptionId,
        customer: b?.customerId,
        status,
        items: { data: [{ id: b?.baseItemId, quantity, price: { id: FAKE_BASE_PRICE } }] },
      });
      const now = Math.floor(Date.now() / 1000);
      const newer = await fake.signedEvent(
        {
          id: "evt_sub_2",
          type: "customer.subscription.updated",
          object: sub("past_due", 1),
          created: now,
        },
        new Date(),
      );
      expect((await deliver(newer.payload, newer.header)).json).toMatchObject({ handled: true });
      const older = await fake.signedEvent(
        {
          id: "evt_sub_1",
          type: "customer.subscription.updated",
          object: sub("active", 4),
          created: now - 60,
        },
        new Date(),
      );
      expect((await deliver(older.payload, older.header)).json).toMatchObject({ handled: true });
      expect(await billingOf(H.A.tenantId)).toMatchObject({
        subscriptionStatus: "past_due",
        quantity: 1,
      });

      const stranger = await fake.signedEvent(
        {
          id: "evt_other",
          type: "invoice.paid",
          object: { id: "in_o", customer: "cus_unknown", currency: "usd", total: 1 },
        },
        new Date(),
      );
      expect((await deliver(stranger.payload, stranger.header)).json).toEqual({
        received: true,
        duplicate: false,
        handled: false,
      });
      const other = await fake.signedEvent(
        { id: "evt_misc", type: "charge.refunded", object: { id: "ch_1" } },
        new Date(),
      );
      expect((await deliver(other.payload, other.header)).json).toMatchObject({ handled: false });
    });

    it("marks a failed payment for the back office and the client admin", async () => {
      const { payload, header } = await fake.signedEvent(
        {
          id: "evt_failed_1",
          type: "invoice.payment_failed",
          object: {
            id: "in_a2",
            customer: await customer(),
            currency: "usd",
            total: 25000,
            status: "open",
          },
        },
        new Date(),
      );
      await deliver(payload, header);
      expect((await billingOf(H.A.tenantId))?.lastInvoice?.status).toBe("payment_failed");
      const portal = await call(admin("a"), "GET", "/api/billing");
      expect(j(portal.json).paymentProblem).toBe(true);
    });
  });

  describe("the back office", () => {
    it("lists the clients this operator serves with their period and our cost", async () => {
      const today = new Date().toISOString().slice(0, 10);
      await usage(H.A.tenantId, agents[0] as string, today, "0.0150");
      const res = await call(OPERATOR, "GET", "/api/ops/billing");
      expect(res.status).toBe(200);
      const clients = j(res.json).clients as { id: string; setUp: boolean; costUsd: string }[];
      expect(clients.map((c) => c.id)).toEqual([H.A.tenantId, H.B.tenantId]);
      expect(clients[0]).toMatchObject({ setUp: true, creditsUsed: expect.any(Number) });
      expect(Number(clients[0]?.costUsd)).toBeGreaterThan(0);
      const other = await call(OTHER_OPERATOR, "GET", "/api/ops/billing");
      expect(j(other.json).clients.map((c: { id: string }) => c.id)).toEqual([H.C.tenantId]);
    });

    it("shows a client's reports, invoices with links, and Stripe's events", async () => {
      const b = await billingOf(H.A.tenantId);
      fake.addInvoice(b?.customerId ?? "", {
        total: 26500,
        created: 1793750400,
        status: "paid",
        number: "MZ-0001",
      });
      const res = await call(OPERATOR, "GET", `/api/ops/billing/clients/${H.A.tenantId}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).invoices[0]).toMatchObject({
        number: "MZ-0001",
        total: { amount: "265.0000", currency: "USD" },
        hostedInvoiceUrl: expect.stringMatching(/^https:\/\/invoice\.stripe\.com\//),
        pdfUrl: expect.stringMatching(/\/pdf$/),
      });
      expect(j(res.json).events.length).toBeGreaterThan(0);
      expect(j(res.json).invoicesUnavailable).toBe(false);
    });
  });

  describe("the portal", () => {
    it("shows the client admin the plan, allowance, credits and invoices, never our cost", async () => {
      const res = await call(admin("a"), "GET", "/api/billing");
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json)).toMatchObject({
        setUp: true,
        plan: {
          agents: 1,
          baseFee: { amount: "250.0000", currency: "USD" },
          monthly: { amount: "250.0000", currency: "USD" },
        },
        allowance: 100,
        creditsUsed: expect.any(Number),
        extraCreditPrice: { amount: "0.0150", currency: "USD" },
      });
      expect(j(res.json).creditsUsed).toBeGreaterThanOrEqual(2);
      expect(j(res.json).invoices[0].hostedInvoiceUrl).toMatch(/^https:\/\/invoice\.stripe\.com\//);
      expect(forbiddenKeys(res.json)).toEqual([]);
    });

    it("is the client admin's alone, and each client sees only its own", async () => {
      expect((await call(user("a"), "GET", "/api/billing")).status).toBe(403);
      const b = await call(admin("b"), "GET", "/api/billing");
      expect(b.status).toBe(200);
      expect(j(b.json)).toMatchObject({ setUp: false, plan: null, invoices: [], creditsUsed: 0 });
      expect(forbiddenKeys(b.json)).toEqual([]);
    });
  });
});
