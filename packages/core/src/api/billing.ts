import { z } from "zod";
import { MeasureName, PRICE_SOURCES, UnitCost } from "../billing";
import { isUuid } from "../ids";
import { DecimalString, MoneySchema } from "../money";
import { defineRoute } from "./contract";

// Billing (docs/plan.md §1.17, §1.32). Mezonas works out each client's bill; Stripe only holds the
// customer and the invoice. The back office sets prices (defaults, templates, client agents), sees
// each client's month so far with what it cost us, and reviews, adjusts, sends or voids the monthly
// statements (operator only). The client admin sees the month so far by service, the credits and
// past statements, never our cost, tokens or prompts (invariant 11): credits are the billing unit,
// not a cost field.

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A USD amount the operator types: up to 4 places, not negative. */
const Price = DecimalString.refine((v) => !v.startsWith("-"), "not negative");
const Credits = z.number().int().min(0).max(100_000_000);

// ── Shared ───────────────────────────────────────────────────────────────────────────────────────

export const BillingPeriod = z.object({
  start: IsoDay,
  end: IsoDay,
  /** The last day counted so far. */
  through: IsoDay,
});

export const PriceSourceSchema = z.enum(PRICE_SOURCES);

/** A monthly price and the credits it includes. */
export const PriceView = z.object({ monthlyPrice: MoneySchema, includedCredits: z.number().int() });
export type PriceView = z.infer<typeof PriceView>;

/** The price an agent has, and where it comes from (its own, its template's, platform, default). */
export const AgentPriceView = PriceView.extend({ source: PriceSourceSchema });
export type AgentPriceView = z.infer<typeof AgentPriceView>;

export const STATEMENT_STATUSES = [
  "draft",
  "sent",
  "paid",
  "payment_failed",
  "void",
  "nothing_due",
] as const;
export const StatementStatus = z.enum(STATEMENT_STATUSES);
export type StatementStatus = z.infer<typeof StatementStatus>;

/** One line of a statement (or of the month so far, where lines have no id yet). */
export const StatementLine = z.object({
  id: z.string().nullable(),
  kind: z.enum(["agent", "usage", "adjustment"]),
  agentId: z.string().nullable(),
  /** The agent's name, "Extra usage", or the operator's words for an adjustment. */
  description: z.string(),
  amount: MoneySchema,
  /** Agent lines: days billed this month, and each monthly price with its days. */
  days: z.number().int().nullable(),
  prices: z.array(z.object({ monthlyPrice: MoneySchema, days: z.number().int() })),
});
export type StatementLine = z.infer<typeof StatementLine>;

/** What a month comes to so far, from the days recorded and the credits used up to now. */
export const MonthSoFar = z.object({
  period: BillingPeriod,
  daysInMonth: z.number().int(),
  lines: z.array(StatementLine),
  creditsUsed: z.number().int(),
  creditsIncluded: z.number().int(),
  extraCredits: z.number().int(),
  /** The price of one credit beyond the included ones. */
  creditPrice: MoneySchema,
  total: MoneySchema,
});
export type MonthSoFar = z.infer<typeof MonthSoFar>;

const StatementBase = z.object({
  id: z.string(),
  period: z.object({ start: IsoDay, end: IsoDay }),
  status: StatementStatus,
  total: MoneySchema,
  creditsUsed: z.number().int(),
  creditsIncluded: z.number().int(),
  extraCredits: z.number().int(),
  creditPrice: MoneySchema,
  lines: z.array(StatementLine),
  invoiceNumber: z.string().nullable(),
  /** Stripe's hosted invoice page and PDF, once the invoice is finalized. */
  hostedInvoiceUrl: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  dueAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  paidAt: z.string().nullable(),
});

/** A statement as the client admin sees it. */
export const PortalStatement = StatementBase;
export type PortalStatement = z.infer<typeof PortalStatement>;

