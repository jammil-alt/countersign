import { z } from "zod";
import { isUuid } from "../ids";
import { AppliedAuditRule, AuditRule } from "../run-audit/sampling";
import { defineRoute } from "./contract";

// Wave 6 (docs/plan.md §1.86 "Run audit (wave 6)"): the back office's audit queue. Runs are queued
// when they finish (every run that wrote to the client's tools, plus a sampled share of the rest,
// by the client's rule or an agent's override); a reviewer opens one in the run view and marks it
// "looks right" or "problem" with a note. Marks are insert only: the latest is the run's state,
// every mark is kept. Operator only (invariant 11): no portal route returns any of it.
// DECISION (wave 6): back office only. The client sees none of the queue, the marks, the owner's
// checks or the export (the owner didn't say; open question in docs/plan.md §1.86).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const IdParams = z.object({ id: Id });

export const RUN_AUDIT_REASONS = ["wrote", "sampled", "by_hand"] as const;
export const RUN_AUDIT_VERDICTS = ["looks_right", "problem"] as const;
export type RunAuditVerdict = (typeof RUN_AUDIT_VERDICTS)[number];
export const AUDIT_NOTE_MAX = 2000;

/** A reviewer, as a mark names them. */
export const AuditReviewer = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

/** One `run_audit_mark` row. */
export const AuditMarkView = z.object({
  id: z.string(),
  runId: z.string(),
  verdict: z.enum(RUN_AUDIT_VERDICTS),
  note: z.string().nullable(),
  markedBy: AuditReviewer,
  /** A problem's operator inbox item, when it opened one. */
  inboxItemId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditMarkView = z.infer<typeof AuditMarkView>;

/** A run's place in the audit: queued (why, by which rule) and its marks, newest first. */
export const RunAuditState = z.object({
  queued: z
    .object({
      reason: z.enum(RUN_AUDIT_REASONS),
      /** The rule as applied; `{}` for a run added by hand. */
      rule: AppliedAuditRule.nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  /** Newest first; the first is the run's state. */
  marks: z.array(AuditMarkView),
  latest: AuditMarkView.nullable(),
});
export type RunAuditState = z.infer<typeof RunAuditState>;

export const AUDIT_QUEUE_STATES = ["unaudited", "audited", "problem", "all"] as const;
export type AuditQueueState = (typeof AUDIT_QUEUE_STATES)[number];

export const AuditQueueQuery = z.object({
  client: Id.optional(),
  agent: Id.optional(),
  /** `unaudited` (no mark yet, the default), `audited` (any mark), `problem` (latest mark). */
  state: z.enum(AUDIT_QUEUE_STATES).default("unaudited"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQueueQuery = z.infer<typeof AuditQueueQuery>;

/** A queued run in the list: enough to pick it, then open it in the run view. */
export const AuditQueueRun = z.object({
  runId: z.string(),
  tenantId: z.string(),
  clientName: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentVersionId: z.string(),
  workflowSlug: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  queuedAt: z.string(),
  reason: z.enum(RUN_AUDIT_REASONS),
  /** The latest mark, or null while unaudited. */
  latest: AuditMarkView.nullable(),
  marks: z.number().int(),
});
export type AuditQueueRun = z.infer<typeof AuditQueueRun>;

/** Newest queued first. `counts` are over the filter's client and agent, whatever `state`. */
export const AuditQueueList = z.object({
  runs: z.array(AuditQueueRun),
  counts: z.object({
    unaudited: z.number().int(),
    audited: z.number().int(),
    problem: z.number().int(),
  }),
});
export type AuditQueueList = z.infer<typeof AuditQueueList>;

export const AuditMarkBody = z
  .strictObject({
    verdict: z.enum(RUN_AUDIT_VERDICTS),
    note: z.string().trim().min(1).max(AUDIT_NOTE_MAX).optional(),
  })
  .refine((b) => b.verdict !== "problem" || b.note !== undefined, {
    message: "a problem needs a note: what is wrong",
    path: ["note"],
  });
export type AuditMarkBody = z.infer<typeof AuditMarkBody>;

/** Audited runs per agent or per client: queued, audited, problems (latest mark), last audited. */
export const AuditStat = z.object({
  tenantId: z.string(),
  clientName: z.string(),
  /** Null on a client's own line. */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  queued: z.number().int(),
  audited: z.number().int(),
  problems: z.number().int(),
  lastAuditedAt: z.string().nullable(),
});
export type AuditStat = z.infer<typeof AuditStat>;

export const AuditStatsQuery = z.object({ client: Id.optional(), agent: Id.optional() });

export const AuditStats = z.object({
  clients: z.array(AuditStat),
  agents: z.array(AuditStat),
});
export type AuditStats = z.infer<typeof AuditStats>;

/** A client's sampling rule and each agent's, as set and as it applies. */
export const AuditSettingsView = z.object({
  clientId: z.string(),
  default: AuditRule,
  /** The client's own rule; null: the default applies. */
  rule: AuditRule.nullable(),
  effective: AuditRule,
  agents: z.array(
    z.object({
      agentId: z.string(),
      name: z.string(),
      /** Its override; null: the client's rule applies. */
      rule: AuditRule.nullable(),
      effective: AuditRule,
    }),
  ),
});
export type AuditSettingsView = z.infer<typeof AuditSettingsView>;

/** Set the client's rule and agents' overrides; null clears one, a key left out keeps it. */
export const AuditSettingsBody = z.strictObject({
  rule: AuditRule.nullable().optional(),
  agents: z.record(Id, AuditRule.nullable()).optional(),
});
export type AuditSettingsBody = z.infer<typeof AuditSettingsBody>;

export const runAuditRoutes = {
  opsAuditQueue: defineRoute({
    method: "GET",
    path: "/api/ops/run-audit/queue",
    auth: "session",
    roles: OPS,
    summary:
      "Runs queued for audit across the clients you serve, newest first: unaudited, audited or with a problem",
    query: AuditQueueQuery,
    response: AuditQueueList,
  }),
  opsAuditStats: defineRoute({
    method: "GET",
    path: "/api/ops/run-audit/stats",
    auth: "session",
    roles: OPS,
    summary: "Per client and per agent: runs queued, audited, problems found and last audited",
    query: AuditStatsQuery,
    response: AuditStats,
  }),
  opsMarkRunAudit: defineRoute({
    method: "POST",
    path: "/api/ops/runs/:id/audit-marks",
    auth: "session",
    roles: OPS,
    summary:
      "Mark a run as looking right or as a problem (with a note, which opens an inbox item for us); marks are kept",
    params: IdParams,
    body: AuditMarkBody,
    response: z.object({ mark: AuditMarkView, audit: RunAuditState }),
  }),
  opsAuditSettings: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/run-audit",
    auth: "session",
    roles: OPS,
    summary: "A client's audit sampling rule and its agents' overrides",
    params: IdParams,
    response: AuditSettingsView,
  }),
  opsSetAuditSettings: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/run-audit",
    auth: "session",
    roles: OPS,
    summary: "Set a client's audit sampling rule or an agent's override (null clears it)",
    params: IdParams,
    body: AuditSettingsBody,
    response: AuditSettingsView,
  }),
} as const;
