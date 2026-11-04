// A fake Stripe for tests (`@countersign/connectors/testing`): customers, prices, subscriptions and
// their items, billing meter events and invoices, in memory, behind the same HTTP shapes the client
// uses (form bodies, Bearer key, Idempotency-Key replays). Never imported by the Worker.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { stripeSignatureHeader } from "./webhook";

export const FAKE_STRIPE_KEY = "sk_test_fake";
export const FAKE_BASE_PRICE = "price_base_monthly";
export const FAKE_OVERAGE_PRICE = "price_credit_overage";
export const FAKE_METER = "mtr_fake_credits";

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function respond(status: number, body: unknown): HttpResponseLike {
  const text = JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
  };
}

const notFound = (what: string) =>
  respond(404, {
    error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` },
  });

/** `items[0][price]` → nested objects and arrays, as Stripe reads a form. */
function unflatten(form: Record<string, string>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    const parts = key.split(/\[|\]\[|\]/).filter((p) => p !== "");
    let node = root as Record<string, unknown>;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = value;
      else {
        node[p] ??= {};
        node = node[p] as Record<string, unknown>;
      }
    });
  }
  return root;
}

export interface FakeInvoiceInput {
  id?: string;
  number?: string;
  status?: string;
  total: number;
  currency?: string;
  created: number;
  periodStart?: number;
  periodEnd?: number;
}

export function fakeStripe(options: { webhookSecret?: string } = {}) {
  const requests: Recorded[] = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  let seq = 0;
  const next = (prefix: string) => `${prefix}_fake${(++seq).toString().padStart(4, "0")}`;
  const prices = new Map<string, Record<string, unknown>>([
    [
      FAKE_BASE_PRICE,
      {
        id: FAKE_BASE_PRICE,
        object: "price",
        active: true,
        currency: "usd",
        unit_amount: 25000,
        unit_amount_decimal: "25000",
        recurring: { interval: "month", usage_type: "licensed", meter: null },
      },
    ],
    [
      FAKE_OVERAGE_PRICE,
      {
        id: FAKE_OVERAGE_PRICE,
        object: "price",
        active: true,
        currency: "usd",
        unit_amount: null,
        unit_amount_decimal: "1.5",
        recurring: { interval: "month", usage_type: "metered", meter: FAKE_METER },
      },
    ],
  ]);
  const customers = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, Record<string, unknown> & { items: { data: Item[] } }>();
  type Item = { id: string; object: string; quantity?: number; price: { id: string } };
  const items = new Map<string, { subscription: string; item: Item }>();
  const meterEvents: {
    identifier: string;
    event_name: string;
    customer: string;
    value: number;
    timestamp: number;
  }[] = [];
  const invoices: Record<string, unknown>[] = [];
  const failures: { status: number; path?: string }[] = [];

  function handle(
    method: string,
    path: string,
    body: Record<string, unknown>,
    query: Record<string, string>,
  ) {
    const failure = failures.findIndex((f) => !f.path || path.startsWith(f.path));
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      return respond(f?.status ?? 500, {
        error: { type: "api_error", message: "the fake was told to fail" },
      });
    }
    const seg = path.split("/").filter(Boolean); // ["v1", …]
    if (method === "POST" && path === "/v1/customers") {
      const id = next("cus");
      const c = {
        id,
        object: "customer",
        name: body.name ?? null,
        email: body.email ?? null,
        metadata: body.metadata ?? {},
      };
      customers.set(id, c);
      return respond(200, c);
    }
    if (seg[1] === "customers" && seg[2]) {
      const c = customers.get(seg[2]);
      if (!c) return notFound("customer");
      if (method === "POST") {
        if (body.name !== undefined) c.name = body.name;
        if (body.email !== undefined) c.email = body.email;
      }
      return respond(200, c);
    }
    if (method === "GET" && seg[1] === "prices" && seg[2]) {
      const p = prices.get(seg[2]);
      return p ? respond(200, p) : notFound("price");
    }
    if (method === "POST" && path === "/v1/subscriptions") {
      const customer = String(body.customer ?? "");
      if (!customers.has(customer)) return notFound("customer");
      const id = next("sub");
      const wanted = Object.values(
        (body.items ?? {}) as Record<string, { price: string; quantity?: string }>,
      );
      const data: Item[] = [];
      for (const w of wanted) {
        const price = prices.get(w.price);
        if (!price) return notFound("price");
        const metered = (price.recurring as { usage_type?: string }).usage_type === "metered";
        if (metered && w.quantity !== undefined) {
          return respond(400, {
            error: { type: "invalid_request_error", message: "metered prices take no quantity" },
          });
        }
        const item: Item = {
          id: next("si"),
          object: "subscription_item",
          price: { id: w.price },
          ...(metered ? {} : { quantity: Number(w.quantity ?? "1") }),
        };
        items.set(item.id, { subscription: id, item });
        data.push(item);
      }
      const sub = {
        id,
        object: "subscription",
        customer,
        status: "active",
        collection_method: body.collection_method,
        days_until_due: body.days_until_due ? Number(body.days_until_due) : null,
        billing_cycle_anchor: Number(body.billing_cycle_anchor ?? 0),
        metadata: body.metadata ?? {},
        items: { object: "list", data },
      };
      subscriptions.set(id, sub);
      return respond(200, sub);
    }
    if (method === "GET" && seg[1] === "subscriptions" && seg[2]) {
      const s = subscriptions.get(seg[2]);
      return s ? respond(200, s) : notFound("subscription");
    }
    if (method === "POST" && seg[1] === "subscription_items" && seg[2]) {
      const found = items.get(seg[2]);
      if (!found) return notFound("subscription item");
      found.item.quantity = Number(body.quantity ?? found.item.quantity ?? 0);
      return respond(200, found.item);
    }
    if (method === "POST" && path === "/v1/billing/meter_events") {
      const payload = (body.payload ?? {}) as Record<string, string>;
      const identifier = String(body.identifier ?? next("mev"));
      if (meterEvents.some((e) => e.identifier === identifier)) {
        return respond(400, {
          error: {
            type: "invalid_request_error",
            code: "resource_already_exists",
            message: "An event with this identifier already exists",
          },
        });
      }
      const customer = payload.stripe_customer_id ?? "";
      if (!customers.has(customer)) return notFound("customer");
      const event = {
        identifier,
        event_name: String(body.event_name ?? ""),
        customer,
        value: Number(payload.value ?? "0"),
        timestamp: Number(body.timestamp ?? 0),
      };
      meterEvents.push(event);
      return respond(200, {
        object: "billing.meter_event",
        identifier,
        event_name: event.event_name,
        payload,
        timestamp: event.timestamp,
      });
    }
    if (method === "GET" && path === "/v1/invoices") {
      const customer = query.customer;
      const limit = Number(query.limit ?? "10");
      const data = invoices
        .filter((i) => !customer || i.customer === customer)
        .sort((a, b) => Number(b.created) - Number(a.created))
        .slice(0, limit);
      return respond(200, { object: "list", data, has_more: false });
    }
    if (method === "GET" && seg[1] === "invoices" && seg[2]) {
      const i = invoices.find((x) => x.id === seg[2]);
      return i ? respond(200, i) : notFound("invoice");
    }
    return respond(404, {
      error: {
        type: "invalid_request_error",
        message: `Unrecognized request URL (${method}: ${path})`,
      },
    });
  }

  const fetch: FetchLike = async (url: string, init: HttpRequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    requests.push({ url, method, headers, body: init.body });
    const u = parseUrl(url);
    if (u?.origin !== "https://api.stripe.com")
      return respond(404, { error: { message: "unknown host" } });
    if (headers.authorization !== `Bearer ${FAKE_STRIPE_KEY}`) {
      return respond(401, {
        error: { type: "invalid_request_error", message: "Invalid API Key provided" },
      });
    }
    const key = headers["idempotency-key"];
    if (method === "POST" && key) {
      const seen = idempotent.get(key);
      if (seen) return respond(seen.status, seen.body);
    }
    const query = formDecode(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
    const body = method === "POST" ? unflatten(formDecode(init.body ?? "")) : {};
    const res = handle(method, u.pathname, body, query);
    if (method === "POST" && key && res.status < 500) {
      idempotent.set(key, { status: res.status, body: JSON.parse(await res.text()) });
    }
    return res;
  };

  return {
    fetch,
    requests,
    customers,
    subscriptions,
    meterEvents,
    invoices,
    /** Calls to an endpoint (method and path prefix). */
    calls: (method: string, pathPrefix: string) =>
      requests.filter(
        (r) => r.method === method && (parseUrl(r.url)?.pathname ?? "").startsWith(pathPrefix),
      ),
    /** The next request (or the next one to `path`) answers `status`. */
    failNext(status = 500, path?: string) {
      failures.push({ status, ...(path ? { path } : {}) });
    },
    addPrice(price: Record<string, unknown> & { id: string }) {
      prices.set(price.id, price);
    },
    addInvoice(customer: string, input: FakeInvoiceInput) {
      const id = input.id ?? next("in");
      const invoice = {
        id,
        object: "invoice",
        customer,
        number: input.number ?? `MZ-${id.slice(-4)}`,
        status: input.status ?? "open",
        currency: input.currency ?? "usd",
        total: input.total,
        amount_due: input.status === "paid" ? 0 : input.total,
        amount_paid: input.status === "paid" ? input.total : 0,
        created: input.created,
        period_start: input.periodStart ?? input.created,
        period_end: input.periodEnd ?? input.created,
        due_date: input.created + 30 * 86_400,
        hosted_invoice_url: `https://invoice.stripe.com/i/acct_fake/${id}`,
        invoice_pdf: `https://pay.stripe.com/invoice/acct_fake/${id}/pdf`,
      };
      invoices.push(invoice);
      return invoice;
    },
    /** An event as Stripe would POST it, with its Stripe-Signature header. */
    async signedEvent(
      event: { id: string; type: string; object: Record<string, unknown>; created?: number },
      at: Date,
      secret = options.webhookSecret ?? "whsec_fake",
    ) {
      const created = event.created ?? Math.floor(at.getTime() / 1000);
      const payload = JSON.stringify({
        id: event.id,
        object: "event",
        type: event.type,
        created,
        livemode: false,
        data: { object: event.object },
      });
      const header = await stripeSignatureHeader(secret, payload, Math.floor(at.getTime() / 1000));
      return { payload, header };
    },
  };
}

export type FakeStripe = ReturnType<typeof fakeStripe>;
