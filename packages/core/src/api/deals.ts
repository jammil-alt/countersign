// Sales routes (docs/plan.md §1.124.2; docs/cases-plan.md S1–S2): deals for new accounts and for
// more from a client, their people, activity and terms, and set-up, which opens the client and a
// build per agent sold. Operator only: deals are operator-only tables, not a pack (owner,
// 2026-11-17), and no portal route returns any of it.

import { z } from "zod";
import { isUuid } from "../ids";
import { DecimalString } from "../money";
import {
  DealKind,
  DealOutcome,
  DealSource,
  DealStage,
  DealStanding,
  DealWaitingOn,
  SalesTab,
} from "../work/deals";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IdParams = z.object({ id: Id });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date such as 2026-12-24");
const Currency = z.string().regex(/^[A-Z]{3}$/, "an ISO 4217 code");
/** A month's value: a non-negative decimal string (invariant 6). */
const Mrr = DecimalString.refine((v) => !v.startsWith("-"), "not below zero");

/** The signed copy of a contract: a PDF, at most this many bytes. */
export const DEAL_SIGNED_COPY_MAX_BYTES = 10 * 1024 * 1024;
export const DEAL_SIGNED_COPY_TYPE = "application/pdf";

export const DealOrigin = z.object({
  kind: z.enum(["deal", "ask", "enhancement", "issue"]),
  id: Id,
});
export type DealOrigin = z.infer<typeof DealOrigin>;

export const AgentSold = z.object({
  name: z.string().trim().min(1).max(200),
  templateId: Id.nullable(),
});
export type AgentSold = z.infer<typeof AgentSold>;

export const DealPersonView = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  role: z.string().nullable(),
  isPrimary: z.boolean(),
});
export type DealPersonView = z.infer<typeof DealPersonView>;

export const DealSummary = z.object({
  id: z.string(),
  kind: DealKind,
  /** The client, once there is one (always for expansion). */
  client: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** The company, before it is a client. */
  company: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  stage: DealStage,
  stageName: z.string(),
  /** How likely its stage is to close (the stage's `p`), as a decimal string. */
  likelihood: z.string(),
  agentCount: z.number().int(),
  mrr: z.string(),
  currency: z.string(),
  /** mrr × likelihood. */
  weighted: z.string(),
  renewal: z.boolean(),
  outcome: DealOutcome,
  waitingOn: DealWaitingOn,
  statusLine: z.string(),
  /** The words beside its standing (the status line, or the held reason, or plain words). */
  statusText: z.string(),
  stuck: z.boolean(),
  /**
   * Why an expansion deal waits (derived, never stored): an open critical or high issue at the
   * client, or the account at risk.
   */
  held: z.object({ reason: z.string() }).nullable(),
  standing: DealStanding,
  late: z.boolean(),
  nextStep: z.string(),
  nextDueOn: z.string().nullable(),
  source: DealSource,
  origin: DealOrigin.nullable(),
  agreedMrr: z.string().nullable(),
  stageAt: z.string(),
  wonAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DealSummary = z.infer<typeof DealSummary>;

export const SalesKpis = z.object({
  potential: z.string(),
  weighted: z.string(),
  open: z.number().int(),
  openNew: z.number().int(),
  openExpansion: z.number().int(),
  agentsInPlay: z.number().int(),
  needYou: z.number().int(),
  lateOrStuck: z.number().int(),
  late: z.number().int(),
  wonThisMonth: z.string(),
  wonCount: z.number().int(),
});
export type SalesKpis = z.infer<typeof SalesKpis>;

export const DEAL_ACTIVITY_KIND_VALUES = [
  "email_in",
  "email_out",
  "note",
  "call",
  "meeting",
  "stage",
  "system",
  "form",
  "terms",
] as const;
export const DealActivityKind = z.enum(DEAL_ACTIVITY_KIND_VALUES);

export const DealActivityView = z.object({
  id: z.string(),
  kind: DealActivityKind,
  actor: z.enum(["operator", "reggie", "contact", "system"]),
  /** Who, in words: the operator's name, "Reggie", the contact's name; null for the system. */
  who: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  sources: z.array(z.string()),
  createdAt: z.string(),
});
export type DealActivityView = z.infer<typeof DealActivityView>;

export const DealDetail = z.object({
  deal: DealSummary.extend({
    agentsSold: z.array(AgentSold),
    outcomeReason: z.string().nullable(),
    checkBackOn: z.string().nullable(),
    sourceDetail: z.string().nullable(),
    evidence: z.array(z.object({ text: z.string(), sources: z.array(z.string()) })),
    agreedFrom: z.string().nullable(),
    signedCopy: z.object({ name: z.string() }).nullable(),
    people: z.array(DealPersonView),
  }),
  /** Newest first. */
  activity: z.array(DealActivityView),
  /** The builds this deal opened (set-up, or open-builds for expansion). */
  builds: z.array(
    z.object({ id: z.string(), title: z.string(), status: z.string(), phase: z.string() }),
  ),
  /** What the client pays a month now, from its won deals (expansion; null for a lead). */
  now: z.object({ mrr: z.string(), currency: z.string() }).nullable(),
  /** The stages of its pipeline, for the stepper. */
  stages: z.array(z.object({ id: DealStage, name: z.string(), p: z.string() })),
});
export type DealDetail = z.infer<typeof DealDetail>;

const PersonBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().min(1).max(40).optional(),
  role: z.string().trim().min(1).max(120).optional(),
  isPrimary: z.boolean().optional(),
});

