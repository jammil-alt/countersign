import { z } from "zod";
import { MeasureName, UnitCost } from "../billing";
import { isUuid } from "../ids";
import { DecimalString, MoneySchema } from "../money";
import { defineRoute } from "./contract";

// Billing (docs/plan.md §1.17, §1.24). The back office sets the billing settings, sets up each
// client in Stripe and sees each client's period with what it cost us (operator only). The
// client admin sees the plan, the allowance, the credits used this period and the invoices, never
// our cost, tokens or prompts (invariant 11): credits are the billing unit, not a cost field.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A Stripe object id (`price_…`, `cus_…`): letters, digits and underscores. */
const StripeId = z.string().regex(/^[A-Za-z0-9_]{3,255}$/, "a Stripe id");

// ── Shared ───────────────────────────────────────────────────────────────────────────────────────

export const BillingPeriod = z.object({
  start: IsoDay,
  end: IsoDay,
  /** The last day counted so far. */
  through: IsoDay,
});

/** An invoice as Stripe has it, with its hosted page and PDF. */
export const BillingInvoice = z.object({
  id: z.string(),
  number: z.string().nullable(),
  /** draft, open, paid, uncollectible, void. */
  status: z.string().nullable(),
  total: MoneySchema,
  amountDue: MoneySchema,
  createdAt: z.string(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  dueAt: z.string().nullable(),
  hostedInvoiceUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
});
export type BillingInvoice = z.infer<typeof BillingInvoice>;

// ── Back office ──────────────────────────────────────────────────────────────────────────────────

export const BillingSettings = z.object({
  allowanceCreditsPerAgent: z.number().int().min(0).max(100_000_000),
  basePriceId: StripeId.nullable(),
  overagePriceId: StripeId.nullable(),
  meterEventName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, "letters, digits, _ . -"),
  daysUntilDue: z.number().int().min(1).max(365),
  unitCosts: z.array(UnitCost).max(50),
});
export type BillingSettings = z.infer<typeof BillingSettings>;

export const BillingSettingsView = BillingSettings.extend({
  /** From the Stripe prices when the ids were saved; null until then. */
  baseFee: MoneySchema.nullable(),
  overagePrice: MoneySchema.nullable(),
  updatedAt: z.string(),
});
export type BillingSettingsView = z.infer<typeof BillingSettingsView>;

export const BillingMeasure = z.object({
  measure: MeasureName,
  /** usage_daily has this column, so it counts now. */
  available: z.boolean(),
  /** It has a unit cost, so it is billed. */
  priced: z.boolean(),
});

/** A client's billing period so far, with what it cost us (operator only). */
export const OpsBillingClient = z.object({
  id: z.string(),
  name: z.string(),
  setUp: z.boolean(),
  customerId: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  /** The base quantity Stripe has, and the active client agents now. */
  billedAgents: z.number().int(),
  activeAgents: z.number().int(),
  period: BillingPeriod,
  /** Base fee × active agents, from the price snapshot. */
  base: MoneySchema.nullable(),
  allowance: z.number().int(),
  creditsUsed: z.number().int(),
  overageCredits: z.number().int(),
  /** Overage credits reported to Stripe so far this period. */
  reportedCredits: z.number().int(),
  /** What the period's work cost us so far, as priced (USD). */
  costUsd: DecimalString,
  lastInvoice: z
    .object({
      id: z.string(),
      number: z.string().nullable(),
      status: z.enum(["paid", "payment_failed"]),
      at: z.string(),
    })
    .nullable(),
});
export type OpsBillingClient = z.infer<typeof OpsBillingClient>;

export const OpsBilling = z.object({
  /** STRIPE_SECRET_KEY is set: billing can call Stripe. */
  stripeConfigured: z.boolean(),
  /** STRIPE_WEBHOOK_SECRET is set: Stripe's events are accepted. */
  webhookConfigured: z.boolean(),
  settings: BillingSettingsView,
  measures: z.array(BillingMeasure),
  clients: z.array(OpsBillingClient),
});
export type OpsBilling = z.infer<typeof OpsBilling>;

export const BillingReportRow = z.object({
  id: z.string(),
  day: IsoDay,
  agents: z.number().int(),
  allowance: z.number().int(),
  credits: z.number().int(),
  overage: z.number().int(),
  quantity: z.number().int(),
  costUsd: DecimalString,
  status: z.enum(["pending", "sent", "failed", "none"]),
  error: z.string().nullable(),
  sentAt: z.string().nullable(),
});

