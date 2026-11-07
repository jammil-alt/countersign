// A fake Stripe for tests (`@countersign/connectors/testing`): customers, draft invoices, invoice
// items, finalizing and sending, in memory, behind the same HTTP shapes the client uses (form
// bodies, Bearer key, Idempotency-Key replays). Never imported by the Worker.

import type { FetchLike, HttpRequestInit, HttpResponseLike } from "../http";
import { formDecode, parseUrl } from "../http";
import { stripeSignatureHeader } from "./webhook";

export const FAKE_STRIPE_KEY = "sk_test_fake";

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

const invalid = (message: string) =>
  respond(400, { error: { type: "invalid_request_error", message } });

/** `metadata[tenant_id]` → nested objects, as Stripe reads a form. */
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

export interface FakeInvoice {
  id: string;
  object: "invoice";
  customer: string;
  number: string | null;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  currency: string;
  total: number;
  amount_due: number;
  amount_paid: number;
  created: number;
  due_date: number | null;
  collection_method: string;
  days_until_due: number | null;
  auto_advance: boolean;
  pending_invoice_items_behavior: string | null;
  description: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  metadata: Record<string, string>;
  /** Fake only: how many times it was sent (emailed). */
  sent: number;
  lines: FakeInvoiceItem[];
}

export interface FakeInvoiceItem {
  id: string;
  object: "invoiceitem";
  customer: string;
  invoice: string | null;
  amount: number;
  currency: string;
  description: string | null;
  period: { start: number; end: number } | null;
  metadata: Record<string, string>;
}

export function fakeStripe(options: { webhookSecret?: string; now?: () => Date } = {}) {
  const requests: Recorded[] = [];
  const idempotent = new Map<string, { status: number; body: unknown }>();
  let seq = 0;
  let numbers = 0;
  const now = () => Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const next = (prefix: string) => `${prefix}_fake${(++seq).toString().padStart(4, "0")}`;
  const customers = new Map<string, Record<string, unknown>>();
  const invoices = new Map<string, FakeInvoice>();
  const items = new Map<string, FakeInvoiceItem>();
  const failures: { status: number; path?: string }[] = [];

  const view = (i: FakeInvoice) => {
    const { sent: _sent, lines, ...rest } = i;
    return { ...rest, lines: { object: "list", data: lines } };
  };

  function handle(method: string, path: string, body: Record<string, unknown>) {
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
    if (method === "POST" && path === "/v1/invoices") {
      const customer = String(body.customer ?? "");
      if (!customers.has(customer)) return notFound("customer");
      if (body.collection_method === "send_invoice" && !body.days_until_due) {
        return invalid("days_until_due is required with send_invoice");
      }
      const id = next("in");
      const invoice: FakeInvoice = {
        id,
        object: "invoice",
        customer,
        number: null,
        status: "draft",
        currency: String(body.currency ?? "usd"),
        total: 0,
        amount_due: 0,
        amount_paid: 0,
        created: now(),
        due_date: null,
        collection_method: String(body.collection_method ?? "charge_automatically"),
        days_until_due: body.days_until_due ? Number(body.days_until_due) : null,
        auto_advance: body.auto_advance === "true",
        pending_invoice_items_behavior: (body.pending_invoice_items_behavior as string) ?? null,
        description: (body.description as string) ?? null,
        hosted_invoice_url: null,
        invoice_pdf: null,
        metadata: (body.metadata as Record<string, string>) ?? {},
        sent: 0,
        lines: [],
      };
      invoices.set(id, invoice);
      return respond(200, view(invoice));
    }
    if (method === "POST" && path === "/v1/invoiceitems") {
      const customer = String(body.customer ?? "");
      if (!customers.has(customer)) return notFound("customer");
      const invoiceId = body.invoice ? String(body.invoice) : null;
      const invoice = invoiceId ? invoices.get(invoiceId) : undefined;
      if (invoiceId && !invoice) return notFound("invoice");
      if (invoice && invoice.status !== "draft") {
        return invalid("invoice items can only be added to a draft invoice");
      }
      if (!/^-?\d+$/.test(String(body.amount ?? ""))) return invalid("amount must be an integer");
      const period = body.period as { start?: string; end?: string } | undefined;
      const item: FakeInvoiceItem = {
        id: next("ii"),
        object: "invoiceitem",
        customer,
        invoice: invoiceId,
        amount: Number(body.amount),
        currency: String(body.currency ?? "usd"),
        description: (body.description as string) ?? null,
        period: period ? { start: Number(period.start), end: Number(period.end) } : null,
        metadata: (body.metadata as Record<string, string>) ?? {},
      };
      items.set(item.id, item);
      if (invoice) {
        invoice.lines.push(item);
        invoice.total += item.amount;
        invoice.amount_due = invoice.total;
      }
      return respond(200, item);
    }
    if (seg[1] === "invoices" && seg[2]) {
      const invoice = invoices.get(seg[2]);
      if (!invoice) return notFound("invoice");
      if (method === "GET" && !seg[3]) return respond(200, view(invoice));
      if (method === "POST" && seg[3] === "finalize") {
        if (invoice.status !== "draft") return invalid("this invoice is already finalized");
        invoice.status = "open";
        invoice.number = `MZ-${String(++numbers).padStart(4, "0")}`;
        invoice.due_date = now() + (invoice.days_until_due ?? 30) * 86_400;
        invoice.hosted_invoice_url = `https://invoice.stripe.com/i/acct_fake/${invoice.id}`;
        invoice.invoice_pdf = `https://pay.stripe.com/invoice/acct_fake/${invoice.id}/pdf`;
        return respond(200, view(invoice));
      }
      if (method === "POST" && seg[3] === "send") {
        if (invoice.status !== "open") return invalid("only open invoices can be sent");
        invoice.sent += 1;
        return respond(200, view(invoice));
      }
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
    // Stripe replays the first answer to a key (unless that answer was a server error).
    const key = headers["idempotency-key"];
    if (method === "POST" && key) {
      const seen = idempotent.get(key);
      if (seen) return respond(seen.status, seen.body);
    }
    const body = method === "POST" ? unflatten(formDecode(init.body ?? "")) : {};
    const res = handle(method, u.pathname, body);
    if (method === "POST" && key && res.status < 500) {
      idempotent.set(key, { status: res.status, body: JSON.parse(await res.text()) });
    }
    return res;
  };

  return {
    fetch,
    requests,
    customers,
    invoices,
    items,
    /** Calls to an endpoint (method and path prefix). */
    calls: (method: string, pathPrefix: string) =>
      requests.filter(
        (r) => r.method === method && (parseUrl(r.url)?.pathname ?? "").startsWith(pathPrefix),
      ),
    /** The next request (or the next one to a path starting with `path`) answers `status`. */
    failNext(status = 500, path?: string) {
      failures.push({ status, ...(path ? { path } : {}) });
    },
    /** What happens in Stripe's dashboard or on the hosted page: an invoice changes status. */
    setInvoiceStatus(id: string, status: FakeInvoice["status"]) {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error(`no fake invoice ${id}`);
      invoice.status = status;
      if (status === "paid") {
        invoice.amount_paid = invoice.total;
        invoice.amount_due = 0;
      }
      return view(invoice);
    },
    /** An invoice as an event's `data.object`. */
    invoiceObject(id: string): Record<string, unknown> {
      const invoice = invoices.get(id);
      if (!invoice) throw new Error(`no fake invoice ${id}`);
      return view(invoice) as unknown as Record<string, unknown>;
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
