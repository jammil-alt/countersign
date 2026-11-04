// A small Stripe API client for Mezonas' own billing (docs/plan.md §1.17, §1.24). Billing is our
// infrastructure, not a client's tool: there is no connector manifest and no agent tool here, and
// agents never reach it. `fetch` is injected (FetchLike); tests use `fakeStripe` from
// `@countersign/connectors/testing`. Endpoint, field and event names are recorded in ./NOTES.md,
// with what could not be checked against Stripe's docs from the build environment.

import { Decimal, type Money, money } from "@countersign/core";
import { z } from "zod";
import { type FetchLike, timeoutSignal } from "../http";

export const STRIPE_API_BASE = "https://api.stripe.com";

export class StripeError extends Error {
  constructor(
    readonly status: number,
    /** Stripe's `error.type` (`invalid_request_error`, `card_error`, …) or `network`/`invalid_response`. */
    readonly type: string,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StripeError";
  }
}

// ── Form encoding ────────────────────────────────────────────────────────────────────────────────

type FormValue = string | number | boolean | null | undefined | FormObject | FormValue[];
interface FormObject {
  [key: string]: FormValue;
}

/**
 * Stripe's request bodies: `application/x-www-form-urlencoded` with nested keys in brackets
 * (`items[0][price]=…`, `metadata[tenant_id]=…`). Undefined and null values are left out.
 */
export function stripeForm(params: FormObject): string {
  const pairs: string[] = [];
  const add = (key: string, value: FormValue) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        add(`${key}[${i}]`, v);
      });
      return;
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
      return;
    }
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return pairs.join("&");
}

// ── Money ────────────────────────────────────────────────────────────────────────────────────────

/** Currencies Stripe counts in whole units (no cents); NOTES.md. */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "ugx",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);

/**
 * Stripe's amount in the currency's smallest unit (an integer, or `unit_amount_decimal`'s decimal
 * string) as Money: `25000` usd → `250.0000 USD`. Never a float: integers go through their decimal
 * string.
 */
export function fromMinorUnits(amount: number | string, currency: string): Money {
  const minor = new Decimal(typeof amount === "number" ? amount.toFixed(0) : amount);
  const c = currency.toLowerCase();
  const major = ZERO_DECIMAL.has(c) ? minor : minor.div(100);
  return money(major, c.toUpperCase());
}

// ── Response shapes (only what we read) ──────────────────────────────────────────────────────────

const Metadata = z.record(z.string(), z.string()).nullish();

export const StripeCustomer = z.object({
  id: z.string(),
  name: z.string().nullish(),
  email: z.string().nullish(),
  metadata: Metadata,
});
export type StripeCustomer = z.infer<typeof StripeCustomer>;

export const StripePrice = z.object({
  id: z.string(),
  active: z.boolean().optional(),
  currency: z.string(),
  unit_amount: z.number().int().nullish(),
  unit_amount_decimal: z.string().nullish(),
  recurring: z
    .object({
      interval: z.string(),
      usage_type: z.string().nullish(),
      meter: z.string().nullish(),
    })
    .nullish(),
});
export type StripePrice = z.infer<typeof StripePrice>;

const SubscriptionItem = z.object({
  id: z.string(),
  quantity: z.number().int().nullish(),
  price: z.object({ id: z.string() }),
});

export const StripeSubscription = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  items: z.object({ data: z.array(SubscriptionItem) }),
  metadata: Metadata,
});
export type StripeSubscription = z.infer<typeof StripeSubscription>;

export const StripeMeterEvent = z.object({
  identifier: z.string(),
  event_name: z.string(),
});

export const StripeInvoice = z.object({
  id: z.string(),
  customer: z.string().nullish(),
  number: z.string().nullish(),
  status: z.string().nullish(),
  currency: z.string(),
  total: z.number().int(),
  amount_due: z.number().int(),
  amount_paid: z.number().int().optional(),
  created: z.number().int(),
  period_start: z.number().int().nullish(),
  period_end: z.number().int().nullish(),
  due_date: z.number().int().nullish(),
  hosted_invoice_url: z.string().nullish(),
  invoice_pdf: z.string().nullish(),
});
export type StripeInvoice = z.infer<typeof StripeInvoice>;

const InvoiceList = z.object({ data: z.array(StripeInvoice), has_more: z.boolean().optional() });

const ErrorBody = z.object({
  error: z.object({
    type: z.string().optional(),
    code: z.string().nullish(),
    message: z.string().optional(),
  }),
});

// ── The client ───────────────────────────────────────────────────────────────────────────────────

export interface StripeClientOptions {
  secretKey: string;
  fetch: FetchLike;
  apiBase?: string;
  /** Sent as `Stripe-Version` when set; otherwise the account's default version applies. */
  apiVersion?: string;
  timeoutMs?: number;
}

export interface CreateSubscriptionInput {
  customerId: string;
  basePriceId: string;
  quantity: number;
  overagePriceId: string;
  /** Unix seconds: the 1st of next month, so periods are calendar months. */
  billingCycleAnchor: number;
  daysUntilDue: number;
  metadata: Record<string, string>;
}

