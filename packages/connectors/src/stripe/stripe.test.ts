import { describe, expect, it } from "vitest";
import { formDecode, hmacSha256Hex } from "../http";
import { FAKE_BASE_PRICE, FAKE_OVERAGE_PRICE, FAKE_STRIPE_KEY, fakeStripe } from "../testing";
import {
  createStripeClient,
  fromMinorUnits,
  invoiceView,
  priceAmount,
  StripeError,
  StripeEvent,
  stripeForm,
  stripeSignatureHeader,
  summarizeStripeEvent,
  verifyStripeSignature,
} from "./index";

const NOW = new Date("2026-11-04T15:00:00.000Z");
const SECRET = "whsec_test_secret";

function client(fake = fakeStripe()) {
  return { fake, stripe: createStripeClient({ secretKey: FAKE_STRIPE_KEY, fetch: fake.fetch }) };
}

describe("Stripe requests", () => {
  it("form-encodes nested params the way Stripe reads them", () => {
    const body = stripeForm({
      customer: "cus_1",
      items: [{ price: "price_a", quantity: 2 }, { price: "price_b" }],
      metadata: { tenant_id: "t 1" },
      email: undefined,
    });
    expect(body).toBe(
      "customer=cus_1&items%5B0%5D%5Bprice%5D=price_a&items%5B0%5D%5Bquantity%5D=2&items%5B1%5D%5Bprice%5D=price_b&metadata%5Btenant_id%5D=t%201",
    );
    expect(formDecode(body)["items[0][quantity]"]).toBe("2");
  });

  it("creates and updates a customer with the key and an idempotency key", async () => {
    const { fake, stripe } = client();
    const c = await stripe.createCustomer(
      { name: "Client A", email: "a@example.com", metadata: { tenant_id: "t1" } },
      "customer-t1",
    );
    expect(c.id).toMatch(/^cus_/);
    const [req] = fake.calls("POST", "/v1/customers");
    expect(req?.headers.authorization).toBe(`Bearer ${FAKE_STRIPE_KEY}`);
    expect(req?.headers["idempotency-key"]).toBe("customer-t1");
    expect(req?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // The same key again: Stripe replays the first answer, no second customer.
    const again = await stripe.createCustomer({ name: "Client A", metadata: {} }, "customer-t1");
    expect(again.id).toBe(c.id);
    expect(fake.customers.size).toBe(1);
    const updated = await stripe.updateCustomer(c.id, { name: "Client A Ltd" });
    expect(updated.name).toBe("Client A Ltd");
  });

  it("subscribes a customer: the base price with a quantity, the metered price without", async () => {
    const { fake, stripe } = client();
    const c = await stripe.createCustomer({ name: "A", metadata: {} }, "k1");
    const sub = await stripe.createSubscription(
      {
        customerId: c.id,
        basePriceId: FAKE_BASE_PRICE,
        quantity: 3,
        overagePriceId: FAKE_OVERAGE_PRICE,
        billingCycleAnchor: 1796083200,
        daysUntilDue: 30,
        metadata: { tenant_id: "t1" },
      },
      "sub-t1",
    );
    const base = sub.items.data.find((i) => i.price.id === FAKE_BASE_PRICE);
    const overage = sub.items.data.find((i) => i.price.id === FAKE_OVERAGE_PRICE);
    expect(base?.quantity).toBe(3);
    expect(overage?.quantity ?? null).toBeNull();
    const form = formDecode(fake.calls("POST", "/v1/subscriptions")[0]?.body ?? "");
    expect(form.collection_method).toBe("send_invoice");
    expect(form.days_until_due).toBe("30");
    expect(form.billing_cycle_anchor).toBe("1796083200");
    expect(form["items[1][quantity]"]).toBeUndefined();
    const item = await stripe.setItemQuantity(base?.id ?? "", 1);
    expect(item.quantity).toBe(1);
  });

  it("reports usage as a meter event, idempotent on its identifier", async () => {
    const { fake, stripe } = client();
    const c = await stripe.createCustomer({ name: "A", metadata: {} }, "k1");
    const input = {
      eventName: "mezonas_credits",
      customerId: c.id,
      value: 42,
      identifier: "mezonas:t1:2026-11-01:2026-11-03",
      timestamp: 1793750399,
    };
    await stripe.createMeterEvent(input);
    await stripe.createMeterEvent(input);
    expect(fake.meterEvents).toHaveLength(1);
    expect(fake.meterEvents[0]).toMatchObject({ value: 42, customer: c.id });
    const form = formDecode(fake.calls("POST", "/v1/billing/meter_events")[0]?.body ?? "");
    expect(form["payload[stripe_customer_id]"]).toBe(c.id);
    expect(form["payload[value]"]).toBe("42");
  });

  it("lists invoices with their hosted page and PDF, amounts as decimals", async () => {
    const { fake, stripe } = client();
    fake.addInvoice("cus_x", { total: 50015, created: 1793750400, status: "paid", number: "MZ-1" });
    fake.addInvoice("cus_y", { total: 100, created: 1793750400 });
    const list = await stripe.listInvoices("cus_x");
    expect(list).toHaveLength(1);
    const view = invoiceView(list[0] as (typeof list)[number]);
    expect(view.total).toEqual({ amount: "500.1500", currency: "USD" });
    expect(view.hostedInvoiceUrl).toMatch(/^https:\/\/invoice\.stripe\.com\//);
    expect(view.pdfUrl).toMatch(/\/pdf$/);
    expect((await stripe.getInvoice(view.id)).id).toBe(view.id);
  });

  it("reads prices to the fraction of a cent", async () => {
    const { stripe } = client();
    expect(priceAmount(await stripe.getPrice(FAKE_BASE_PRICE))).toEqual({
      amount: "250.0000",
      currency: "USD",
    });
    expect(priceAmount(await stripe.getPrice(FAKE_OVERAGE_PRICE))).toEqual({
      amount: "0.0150",
      currency: "USD",
    });
    expect(fromMinorUnits(1500, "jpy")).toEqual({ amount: "1500.0000", currency: "JPY" });
  });

  it("turns Stripe's errors into StripeError, and a wrong key into a 401", async () => {
    const { stripe } = client();
    await expect(stripe.getPrice("price_nope")).rejects.toMatchObject({
      status: 404,
      code: "resource_missing",
    });
    const wrong = createStripeClient({ secretKey: "sk_wrong", fetch: fakeStripe().fetch });
    await expect(wrong.getPrice(FAKE_BASE_PRICE)).rejects.toBeInstanceOf(StripeError);
    const offline = createStripeClient({
      secretKey: FAKE_STRIPE_KEY,
      fetch: async () => {
        throw new Error("no network");
      },
    });
    await expect(offline.getPrice(FAKE_BASE_PRICE)).rejects.toMatchObject({ type: "network" });
  });
});

describe("Stripe webhook signatures", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const t = Math.floor(NOW.getTime() / 1000);

  it("accepts a good signature", async () => {
    const header = await stripeSignatureHeader(SECRET, payload, t);
    expect(header).toBe(`t=${t},v1=${await hmacSha256Hex(SECRET, `${t}.${payload}`)}`);
    expect(await verifyStripeSignature({ payload, header, secret: SECRET, now: NOW })).toEqual({
      ok: true,
      timestamp: t,
    });
  });

  it("accepts any of several v1 signatures (a secret being rolled)", async () => {
    const good = (await stripeSignatureHeader(SECRET, payload, t)).split(",")[1];
    const header = `t=${t},v1=${"0".repeat(64)},${good},v0=abc`;
    expect((await verifyStripeSignature({ payload, header, secret: SECRET, now: NOW })).ok).toBe(
      true,
    );
  });

  it("refuses a bad signature, a changed body, another secret and a malformed header", async () => {
    const header = await stripeSignatureHeader(SECRET, payload, t);
    const check = (p: string, h: string | null, s = SECRET) =>
      verifyStripeSignature({ payload: p, header: h, secret: s, now: NOW });
    expect(await check(`${payload} `, header)).toEqual({ ok: false, reason: "mismatch" });
    expect(await check(payload, header, "whsec_other")).toEqual({ ok: false, reason: "mismatch" });
    expect(await check(payload, `t=${t},v1=${"a".repeat(64)}`)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(await check(payload, null)).toEqual({ ok: false, reason: "missing" });
    expect(await check(payload, "garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(await check(payload, `t=${t}`)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses an expired signature, and one from the future, outside the tolerance", async () => {
    const old = await stripeSignatureHeader(SECRET, payload, t - 301);
    expect(await verifyStripeSignature({ payload, header: old, secret: SECRET, now: NOW })).toEqual(
      { ok: false, reason: "expired" },
    );
    const edge = await stripeSignatureHeader(SECRET, payload, t - 300);
    expect(
      (await verifyStripeSignature({ payload, header: edge, secret: SECRET, now: NOW })).ok,
    ).toBe(true);
    const future = await stripeSignatureHeader(SECRET, payload, t + 301);
    expect(
      await verifyStripeSignature({ payload, header: future, secret: SECRET, now: NOW }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("summarizes the events billing acts on", async () => {
    const fake = fakeStripe({ webhookSecret: SECRET });
    const { payload: p } = await fake.signedEvent(
      {
        id: "evt_paid",
        type: "invoice.paid",
        object: { id: "in_1", customer: "cus_1", currency: "usd", total: 1234, number: "MZ-1" },
      },
      NOW,
    );
    const event = StripeEvent.parse(JSON.parse(p));
    expect(summarizeStripeEvent(event)).toMatchObject({
      kind: "invoice",
      outcome: "paid",
      total: "12.3400",
      currency: "USD",
    });
    const sub = StripeEvent.parse({
      id: "evt_sub",
      type: "customer.subscription.updated",
      created: 1,
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "past_due",
          items: { data: [{ id: "si_1", quantity: 2, price: { id: "price_a" } }] },
        },
      },
    });
    expect(summarizeStripeEvent(sub)).toMatchObject({
      kind: "subscription",
      status: "past_due",
      items: [{ id: "si_1", priceId: "price_a", quantity: 2 }],
    });
    expect(summarizeStripeEvent(StripeEvent.parse({ ...sub, type: "invoice.paid" }))).toBeNull();
  });
});
