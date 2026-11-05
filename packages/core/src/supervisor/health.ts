// The supervisor (docs/plan.md §1.28): the events it wakes on, its findings and their fingerprints,
// the daily health summary, and its settings. The payload schemas live here so the outbox (senses),
// the tools (agents) and the API share one definition.

import { z } from "zod";
import { isPlainObject } from "../json";

const Id = z.uuid();

/** A live run of a client agent ended `failed` (test runs emit nothing). */
export const RunFailedPayload = z.strictObject({
  runId: Id,
  agentId: Id,
  agentVersionId: Id,
  workflowSlug: z.string().min(1),
  /** The step the run failed at; null when it failed before any step (e.g. loading). */
  stepId: z.string().nullable(),
  /** Why, as the executor recorded it: never a secret, at most 1000 characters. */
  error: z.string().max(1000),
});
export type RunFailedPayload = z.infer<typeof RunFailedPayload>;

/** Why a connection needs a person (docs/plan.md §1.28 "Triggers"). */
export const CONNECTION_ATTENTION_REASONS = [
  /** The provider says the sign-in has expired or was revoked: the client signs in again. */
  "signin_expired",
  /** Reading from or writing to the tool keeps failing. */
  "sync_failed",
  /** A website login stopped after failed sign-ins (§1.26). */
  "login_stopped",
  /** The code service saw a code or reset message nobody asked for (§1.26). */
  "code_alert",
] as const;
export const ConnectionAttentionReason = z.enum(CONNECTION_ATTENTION_REASONS);
export type ConnectionAttentionReason = z.infer<typeof ConnectionAttentionReason>;

export const ConnectionNeedsAttentionPayload = z.strictObject({
  /** Null for a code-service alert, which belongs to an agent identity rather than a connection. */
  connectionId: Id.nullable(),
  /** The connector id (`zoho_crm`, `browser`, …), or `codes` for a code-service alert. */
  connector: z.string().min(1),
  reason: ConnectionAttentionReason,
  /** A short, plain reason; never a secret or a code. */
  detail: z.string().max(500),
  /** The record the reason rests on (the code alert's id); null when the connection says it all. */
  sourceId: z.string().min(1).max(200).nullable().default(null),
});
export type ConnectionNeedsAttentionPayload = z.infer<typeof ConnectionNeedsAttentionPayload>;

// ── Findings ─────────────────────────────────────────────────────────────────────────────────────

export const FINDING_KINDS = [
  "run_failed",
  "connection_signin",
  "connection_sync",
  "login_stopped",
  "code_alert",
  "waiting_long",
] as const;
export const FindingKind = z.enum(FINDING_KINDS);
export type FindingKind = z.infer<typeof FindingKind>;

export const FINDING_KIND_FOR_REASON: Record<ConnectionAttentionReason, FindingKind> = {
  signin_expired: "connection_signin",
  sync_failed: "connection_sync",
  login_stopped: "login_stopped",
  code_alert: "code_alert",
};

/** `inbox_item.subject_type` of a supervisor finding (kind `review`, no migration). */
export const FINDING_SUBJECT = "supervisor_finding";

/** The payload key every inbox item about one open issue carries, whoever opened it. */
export const FINGERPRINT_KEY = "fingerprint";

/**
 * The issue a finding is about, as a stable key: the same open issue gets the same fingerprint
 * however often it is seen, so it is reported once. Ids only, never text a model wrote.
 */
// DECISION: a failed run's issue is its agent, workflow and step (not the error text, which can
// carry ids and times); a connection's is the connection and the kind of trouble; a code alert's
// is the alert itself; waiting items are one issue per client.
export function findingFingerprint(
  finding:
    | { kind: "run_failed"; agentId: string; workflowSlug: string; stepId: string | null }
    | { kind: "connection_signin" | "connection_sync" | "login_stopped"; connectionId: string }
    | { kind: "code_alert"; sourceId: string }
    | { kind: "waiting_long" },
): string {
  switch (finding.kind) {
    case "run_failed":
      return `run_failed:${finding.agentId}:${finding.workflowSlug}:${finding.stepId ?? "-"}`;
    case "code_alert":
      return `code_alert:${finding.sourceId}`;
    case "waiting_long":
      return "waiting_long";
    default:
      return `${finding.kind}:${finding.connectionId}`;
  }
}

/** The fingerprint an inbox item's payload carries, if any. */
export function fingerprintOf(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null;
  const v = payload[FINGERPRINT_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** What the client admin's item keeps about a finding: the kind, its plain steps, reminders. */
export const ClientFindingView = z.strictObject({
  kind: FindingKind,
  steps: z.array(z.string()),
  reminders: z.number().int().nonnegative(),
  remindedAt: z.string().nullable(),
});
export type ClientFindingView = z.infer<typeof ClientFindingView>;

// ── The daily summary ────────────────────────────────────────────────────────────────────────────

/** The daily health check's summary (event `health.checked`): counts only, shown on the portal. */
export const HealthSummary = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }),
  /** Live runs in the last 24 hours. */
  runs: z.strictObject({
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  connections: z.strictObject({
    total: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
  }),
  /** Open items waiting on people, and the oldest one's age in hours. */
  waiting: z.strictObject({
    count: z.number().int().nonnegative(),
    oldestHours: z.number().int().nonnegative(),
  }),
  agents: z.strictObject({
    active: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
  }),
  /** Open findings for the client admin after the check. */
  openFindings: z.number().int().nonnegative(),
  /** Record ids the counts rest on (failed runs, troubled connections), invariant 10. */
  sources: z.array(z.string()),
});
export type HealthSummary = z.infer<typeof HealthSummary>;

export type HealthState = "good" | "attention";

/** Good when nothing failed, no connection needs anyone and no finding is open. */
export function healthState(s: HealthSummary): HealthState {
  return s.runs.failed === 0 && s.connections.needsAttention === 0 && s.openFindings === 0
    ? "good"
    : "attention";
}

// ── Settings (`tenant.settings.supervisor`) ──────────────────────────────────────────────────────

export const SUPERVISOR_SETTINGS_KEY = "supervisor";
export const DEFAULT_REMINDER_HOURS = 24;
/** Items waiting on people longer than this are a finding of the daily check. */
export const DEFAULT_WAITING_HOURS = 48;

export interface SupervisorSettings {
  /** An open finding seen again after this long is reminded (default 24). */
  reminderHours: number;
  waitingHours: number;
}

const Hours = z
  .number()
  .int()
  .min(1)
  .max(24 * 30);

/** The client's supervisor settings over the defaults; anything invalid reads as the default. */
export function supervisorSettings(settings: Record<string, unknown>): SupervisorSettings {
  const raw = isPlainObject(settings[SUPERVISOR_SETTINGS_KEY])
    ? (settings[SUPERVISOR_SETTINGS_KEY] as Record<string, unknown>)
    : {};
  const pick = (v: unknown, fallback: number) => {
    const r = Hours.safeParse(v);
    return r.success ? r.data : fallback;
  };
  return {
    reminderHours: pick(raw.reminderHours, DEFAULT_REMINDER_HOURS),
    waitingHours: pick(raw.waitingHours, DEFAULT_WAITING_HOURS),
  };
}

/** The supervisor template's slug (packages/db/seed/agents/supervisor.v1.json). */
export const SUPERVISOR_SLUG = "supervisor";