export const OpsBillingClientDetail = z.object({
  stripeConfigured: z.boolean(),
  client: OpsBillingClient,
  /** This period's daily reports, newest first. */
  reports: z.array(BillingReportRow),
  invoices: z.array(BillingInvoice),
  /** Stripe couldn't be reached for the invoices. */
  invoicesUnavailable: z.boolean(),
  events: z.array(
    z.object({ id: z.string(), type: z.string(), objectId: z.string().nullable(), at: z.string() }),
  ),
});
export type OpsBillingClientDetail = z.infer<typeof OpsBillingClientDetail>;

export const BillingSyncResult = z.object({
  quantity: z.object({ before: z.number().int(), after: z.number().int(), changed: z.boolean() }),
  report: z
    .object({
      day: IsoDay,
      status: z.enum(["pending", "sent", "failed", "none"]),
      quantity: z.number().int(),
      repeated: z.boolean(),
    })
    .nullable(),
});
export type BillingSyncResult = z.infer<typeof BillingSyncResult>;

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

export const PortalBilling = z.object({
  setUp: z.boolean(),
  plan: z
    .object({
      agents: z.number().int(),
      baseFee: MoneySchema.nullable(),
      /** baseFee × agents. */
      monthly: MoneySchema.nullable(),
    })
    .nullable(),
  period: BillingPeriod,
  allowance: z.number().int(),
  creditsUsed: z.number().int(),
  extraCredits: z.number().int(),
  /** The price of one credit beyond the allowance. */
  extraCreditPrice: MoneySchema.nullable(),
  /** The last payment did not go through. */
  paymentProblem: z.boolean(),
  invoices: z.array(BillingInvoice),
  invoicesUnavailable: z.boolean(),
});
export type PortalBilling = z.infer<typeof PortalBilling>;

export const StripeWebhookResponse = z.object({
  received: z.literal(true),
  /** Seen before: stored once, applied once. */
  duplicate: z.boolean(),
  /** For a client we bill and of a type we act on. */
  handled: z.boolean(),
});

export const billingRoutes = {
  opsBilling: defineRoute({
    method: "GET",
    path: "/api/ops/billing",
    auth: "session",
    roles: OPS,
    summary:
      "Billing: the settings (unit costs, allowance, Stripe prices) and each client's period so far",
    query: z.object({ client: Id.optional() }),
    response: OpsBilling,
  }),
  opsBillingSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/billing/settings",
    auth: "session",
    roles: OPS,
    summary: "Save the billing settings; the Stripe prices are checked and their amounts kept",
    body: BillingSettings,
    response: BillingSettingsView,
  }),
  opsBillingClient: defineRoute({
    method: "GET",
    path: "/api/ops/billing/clients/:id",
    auth: "session",
    roles: OPS,
    summary: "One client's billing: its period so far, daily usage reports, invoices and events",
    params: z.object({ id: Id }),
    response: OpsBillingClientDetail,
  }),
  opsBillingSetup: defineRoute({
    method: "POST",
    path: "/api/ops/billing/clients/:id/setup",
    auth: "session",
    roles: OPS,
    summary:
      "Set up billing for a client: a Stripe customer and a subscription (base fee per active agent, plus overage)",
    params: z.object({ id: Id }),
    body: z.object({ email: z.email().max(320).optional() }),
    response: OpsBillingClient,
  }),
  opsBillingSync: defineRoute({
    method: "POST",
    path: "/api/ops/billing/clients/:id/sync",
    auth: "session",
    roles: OPS,
    summary:
      "Bring a client's billing up to date now: the agent count, and yesterday's usage report",
    params: z.object({ id: Id }),
    response: BillingSyncResult,
  }),
  portalBilling: defineRoute({
    method: "GET",
    path: "/api/billing",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Your plan, your credit allowance, credits used this period and your invoices (client admin)",
    response: PortalBilling,
  }),
  stripeWebhook: defineRoute({
    method: "POST",
    path: "/api/billing/stripe/webhook",
    auth: "public",
    roles: [],
    summary:
      "Stripe's events, signed (Stripe-Signature): invoice paid or failed, subscription changes",
    response: StripeWebhookResponse,
  }),
} as const;