/** A statement in the back office: with what is left to do and why a send stopped. */
export const OpsStatement = StatementBase.extend({
  clientId: z.string(),
  clientName: z.string(),
  /** A draft whose send hasn't started: adjustments can be added or removed, and it can be voided. */
  editable: z.boolean(),
  /** Stripe has the invoice; sending again resumes where it stopped. */
  sendStarted: z.boolean(),
  sendError: z.string().nullable(),
  stripeInvoiceId: z.string().nullable(),
  voidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type OpsStatement = z.infer<typeof OpsStatement>;

// ── Back office ──────────────────────────────────────────────────────────────────────────────────

export const BillingSettings = z.object({
  /** The monthly price of an agent with no price of its own or from its template (USD). */
  defaultAgentPrice: Price,
  defaultIncludedCredits: Credits,
  /** The price of one credit beyond a client's included credits (USD). */
  creditPrice: Price,
  /** Send each month's statements as soon as they are built. */
  autoSend: z.boolean(),
  daysUntilDue: z.number().int().min(1).max(365),
  unitCosts: z.array(UnitCost).max(50),
});
export type BillingSettings = z.infer<typeof BillingSettings>;

export const BillingSettingsView = BillingSettings.extend({ updatedAt: z.string() });
export type BillingSettingsView = z.infer<typeof BillingSettingsView>;

export const BillingMeasure = z.object({
  measure: MeasureName,
  /** usage_daily has this column, so it counts now. */
  available: z.boolean(),
  /** It has a unit cost, so it is billed. */
  priced: z.boolean(),
});

export const TemplatePriceRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** The template's own price; null: its client agents take the default (or platform's $0). */
  price: PriceView.nullable(),
  /** What its client agents get without an override. */
  effective: AgentPriceView,
});

/** A client's month so far, with what it cost us (operator only). */
export const OpsBillingClient = z.object({
  id: z.string(),
  name: z.string(),
  setUp: z.boolean(),
  customerId: z.string().nullable(),
  email: z.string().nullable(),
  /** Client agents active now. */
  activeAgents: z.number().int(),
  monthSoFar: MonthSoFar,
  /** What the month's work cost us so far, as priced (USD). */
  costUsd: DecimalString,
  latestStatement: z
    .object({ id: z.string(), period: IsoDay, status: StatementStatus, total: MoneySchema })
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
  templates: z.array(TemplatePriceRow),
  clients: z.array(OpsBillingClient),
  /** Statements that need the operator: drafts, and those whose payment failed. */
  toReview: z.array(OpsStatement),
});
export type OpsBilling = z.infer<typeof OpsBilling>;

export const AgentOwnPrice = PriceView.extend({
  /** Why it differs (client agents; required there). */
  note: z.string().nullable(),
  setBy: z.string().nullable(),
  setAt: z.string(),
});

