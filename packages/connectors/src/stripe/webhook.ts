// Stripe webhooks: the `Stripe-Signature` header is `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`, where
// each v1 is HMAC-SHA256 of `<t>.<raw body>` under the endpoint's signing secret (`whsec_…`). A
// signature is accepted within a tolerance of the timestamp, so a captured delivery can't be
// replayed later; the event id makes applying it idempotent (apps/api stores each id once).

import { z } from "zod";
import { constantTimeEqual, hmacSha256Hex } from "../http";
import { fromMinorUnits } from "./client";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
/** Stripe's libraries default to five minutes. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Stripe's events are small; anything bigger is refused unread. */
export const STRIPE_WEBHOOK_MAX_BYTES = 256 * 1024;

export type StripeSignatureResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

/** Checks a delivery's `Stripe-Signature` against the raw body (exactly as received). */
export async function verifyStripeSignature(input: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): Promise<StripeSignatureResult> {
  if (!input.header) return { ok: false, reason: "missing" };
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: "malformed" };
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  const age = Math.floor(input.now.getTime() / 1000) - timestamp;
  // DECISION: a timestamp too far in the future is refused like one too old (Stripe's libraries
  // only check age); clocks that far apart mean something is wrong.
  if (Math.abs(age) > tolerance) return { ok: false, reason: "expired" };
  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.payload}`);
  // Every v1 is checked (Stripe sends more than one while a secret is being rolled).
  let match = false;
  for (const s of signatures) if (constantTimeEqual(s, expected)) match = true;
  return match ? { ok: true, timestamp } : { ok: false, reason: "mismatch" };
}

/** The `Stripe-Signature` header for a payload (tests and the fake Stripe sign with it). */
export async function stripeSignatureHeader(
  secret: string,
  payload: string,
  timestamp: number,
): Promise<string> {
  return `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${payload}`)}`;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────

export const StripeEvent = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]+$/),
  type: z.string().max(200),
  created: z.number().int(),
  livemode: z.boolean().optional(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEvent = z.infer<typeof StripeEvent>;

/**
 * The events billing acts on (docs/plan.md §1.32): an invoice we sent is finalized, paid, failed,
 * voided or marked uncollectible. Others are acknowledged and dropped.
 */
export const STRIPE_HANDLED_EVENTS = [
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
] as const;
export type StripeHandledEvent = (typeof STRIPE_HANDLED_EVENTS)[number];

export function isHandledStripeEvent(type: string): type is StripeHandledEvent {
  return (STRIPE_HANDLED_EVENTS as readonly string[]).includes(type);
}

const InvoiceObject = z.object({
  id: z.string(),
  customer: z.string(),
  number: z.string().nullish(),
  status: z.string().nullish(),
  currency: z.string(),
  total: z.number().int(),
  amount_paid: z.number().int().optional(),
  amount_due: z.number().int().optional(),
  due_date: z.number().int().nullish(),
  hosted_invoice_url: z.string().nullish(),
  invoice_pdf: z.string().nullish(),
  metadata: z.record(z.string(), z.string()).nullish(),
});

/** What an invoice event means for its statement. */
export type InvoiceOutcome = "finalized" | "paid" | "payment_failed" | "voided" | "uncollectible";

const OUTCOME: Record<StripeHandledEvent, InvoiceOutcome> = {
  "invoice.finalized": "finalized",
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.voided": "voided",
  "invoice.marked_uncollectible": "uncollectible",
};

export interface StripeEventSummary {
  kind: "invoice";
  outcome: InvoiceOutcome;
  customerId: string;
  objectId: string;
  number: string | null;
  status: string | null;
  /** The invoice's total as a decimal string, and its currency (upper case). */
  total: string;
  currency: string;
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  /** ISO time, or null. */
  dueAt: string | null;
  /** What we set on the invoice: our statement and client. */
  statementId: string | null;
  tenantId: string | null;
}

/** What billing reads from a handled event, or null when its object isn't what we expect. */
export function summarizeStripeEvent(event: StripeEvent): StripeEventSummary | null {
  if (!isHandledStripeEvent(event.type)) return null;
  const i = InvoiceObject.safeParse(event.data.object);
  if (!i.success) return null;
  const total = fromMinorUnits(i.data.total, i.data.currency);
  const meta = i.data.metadata ?? {};
  return {
    kind: "invoice",
    outcome: OUTCOME[event.type],
    customerId: i.data.customer,
    objectId: i.data.id,
    number: i.data.number ?? null,
    status: i.data.status ?? null,
    total: total.amount,
    currency: total.currency,
    hostedInvoiceUrl: i.data.hosted_invoice_url ?? null,
    pdfUrl: i.data.invoice_pdf ?? null,
    dueAt: i.data.due_date ? new Date(i.data.due_date * 1000).toISOString() : null,
    statementId: meta.statement_id ?? null,
    tenantId: meta.tenant_id ?? null,
  };
}
