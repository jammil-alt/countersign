import { z } from "zod";
import { isUuid } from "../ids";
import { DECIMAL_RE } from "../money";
import { OwnerArea } from "../owners/areas";
import { defineRoute } from "./contract";

// docs/plan.md §1.234, ARCHITECTURE §10.25 (Wave Y, Y5): the work-delivered statement. What the
// agents did for a client in a billing month, per agent and per business area, beside the bill.
//
// THE DEFINITIONS LIVE HERE AND IN ONE QUERY. `WORK_COUNTERS` says what each counter counts, in
// words; `packages/db/src/work-counts.ts` is the one query that counts them, and every surface (the
// portal's statement, its PDF, the PDF emailed with the invoice and the back office's view) reads
// that query and nothing else, so they always agree. A counter changes in both places together:
// `work-counts.test.ts` fails when an id here has no column there.
//
// The statement shows work and dollars *identified for the client*. It never carries our cost,
// margins, model or vendor spend, bundles, instructions or prompts (invariant 11), and only ever
// one client.

/**
 * The five counters, in the order the statement shows them. Each one is over the client agent's
 * live runs created in the month (UTC, as billing months are: docs/plan.md §1.32), and counts only
 * what was recorded before the month ended, so a past month's statement never changes.
 */
export const WORK_COUNTERS = {
  itemsProcessed: {
    words: "Items processed",
    definition:
      "Different records the agent's runs decided on or changed, or that started a run (a document, a message): run_subject rows with role `decided` or `changed`, or no step. A record handled in several runs counts once for the agent.",
  },
  autoPosted: {
    words: "Posted automatically",
    definition:
      "Writes to the client's tools that were done without waiting for a person: external_action `done`, with no approval item, executed before the month ended.",
  },
  sentForApproval: {
    words: "Sent for approval",
    definition:
      "Writes and approvals the agent sent to the client's team instead of doing them itself: inbox items of kind `external_action` or `approval` for the client (not routed to Mezonas), whatever the answer.",
  },
  exceptionsCaught: {
    words: "Exceptions caught",
    definition:
      "Problems the agent stopped: the alerts its runs raised (not dismissed before the month ended), and the writes the verifier disagreed with (ARCHITECTURE §10.18).",
  },
  dollarsIdentified: {
    words: "Dollars identified",
    definition:
      "The dollar impact of those alerts (`alert.dollar_impact`), per currency, never added across currencies.",
  },
} as const;
export type WorkCounterId = keyof typeof WORK_COUNTERS;
export const WORK_COUNTER_IDS = Object.keys(WORK_COUNTERS) as WorkCounterId[];

/** The counters that are numbers of things (all but the dollars). */
export const WORK_COUNT_IDS = [
  "itemsProcessed",
  "autoPosted",
  "sentForApproval",
  "exceptionsCaught",
] as const satisfies readonly WorkCounterId[];
export type WorkCountId = (typeof WORK_COUNT_IDS)[number];

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
// DECISION (§1.234): the client admin only, as /billing is: the statement goes with the bill.
const CLIENT_ADMIN = ["client_admin"] as const;

/** A billing month: `YYYY-MM`. */
export const WorkMonth = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "a month as YYYY-MM")
  .refine((v) => Number(v.slice(0, 4)) >= 2020, "a month from 2020");
export type WorkMonth = z.infer<typeof WorkMonth>;

/** `?month=YYYY-MM`; absent: last month, the one invoiced. */
export const WorkStatementQuery = z.object({ month: WorkMonth.optional() });

/** A decimal amount beside its currency (invariant 6). */
export const WorkAmount = z.object({
  currency: z.string().length(3),
  total: z.string().regex(DECIMAL_RE),
});
export type WorkAmount = z.infer<typeof WorkAmount>;

/** The five counters' values. */
export const WorkCounts = z.object({
  itemsProcessed: z.number().int().nonnegative(),
  autoPosted: z.number().int().nonnegative(),
  sentForApproval: z.number().int().nonnegative(),
  exceptionsCaught: z.number().int().nonnegative(),
  /** Per currency, largest first; empty when nothing was identified. */
  dollarsIdentified: z.array(WorkAmount),
});
export type WorkCounts = z.infer<typeof WorkCounts>;

export const WorkStatementAgent = z.object({
  id: z.string(),
  /** Its service name, else its name: what the client knows it by. */
  name: z.string(),
  area: OwnerArea,
  runs: z.number().int().nonnegative(),
  counts: WorkCounts,
});
export type WorkStatementAgent = z.infer<typeof WorkStatementAgent>;

export const WorkStatementArea = z.object({
  area: OwnerArea,
  agents: z.number().int().positive(),
  counts: WorkCounts,
});
export type WorkStatementArea = z.infer<typeof WorkStatementArea>;

/** The statement: the same on every surface (the back office adds only the client's id). */
export const WorkStatement = z.object({
  client: z.object({ name: z.string() }),
  month: WorkMonth,
  /** The month's first and last days (UTC). */
  from: z.string(),
  to: z.string(),
  /** True while the month is not over: the counts are so far. */
  partial: z.boolean(),
  totals: WorkCounts,
  areas: z.array(WorkStatementArea),
  agents: z.array(WorkStatementAgent),
  /** The bill this statement goes with, when there is one (its Stripe number). */
  invoiceNumber: z.string().nullable(),
});
export type WorkStatement = z.infer<typeof WorkStatement>;

export const OpsWorkStatement = WorkStatement.extend({
  client: z.object({ id: z.string(), name: z.string() }),
});
export type OpsWorkStatement = z.infer<typeof OpsWorkStatement>;

/** The PDF, served as a file. */
export const WorkStatementPdf = z.object({
  filename: z.string().min(1),
  contentType: z.literal("application/pdf"),
  bytes: z.instanceof(Uint8Array),
});

// Served beside the registry (all-routes.ts): the statement's screens load lazily.
export const workStatementRoutes = {
  portalWorkStatement: defineRoute({
    method: "GET",
    path: "/api/billing/work",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary:
      "The work statement for a billing month (default: last month): per agent and area, items processed, posted automatically, sent for approval, exceptions caught and dollars identified",
    query: WorkStatementQuery,
    response: WorkStatement,
  }),
  portalWorkStatementPdf: defineRoute({
    method: "GET",
    path: "/api/billing/work.pdf",
    auth: "session",
    roles: CLIENT_ADMIN,
    summary: "The work statement for a billing month, as the PDF sent with the invoice",
    query: WorkStatementQuery,
    response: WorkStatementPdf,
  }),
  opsWorkStatement: defineRoute({
    method: "GET",
    path: "/api/ops/billing/clients/:id/work",
    auth: "session",
    roles: OPS,
    summary: "A client's work statement for a billing month (default: last month)",
    params: z.object({ id: Id }),
    query: WorkStatementQuery,
    response: OpsWorkStatement,
  }),
  opsWorkStatementPdf: defineRoute({
    method: "GET",
    path: "/api/ops/billing/clients/:id/work.pdf",
    auth: "session",
    roles: OPS,
    summary: "A client's work statement for a billing month, as the PDF sent with the invoice",
    params: z.object({ id: Id }),
    query: WorkStatementQuery,
    response: WorkStatementPdf,
  }),
} as const;
