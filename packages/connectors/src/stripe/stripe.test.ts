import { describe, expect, it } from "vitest";
import { formDecode, hmacSha256Hex } from "../http";
import { FAKE_STRIPE_KEY, fakeStripe } from "../testing";
import {
  createStripeClient,
  fromMinorUnits,
  StripeError,
  StripeEvent,
  stripeForm,
  stripeSignatureHeader,
  summarizeStripeEvent,
  toMinorUnits,
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
      period: { start: 1, end: 2 },
      metadata: { tenant_id: "t 1" },
      email: undefined,
    });
    expect(body).toBe(
      "customer=cus_1&period%5Bstart%5D=1&period%5Bend%5D=2&metadata%5Btenant_id%5D=t%201",
    );
    expect(formDecode(body)["period[end]"]).toBe("2");
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

  it("makes a draft invoice that is sent, not charged, with only our items", async () => {
    const { fake, stripe } = client();
    const c = await stripe.createCustomer({ name: "A", metadata: {} }, "k1");
    const invoice = await stripe.createInvoice(
      {
        customerId: c.id,
        currency: "USD",
        daysUntilDue: 30,
        description: "Mezonas, November 2026",
        metadata: { statement_id: "s1", tenant_id: "t1" },
      },
      "mezonas:s1:invoice",
    );
    expect(invoice).toMatchObject({ status: "draft", metadata: { statement_id: "s1" } });
    const form = formDecode(fake.calls("POST", "/v1/invoices")[0]?.body ?? "");
    expect(form).toMatchObject({
      customer: c.id,
      currency: "usd",
      collection_method: "send_invoice",
      days_until_due: "30",
      auto_advance: "false",
      pending_invoice_items_behavior: "exclude",
      "metadata[statement_id]": "s1",
      "metadata[tenant_id]": "t1",
    });
  });

  it("adds items in cents, finalizes and sends, each once per key", async () => {
    const { fake, stripe } = client();
    const c = await stripe.createCustomer({ name: "A", metadata: {} }, "k1");
    const inv = await stripe.createInvoice(
      { customerId: c.id, currency: "usd", daysUntilDue: 14, description: "d", metadata: {} },
      "s:invoice",
    );
    const item = {
      customerId: c.id,
      invoiceId: inv.id,
      amount: 12345,
      currency: "usd",
      description: "Orders desk",
      period: { start: 1793491200, end: 1794095999 },
      metadata: { line_id: "l1" },
    };
    await stripe.createInvoiceItem(item, "s:item:l1");
    await stripe.createInvoiceItem(item, "s:item:l1");
    await stripe.createInvoiceItem({ ...item, amount: -500, description: "Credit" }, "s:item:l2");
    expect(fake.invoices.get(inv.id)?.lines.map((l) => l.amount)).toEqual([12345, -500]);
    const form = formDecode(fake.calls("POST", "/v1/invoiceitems")[0]?.body ?? "");
    expect(form).toMatchObject({ invoice: inv.id, amount: "12345", "period[start]": "1793491200" });
    const finalized = await stripe.finalizeInvoice(inv.id, "s:finalize");
    expect(finalized).toMatchObject({ status: "open", total: 11845 });
    expect(finalized.hosted_invoice_url).toMatch(/^https:\/\/invoice\.stripe\.com\//);
    expect(finalized.invoice_pdf).toMatch(/\/pdf$/);
    // Finalizing again under the same key replays the answer; Stripe would refuse a new one.
    expect((await stripe.finalizeInvoice(inv.id, "s:finalize")).number).toBe(finalized.number);
    await stripe.sendInvoice(inv.id, "s:send");
    await stripe.sendInvoice(inv.id, "s:send");
    expect(fake.invoices.get(inv.id)?.sent).toBe(1);
    expect((await stripe.getInvoice(inv.id)).status).toBe("open");
  });

  it("converts amounts to and from cents without floats", () => {
    expect(toMinorUnits({ amount: "123.4500", currency: "USD" })).toBe(12345);
    expect(toMinorUnits({ amount: "-0.0100", currency: "USD" })).toBe(-1);
    expect(() => toMinorUnits({ amount: "0.0050", currency: "USD" })).toThrow();
    expect(fromMinorUnits(1500, "jpy")).toEqual({ amount: "1500.0000", currency: "JPY" });
    expect(fromMinorUnits(50015, "usd")).toEqual({ amount: "500.1500", currency: "USD" });
  });

  it("turns Stripe's errors into StripeError, and a wrong key into a 401", async () => {
    const { stripe } = client();
    await expect(stripe.getInvoice("in_nope")).rejects.toMatchObject({
      status: 404,
      code: "resource_missing",
    });
    const wrong = createStripeClient({ secretKey: "sk_wrong", fetch: fakeStripe().fetch });
    await expect(wrong.getInvoice("in_1")).rejects.toBeInstanceOf(StripeError);
    const offline = createStripeClient({
      secretKey: FAKE_STRIPE_KEY,
      fetch: async () => {
        throw new Error("no network");
      },
    });
    await expect(offline.getInvoice("in_1")).rejects.toMatchObject({ type: "network" });
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

  it("summarizes the five invoice events billing acts on, and nothing else", async () => {
    const fake = fakeStripe({ webhookSecret: SECRET });
    const object = {
      id: "in_1",
      customer: "cus_1",
      currency: "usd",
      total: 1234,
      number: "MZ-1",
      due_date: 1796083200,
      hosted_invoice_url: "https://invoice.stripe.com/i/x",
      invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
      metadata: { statement_id: "s1", tenant_id: "t1" },
    };
    const { payload: p } = await fake.signedEvent(
      { id: "evt_paid", type: "invoice.paid", object },
      NOW,
    );
    const event = StripeEvent.parse(JSON.parse(p));
    expect(summarizeStripeEvent(event)).toMatchObject({
      kind: "invoice",
      outcome: "paid",
      total: "12.3400",
      currency: "USD",
      statementId: "s1",
      tenantId: "t1",
      dueAt: "2026-12-01T00:00:00.000Z",
      pdfUrl: "https://pay.stripe.com/invoice/x/pdf",
    });
    const outcome = (type: string) =>
      summarizeStripeEvent(StripeEvent.parse({ ...event, type }))?.outcome ?? null;
    expect(outcome("invoice.finalized")).toBe("finalized");
    expect(outcome("invoice.payment_failed")).toBe("payment_failed");
    expect(outcome("invoice.voided")).toBe("voided");
    expect(outcome("invoice.marked_uncollectible")).toBe("uncollectible");
    expect(outcome("customer.subscription.updated")).toBeNull();
    expect(outcome("charge.refunded")).toBeNull();
    // An invoice event whose object isn't an invoice is not summarized.
    expect(
      summarizeStripeEvent(StripeEvent.parse({ ...event, data: { object: { id: "sub_1" } } })),
    ).toBeNull();
  });
});