export const ClientAgentPrice = z.object({
  agentId: z.string(),
  slug: z.string(),
  name: z.string(),
  runStatus: z.string().nullable(),
  price: AgentPriceView,
  override: AgentOwnPrice.nullable(),
  template: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ClientAgentPrice = z.infer<typeof ClientAgentPrice>;

export const OpsBillingClientDetail = z.object({
  stripeConfigured: z.boolean(),
  client: OpsBillingClient,
  agents: z.array(ClientAgentPrice),
  /** Every statement, newest first. */
  statements: z.array(OpsStatement),
  events: z.array(
    z.object({ id: z.string(), type: z.string(), objectId: z.string().nullable(), at: z.string() }),
  ),
});
export type OpsBillingClientDetail = z.infer<typeof OpsBillingClientDetail>;

/** One agent's price on its page: a template's own, or a client agent's override. */
export const OpsAgentPrice = z.object({
  agentId: z.string(),
  kind: z.enum(["template", "client"]),
  price: AgentPriceView,
  own: AgentOwnPrice.nullable(),
  /** A client agent's template and its price (null: none, or the template has no price). */
  template: z.object({ id: z.string(), name: z.string(), price: PriceView.nullable() }).nullable(),
  defaults: PriceView,
  /** The latest price changes from the agent's log, newest first. */
  history: z.array(
    z.object({
      at: z.string(),
      by: z.string().nullable(),
      from: PriceView.nullable(),
      to: PriceView.nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export type OpsAgentPrice = z.infer<typeof OpsAgentPrice>;

export const SetAgentPrice = z.object({
  /** null clears it: a template's client agents take the default, a client agent its template's. */
  price: z.object({ monthlyPrice: Price, includedCredits: Credits }).nullable(),
  /** Why (required for a client agent). */
  note: z.string().trim().max(500).optional(),
});
export type SetAgentPrice = z.infer<typeof SetAgentPrice>;

/** An adjustment: a positive or negative amount in whole cents, never zero. */
export const NewAdjustment = z.object({
  description: z.string().trim().min(1).max(200),
  amount: z
    .string()
    .regex(/^-?\d{1,8}(\.\d{1,2})?$/, "a dollar amount in whole cents")
    .refine((v) => !/^-?0+(\.0+)?$/.test(v), "not zero"),
});
export type NewAdjustment = z.infer<typeof NewAdjustment>;

export const SendDraftsResult = z.object({
  results: z.array(
    z.object({
      statementId: z.string(),
      clientId: z.string(),
      status: StatementStatus,
      error: z.string().nullable(),
    }),
  ),
});

// ── Portal ───────────────────────────────────────────────────────────────────────────────────────

export const PortalBilling = z.object({
  setUp: z.boolean(),
  /** The month so far, by service; null until billing is set up. */
  monthSoFar: MonthSoFar.nullable(),
  /** A statement's payment failed and is not settled yet. */
  paymentProblem: z.boolean(),
  /** Past statements, newest first (not drafts). */
  statements: z.array(PortalStatement),
});
export type PortalBilling = z.infer<typeof PortalBilling>;

export const StripeWebhookResponse = z.object({
  received: z.literal(true),
  /** Seen before: stored once, applied once. */
  duplicate: z.boolean(),
  /** For a client we bill and of a type we act on. */
  handled: z.boolean(),
});

const StatementParams = z.object({ id: Id });

export const billingRoutes = {
  opsBilling: defineRoute({
    method: "GET",
    path: "/api/ops/billing",
    auth: "session",
    roles: OPS,
    summary:
      "Billing: the settings, template prices, each client's month so far and the statements to review",
    query: z.object({ client: Id.optional() }),
    response: OpsBilling,
  }),
  opsBillingSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/billing/settings",
    auth: "session",
    roles: OPS,
    summary: "Save the billing settings: default price and credits, credit price, auto-send",
    body: BillingSettings,
    response: BillingSettingsView,
  }),
  opsAgentPrice: defineRoute({
    method: "GET",
    path: "/api/ops/billing/agents/:id/price",
    auth: "session",
    roles: OPS,
    summary:
      "An agent's monthly price and included credits, where they come from, and their changes",
    params: z.object({ id: Id }),
    response: OpsAgentPrice,
  }),
  opsSetAgentPrice: defineRoute({
    method: "PUT",
    path: "/api/ops/billing/agents/:id/price",
    auth: "session",
    roles: OPS,
    summary:
      "Set or clear a template's price or a client agent's own price (with a note); logged on the agent",
    params: z.object({ id: Id }),
    body: SetAgentPrice,
    response: OpsAgentPrice,
  }),
  opsBillingClient: defineRoute({
    method: "GET",
    path: "/api/ops/billing/clients/:id",
    auth: "session",
    roles: OPS,
    summary: "One client's billing: its agents' prices, the month so far, statements and events",
    params: z.object({ id: Id }),
    response: OpsBillingClientDetail,
  }),
  opsBillingSetup: defineRoute({
    method: "POST",
    path: "/api/ops/billing/clients/:id/setup",
    auth: "session",
    roles: OPS,
    summary: "Set up billing for a client: its Stripe customer",
    params: z.object({ id: Id }),
    body: z.object({ email: z.email().max(320).optional() }),
    response: OpsBillingClient,
  }),
  opsAddAdjustment: defineRoute({
    method: "POST",
    path: "/api/ops/billing/statements/:id/adjustments",
    auth: "session",
    roles: OPS,
    summary: "Add an adjustment (a positive or negative amount) to a draft statement",
    params: StatementParams,
    body: NewAdjustment,
    response: OpsStatement,
  }),
  opsRemoveAdjustment: defineRoute({
    method: "DELETE",
    path: "/api/ops/billing/statements/:id/adjustments/:lineId",
    auth: "session",
    roles: OPS,
    summary: "Remove an adjustment from a draft statement",
    params: z.object({ id: Id, lineId: Id }),
    response: OpsStatement,
  }),
  opsSendStatement: defineRoute({
    method: "POST",
    path: "/api/ops/billing/statements/:id/send",
    auth: "session",
    roles: OPS,
    summary: "Send a draft statement to Stripe as an invoice (resumes a send that stopped)",
    params: StatementParams,
    response: OpsStatement,
  }),
  opsVoidStatement: defineRoute({
    method: "POST",
    path: "/api/ops/billing/statements/:id/void",
    auth: "session",
    roles: OPS,
    summary: "Void a draft statement that hasn't gone to Stripe",
    params: StatementParams,
    response: OpsStatement,
  }),
  opsSendDrafts: defineRoute({
    method: "POST",
    path: "/api/ops/billing/statements/send-drafts",
    auth: "session",
    roles: OPS,
    summary: "Send every draft statement of the clients this operator serves",
    response: SendDraftsResult,
  }),
  portalBilling: defineRoute({
    method: "GET",
    path: "/api/billing",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Your month so far by service, the credits included and used, and your statements (client admin)",
    response: PortalBilling,
  }),
  stripeWebhook: defineRoute({
    method: "POST",
    path: "/api/billing/stripe/webhook",
    auth: "public",
    roles: [],
    summary: "Stripe's invoice events, signed (Stripe-Signature): finalized, paid, failed, voided",
    response: StripeWebhookResponse,
  }),
} as const;