const AgentToBuild = z.strictObject({
  name: z.string().trim().min(1).max(200),
  templateId: Id.nullable(),
  promisedOn: Day.optional(),
});

export const NewDeal = z.strictObject({
  kind: DealKind,
  clientId: Id.optional(),
  company: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  agentCount: z.number().int().min(0).max(100).optional(),
  agentsSold: z.array(AgentSold).max(20).optional(),
  mrr: Mrr,
  currency: Currency.optional(),
  stage: DealStage.optional(),
  source: DealSource.optional(),
  sourceDetail: z.string().trim().max(300).optional(),
  people: z.array(PersonBody).max(10).optional(),
  nextStep: z.string().trim().max(300).optional(),
  nextDueOn: Day.optional(),
  origin: DealOrigin.optional(),
});
export type NewDeal = z.infer<typeof NewDeal>;

export const UpdateDeal = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  stage: DealStage.optional(),
  agentCount: z.number().int().min(0).max(100).optional(),
  agentsSold: z.array(AgentSold).max(20).optional(),
  mrr: Mrr.optional(),
  currency: Currency.optional(),
  waitingOn: DealWaitingOn.optional(),
  statusLine: z.string().trim().max(120).optional(),
  stuck: z.boolean().optional(),
  nextStep: z.string().trim().max(300).optional(),
  nextDueOn: Day.nullable().optional(),
  sourceDetail: z.string().trim().max(300).optional(),
  /** Why, on the stage move's activity. */
  reason: z.string().trim().min(1).max(500).optional(),
});
export type UpdateDeal = z.infer<typeof UpdateDeal>;

