// The Weekly Table's stored shapes (ARCHITECTURE §5.5 `weekly_table`, §11.4; docs/plan.md §1.37):
// the week's stats (computed from rows, each figure with the record ids it counted), the lead's
// note, decisions and next week, and setup items from code. Never cost.

import { z } from "zod";
import { isUuid } from "../ids";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-11-02");

/** At most this many record ids back each figure (the count is exact; the ids are a sample). */
export const WEEKLY_SOURCES_MAX = 100;

export const WEEKLY_STATUSES = ["draft", "sent"] as const;
export const WeeklyStatus = z.enum(WEEKLY_STATUSES);

const Sources = z.array(z.string()).max(WEEKLY_SOURCES_MAX);

/** One agent's week: runs done, and its KPIs once W2-G computes them. */
export const WeeklyAgentStats = z.object({
  id: z.string(),
  name: z.string(),
  runsDone: z.number().int(),
  // DECISION: KPIs come from W2-G (docs/plan.md §1.50); until it merges every list is empty.
  kpis: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      value: z.string(),
      unit: z.string().optional(),
      // v0.12 W2-G: the records the KPI counted (invariant 10).
      sources: Sources.optional(),
    }),
  ),
});

export const WeeklyStats = z.object({
  weekStart: Day,
  /** The week's bounds in the client's time zone, as instants. */
  from: z.string(),
  to: z.string(),
  runs: z.object({
    /** Live runs that finished `succeeded` in the week. */
    done: z.number().int(),
    lastWeek: z.number().int(),
    /** done − lastWeek. */
    change: z.number().int(),
    sources: Sources,
  }),
  /** Writes to the client's tools that ran in the week. */
  changes: z.object({
    automatic: z.number().int(),
    signed: z.number().int(),
    sources: Sources,
  }),
  /** Approvals the client's people gave in the week. */
  signatures: z.object({ given: z.number().int(), sources: Sources }),
  /** Documents read (extracted) in the week. */
  documents: z.object({ read: z.number().int(), sources: Sources }),
  agents: z.array(WeeklyAgentStats),
  computedAt: z.string(),
});
export type WeeklyStats = z.infer<typeof WeeklyStats>;

export const WeeklyDecisionReply = z.object({
  by: z.string(),
  at: z.string(),
  messageId: z.string(),
});

export const WeeklyDecision = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  options: z.array(z.string()),
  /** Record ids of this client the decision rests on (invariant 10). */
  sources: z.array(z.string()),
  reply: WeeklyDecisionReply.optional(),
});
export type WeeklyDecision = z.infer<typeof WeeklyDecision>;

/** "Connect your Amex": an agent on the bench or in trial with a connection still to make. */
export const WeeklySetupItem = z.object({
  kind: z.literal("connect"),
  agentId: z.string(),
  agentName: z.string(),
  connector: z.string(),
  /** The tool's name (the connector manifest's). */
  tool: z.string(),
});
export type WeeklySetupItem = z.infer<typeof WeeklySetupItem>;

export const WeeklySetup = z.object({ items: z.array(WeeklySetupItem) });
export type WeeklySetup = z.infer<typeof WeeklySetup>;

export const WeeklyTableView = z.object({
  id: z.string(),
  weekStart: Day,
  status: WeeklyStatus,
  stats: WeeklyStats,
  note: z.string().nullable(),
  noteBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  decisions: z.array(WeeklyDecision),
  nextWeek: z.string().nullable(),
  setup: WeeklySetup,
  sentAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type WeeklyTableView = z.infer<typeof WeeklyTableView>;

export const WEEKLY_TEXT_MAX = 4000;
export const WEEKLY_DECISIONS_MAX = 10;

/** One decision as the lead writes it; an `id` keeps an existing decision (and its reply). */
export const WeeklyDecisionInput = z.strictObject({
  id: Id.optional(),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(WEEKLY_TEXT_MAX).default(""),
  options: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  sources: z.array(Id).max(20).default([]),
});

/** The lead's edits until the table is sent. */
export const WeeklyEditBody = z.strictObject({
  note: z.string().trim().max(WEEKLY_TEXT_MAX).nullable().optional(),
  decisions: z.array(WeeklyDecisionInput).max(WEEKLY_DECISIONS_MAX).optional(),
  nextWeek: z.string().trim().max(WEEKLY_TEXT_MAX).nullable().optional(),
});
export type WeeklyEditBody = z.input<typeof WeeklyEditBody>;
export type WeeklyEdit = z.output<typeof WeeklyEditBody>;

export const WeekStartParam = Day.refine(
  (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 1,
  "a Monday",
);