export interface StripeClient {
  createCustomer(
    input: { name: string; email?: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeCustomer>;
  updateCustomer(id: string, input: { name?: string; email?: string }): Promise<StripeCustomer>;
  getPrice(id: string): Promise<StripePrice>;
  createSubscription(
    input: CreateSubscriptionInput,
    idempotencyKey: string,
  ): Promise<StripeSubscription>;
  getSubscription(id: string): Promise<StripeSubscription>;
  /** Sets a licensed item's quantity (absolute, so repeating it is harmless). */
  setItemQuantity(itemId: string, quantity: number): Promise<{ id: string; quantity: number }>;
  /** Reports usage to a billing meter; `identifier` is also the idempotency key. */
  createMeterEvent(input: {
    eventName: string;
    customerId: string;
    value: number;
    identifier: string;
    timestamp: number;
  }): Promise<{ identifier: string }>;
  listInvoices(customerId: string, limit?: number): Promise<StripeInvoice[]>;
  getInvoice(id: string): Promise<StripeInvoice>;
}

export function createStripeClient(options: StripeClientOptions): StripeClient {
  const base = (options.apiBase ?? STRIPE_API_BASE).replace(/\/$/, "");

  async function request<T>(
    schema: z.ZodType<T>,
    method: "GET" | "POST",
    path: string,
    params: FormObject = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const form = stripeForm(params);
    const url = method === "GET" && form ? `${base}${path}?${form}` : `${base}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.secretKey}`,
      accept: "application/json",
    };
    if (options.apiVersion) headers["stripe-version"] = options.apiVersion;
    if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await options.fetch(url, {
        method,
        headers,
        ...(method === "POST" ? { body: form } : {}),
        redirect: "error",
        signal: timeoutSignal(options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      throw new StripeError(0, "network", null, `Stripe could not be reached: ${String(error)}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new StripeError(res.status, "invalid_response", null, "Stripe answered with no JSON");
    }
    if (!res.ok) {
      const e = ErrorBody.safeParse(body);
      throw new StripeError(
        res.status,
        e.success ? (e.data.error.type ?? "api_error") : "api_error",
        e.success ? (e.data.error.code ?? null) : null,
        e.success
          ? (e.data.error.message ?? `Stripe answered ${res.status}`)
          : `HTTP ${res.status}`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new StripeError(res.status, "invalid_response", null, z.prettifyError(parsed.error));
    }
    return parsed.data;
  }

  const id = (v: string) => encodeURIComponent(v);

  return {
    createCustomer: (input, key) =>
      request(
        StripeCustomer,
        "POST",
        "/v1/customers",
        { name: input.name, email: input.email, metadata: input.metadata },
        key,
      ),
    updateCustomer: (customerId, input) =>
      request(StripeCustomer, "POST", `/v1/customers/${id(customerId)}`, {
        name: input.name,
        email: input.email,
      }),
    getPrice: (priceId) => request(StripePrice, "GET", `/v1/prices/${id(priceId)}`),
    createSubscription: (input, key) =>
      request(
        StripeSubscription,
        "POST",
        "/v1/subscriptions",
        {
          customer: input.customerId,
          // The metered overage item takes no quantity (Stripe counts its meter's events).
          items: [
            { price: input.basePriceId, quantity: input.quantity },
            { price: input.overagePriceId },
          ],
          billing_cycle_anchor: input.billingCycleAnchor,
          proration_behavior: "create_prorations",
          // DECISION: invoices are sent (hosted page, PDF, email from Stripe), not charged to a
          // card on file: v1 has no card collection flow, and clients pay by the hosted link.
          collection_method: "send_invoice",
          days_until_due: input.daysUntilDue,
          metadata: input.metadata,
        },
        key,
      ),
    getSubscription: (subId) =>
      request(StripeSubscription, "GET", `/v1/subscriptions/${id(subId)}`),
    setItemQuantity: async (itemId, quantity) => {
      const item = await request(SubscriptionItem, "POST", `/v1/subscription_items/${id(itemId)}`, {
        quantity,
        proration_behavior: "create_prorations",
      });
      return { id: item.id, quantity: item.quantity ?? quantity };
    },
    createMeterEvent: (input) =>
      request(
        StripeMeterEvent,
        "POST",
        "/v1/billing/meter_events",
        {
          event_name: input.eventName,
          payload: { stripe_customer_id: input.customerId, value: String(input.value) },
          identifier: input.identifier,
          timestamp: input.timestamp,
        },
        input.identifier,
      ),
    listInvoices: async (customerId, limit = 24) =>
      (
        await request(InvoiceList, "GET", "/v1/invoices", {
          customer: customerId,
          limit: Math.min(Math.max(limit, 1), 100),
        })
      ).data,
    getInvoice: (invoiceId) => request(StripeInvoice, "GET", `/v1/invoices/${id(invoiceId)}`),
  };
}

/** An invoice for the screens: amounts as Money, times as ISO strings, the hosted links. */
export function invoiceView(i: StripeInvoice) {
  const iso = (s: number | null | undefined) => (s ? new Date(s * 1000).toISOString() : null);
  return {
    id: i.id,
    number: i.number ?? null,
    status: i.status ?? null,
    total: fromMinorUnits(i.total, i.currency),
    amountDue: fromMinorUnits(i.amount_due, i.currency),
    createdAt: new Date(i.created * 1000).toISOString(),
    periodStart: iso(i.period_start),
    periodEnd: iso(i.period_end),
    dueAt: iso(i.due_date),
    hostedInvoiceUrl: i.hosted_invoice_url ?? null,
    pdfUrl: i.invoice_pdf ?? null,
  };
}

/** A price's amount per unit as Money (`unit_amount_decimal` first: it allows fractions of a cent). */
export function priceAmount(p: StripePrice): Money | null {
  const amount = p.unit_amount_decimal ?? p.unit_amount ?? null;
  return amount === null ? null : fromMinorUnits(amount, p.currency);
}