export const dealRoutes = {
  opsDeals: defineRoute({
    method: "GET",
    path: "/api/ops/deals",
    auth: "session",
    roles: OPS,
    summary:
      "Deals for new accounts and expansion: the open ones and those closed in the last 90 days, with the Sales figures",
    query: z.object({ tab: SalesTab.default("all"), client: Id.optional() }),
    response: z.object({ deals: z.array(DealSummary), kpis: SalesKpis, today: z.string() }),
  }),
  opsCreateDeal: defineRoute({
    method: "POST",
    path: "/api/ops/deals",
    auth: "session",
    roles: OPS,
    summary: "A new deal: a company not yet a client, or more for a client (expansion)",
    body: NewDeal,
    response: DealDetail,
  }),
  opsDeal: defineRoute({
    method: "GET",
    path: "/api/ops/deals/:id",
    auth: "session",
    roles: OPS,
    summary: "A deal: its stage, people, value, terms, activity and the builds it opened",
    params: IdParams,
    response: DealDetail,
  }),
  opsUpdateDeal: defineRoute({
    method: "PATCH",
    path: "/api/ops/deals/:id",
    auth: "session",
    roles: OPS,
    summary:
      "Change a deal: its words, value, stage (on its activity), who has it, its next step and date",
    params: IdParams,
    body: UpdateDeal,
    response: DealDetail,
  }),
  opsDealActivity: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/activity",
    auth: "session",
    roles: OPS,
    summary: "A note, call or meeting on a deal's timeline",
    params: IdParams,
    body: z.strictObject({
      kind: z.enum(["note", "call", "meeting"]),
      subject: z.string().trim().min(1).max(200).optional(),
      body: z.string().trim().min(1).max(20_000),
    }),
    response: DealDetail,
  }),
  opsAddDealPerson: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/people",
    auth: "session",
    roles: OPS,
    summary: "Add a person to a deal (the primary one is who emails go to)",
    params: IdParams,
    body: PersonBody,
    response: DealDetail,
  }),
  opsUpdateDealPerson: defineRoute({
    method: "PATCH",
    path: "/api/ops/deals/:id/people/:personId",
    auth: "session",
    roles: OPS,
    summary: "Change a person on a deal",
    params: z.object({ id: Id, personId: Id }),
    body: PersonBody.partial(),
    response: DealDetail,
  }),
  opsDealTerms: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/terms",
    auth: "session",
    roles: OPS,
    summary: "Record the agreed terms (by hand): the price a month and from when",
    params: IdParams,
    body: z.strictObject({
      agreedMrr: Mrr,
      currency: Currency.optional(),
      from: Day,
      note: z.string().trim().max(2000).optional(),
    }),
    response: DealDetail,
  }),
  opsDealUploadSignedCopy: defineRoute({
    method: "PUT",
    path: "/api/ops/deals/:id/terms/signed-copy",
    auth: "session",
    roles: OPS,
    summary: "Attach the signed copy of the contract (body: the PDF bytes, at most 10 MB)",
    params: IdParams,
    query: z.object({ name: z.string().trim().min(1).max(200).optional() }),
    response: z.object({ ok: z.literal(true), bytes: z.number().int() }),
  }),
  opsDealSignedCopy: defineRoute({
    method: "GET",
    path: "/api/ops/deals/:id/terms/signed-copy",
    auth: "session",
    roles: OPS,
    summary: "A 5-minute link to a deal's signed copy",
    params: IdParams,
    response: z.object({ url: z.string(), expiresAt: z.string() }),
  }),
  opsDealOutcome: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/outcome",
    auth: "session",
    roles: OPS,
    summary:
      "Close a deal: won, lost (Reggie checks back in 90 days), not now (60 days) or no (with a reason)",
    params: IdParams,
    body: z.strictObject({
      outcome: DealOutcome.exclude(["open"]),
      reason: z.string().trim().min(1).max(500).optional(),
    }),
    response: DealDetail,
  }),
  opsDealSetup: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/setup",
    auth: "session",
    roles: OPS,
    summary:
      "Set up the account: create the client (as Reggie's client_create does), invite its admin, and open a build per agent sold",
    params: IdParams,
    body: z.strictObject({
      name: z.string().trim().min(1).max(200),
      timezone: z.string().trim().max(64).optional(),
      adminEmail: z.string().trim().email().max(320).optional(),
      adminName: z.string().trim().max(200).optional(),
      agents: z.array(AgentToBuild).min(1).max(20),
    }),
    response: z.object({ clientId: z.string(), buildIds: z.array(z.string()) }),
  }),
  opsDealOpenBuilds: defineRoute({
    method: "POST",
    path: "/api/ops/deals/:id/open-builds",
    auth: "session",
    roles: OPS,
    summary: "An agreed expansion: open a build per agent sold at the client",
    params: IdParams,
    body: z.strictObject({ agents: z.array(AgentToBuild).min(1).max(20) }),
    response: z.object({ buildIds: z.array(z.string()) }),
  }),
} as const;
