// A small Stripe API client for Mezonas' own billing (docs/plan.md §1.17, §1.32). Billing is our
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
  due_date: z.number().int().nullish(),
  hosted_invoice_url: z.string().nullish(),
  invoice_pdf: z.string().nullish(),
  metadata: Metadata,
});
export type StripeInvoice = z.infer<typeof StripeInvoice>;

export const StripeInvoiceItem = z.object({
  id: z.string(),
  invoice: z.string().nullish(),
  amount: z.number().int(),
  currency: z.string(),
});
export type StripeInvoiceItem = z.infer<typeof StripeInvoiceItem>;

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

export interface CreateInvoiceInput {
  customerId: string;
  /** Lowercase ISO code, e.g. `usd`. */
  currency: string;
  daysUntilDue: number;
  description: string;
  metadata: Record<string, string>;
}

export interface CreateInvoiceItemInput {
  customerId: string;
  invoiceId: string;
  /** Integer, in the currency's smallest unit (cents); negative for a credit. */
  amount: number;
  currency: string;
  description: string;
  /** Unix seconds: the service period shown on the invoice. */
  period: { start: number; end: number };
  metadata: Record<string, string>;
}

/**
 * Stripe as Mezonas uses it (docs/plan.md §1.32): customers and invoices only. Mezonas works out
 * each bill; Stripe sends it, takes payment and tells us the outcome.
 */
export interface StripeClient {
  createCustomer(
    input: { name: string; email?: string; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeCustomer>;
  updateCustomer(id: string, input: { name?: string; email?: string }): Promise<StripeCustomer>;
  /** A draft invoice that is sent (not charged), advanced by us, with only the items we add. */
  createInvoice(input: CreateInvoiceInput, idempotencyKey: string): Promise<StripeInvoice>;
  /** One line on a draft invoice. */
  createInvoiceItem(
    input: CreateInvoiceItemInput,
    idempotencyKey: string,
  ): Promise<StripeInvoiceItem>;
  finalizeInvoice(id: string, idempotencyKey: string): Promise<StripeInvoice>;
  /** Emails the finalized invoice to the customer, with its hosted page. */
  sendInvoice(id: string, idempotencyKey: string): Promise<StripeInvoice>;
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
    createInvoice: (input, key) =>
      request(
        StripeInvoice,
        "POST",
        "/v1/invoices",
        {
          customer: input.customerId,
          currency: input.currency.toLowerCase(),
          // DECISION: invoices are sent (hosted page, PDF, email from Stripe), not charged to a
          // card on file: v1 has no card collection flow, and clients pay by the hosted link.
          collection_method: "send_invoice",
          days_until_due: input.daysUntilDue,
          // We finalize and send it ourselves, step by step (plan §1.32).
          auto_advance: false,
          // Only the items we add to this invoice, never a customer's other pending items.
          pending_invoice_items_behavior: "exclude",
          description: input.description,
          metadata: input.metadata,
        },
        key,
      ),
    createInvoiceItem: (input, key) =>
      request(
        StripeInvoiceItem,
        "POST",
        "/v1/invoiceitems",
        {
          customer: input.customerId,
          invoice: input.invoiceId,
          amount: input.amount,
          currency: input.currency.toLowerCase(),
          description: input.description,
          period: { start: input.period.start, end: input.period.end },
          metadata: input.metadata,
        },
        key,
      ),
    finalizeInvoice: (invoiceId, key) =>
      request(
        StripeInvoice,
        "POST",
        `/v1/invoices/${id(invoiceId)}/finalize`,
        { auto_advance: false },
        key,
      ),
    sendInvoice: (invoiceId, key) =>
      request(StripeInvoice, "POST", `/v1/invoices/${id(invoiceId)}/send`, {}, key),
    getInvoice: (invoiceId) => request(StripeInvoice, "GET", `/v1/invoices/${id(invoiceId)}`),
  };
}

/** Money in a currency's smallest unit (an integer), from a decimal amount: `12.3400` USD → 1234. */
export function toMinorUnits(amount: Money): number {
  const c = amount.currency.toLowerCase();
  const minor = ZERO_DECIMAL.has(c)
    ? new Decimal(amount.amount)
    : new Decimal(amount.amount).times(100);
  if (!minor.isInteger()) {
    throw new RangeError(
      `${amount.amount} ${amount.currency} is not a whole number of minor units`,
    );
  }
  return minor.toNumber();
}
