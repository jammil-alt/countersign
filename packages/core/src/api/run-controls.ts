import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { ExportFile } from "./exports";
import { OpsRunsQuery, RunFilter, RunStatusSchema } from "./runs-filter";

// v0.12 W1-E: run controls and model calls (ARCHITECTURE §10.10, §14; docs/plan.md §1.40). Retry
// from the failed step, cancel, replay as a test run, the runs CSV, model calls and saved views.
// Every route here is the back office's: model calls (prompts, answers, cost) never reach the portal
// (invariant 11; the contract test checks it).

const Id = z.string().refine((v) => isUuid(v), "not an id");
const IdParams = z.object({ id: Id });
const OPS = ["operator"] as const;

// ── Short ids ───────────────────────────────────────────────────────────────────────────────────

/** A run as people see it: `R-` and the last 6 hex characters of its id, as records are shown. */
export function shortRunId(id: string): string {
  return `R-${id.replace(/-/g, "").slice(-6).toLowerCase()}`;
}

/** The hex tail a short id (`R-1a2b3c`, `r-1A2B3C` or `1a2b3c`) names, or null. */
export function shortRunIdTail(text: string): string | null {
  const m = /^(?:r-)?([0-9a-f]{6})$/i.exec(text.trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

// ── Error keys ──────────────────────────────────────────────────────────────────────────────────

/** Known beginnings of a run's error and the code each means. */
const ERROR_CODES: readonly [RegExp, string][] = [
  [/^refused\b/i, "refused"],
  [/^escalated\b/i, "escalated"],
  [/^timeout$/i, "timeout"],
  [/^rejected$/i, "rejected"],
  [/^invalid input\b/i, "invalid_input"],
  [/^invalid output\b/i, "invalid_output"],
  [/^access_not_released\b/i, "not_released"],
  [/needs a person to release it/i, "not_released"],
  [/^no workflow\b/i, "no_workflow"],
  [/^the model declined\b/i, "model_declined"],
  [/may have been sent|may have happened/i, "unconfirmed"],
  [/\b(401|unauthori[sz]ed|invalid_grant|sign-?in (has )?expired)\b/i, "unauthorized"],
  [/\b403\b|\bforbidden\b/i, "forbidden"],
  [/\b429\b|rate.?limit/i, "rate_limited"],
  [/\btimed out\b/i, "timeout"],
];

/**
 * A short, stable code for a run's error text: a known reason, else the error class it names
 * (`ProviderNotConfiguredError: …` → `provider_not_configured`), else `failed`.
 */
// DECISION: the code comes from the error's words, since steps report errors as text: known
// reasons first (refused, escalated, timeout, …), then HTTP-ish causes, then the error class.
export function runErrorCode(reason: string | null | undefined): string {
  const text = (reason ?? "").trim();
  for (const [pattern, code] of ERROR_CODES) if (pattern.test(text)) return code;
  const named = /^([A-Z][A-Za-z]*Error)\b/.exec(text)?.[1];
  if (named && named !== "Error") {
    return named
      .replace(/Error$/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }
  return "failed";
}

/**
 * `error.key` (docs/plan.md §1.40): `<tool id or step kind>:<code>`, e.g. `gmail.send:unauthorized`
 * for an action step, `skill:escalated`, `person:timeout`, `run:no_workflow` before any step.
 */
export function runErrorKey(where: { tool?: string | null; kind: string }, reason: string | null) {
  return `${where.tool || where.kind}:${runErrorCode(reason)}`;
}

/** What failed runs are grouped by: `error.key`, else `error.code` (older runs), else `unknown`. */
export function errorGroupKey(error: unknown): string {
  const e = (error ?? {}) as { key?: unknown; code?: unknown };
  if (typeof e.key === "string" && e.key) return e.key;
  if (typeof e.code === "string" && e.code) return e.code;
  return "unknown";
}

// ── Carried approvals ───────────────────────────────────────────────────────────────────────────

/** An approval is carried into a retry only if it was signed less than this long ago. */
export const CARRIED_APPROVAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type CarryDecision =
  /** Already written: never redone; its recorded result stands. */
  | "done"
  /** Approved and not done: executed under its original idempotency key, without a new approval. */
  | "execute"
  /** Proposed again, for a new approval. */
  | "propose";

/**
 * What a retry does with one of the original run's actions that has the same input (ARCHITECTURE
 * §10.10). The gate's check (matrix, grant, stage, release as they are now) is the caller's.
 */
// DECISION: "approved and not done" is `approved`, `executing` or `failed` with an approval time; a
// failure whose write may have happened (`unconfirmed`) is never carried: a person checks it.
export function carryDecision(
  action: { status: string; approvedAt: Date | null; error: unknown },
  now: Date,
): CarryDecision {
  if (action.status === "done") return "done";
  if (!["approved", "executing", "failed"].includes(action.status)) return "propose";
  if (!action.approvedAt) return "propose";
  if (now.getTime() - action.approvedAt.getTime() >= CARRIED_APPROVAL_MAX_AGE_MS) return "propose";
  const error = action.error as { unconfirmed?: unknown } | null;
  if (action.status === "failed" && error?.unconfirmed === true) return "propose";
  return "execute";
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────

export const StartedRun = z.object({
  runId: z.string(),
  /** `R-` and the last 6 hex characters. */
  shortId: z.string(),
});

export const OpsModelCall = z.object({
  id: z.string(),
  runId: z.string(),
  stepRunId: z.string().nullable(),
  agentVersionId: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.string(),
  durationMs: z.number().int().nullable(),
  stopReason: z.string().nullable(),
  createdAt: z.string(),
});
export type OpsModelCall = z.infer<typeof OpsModelCall>;

/** What a model call's stored body holds, card numbers redacted (§16). */
export const ModelCallBody = z.object({
  request: z.unknown(),
  answer: z.unknown(),
  error: z.string().nullable(),
});
export type ModelCallBody = z.infer<typeof ModelCallBody>;

export const SAVED_VIEW_SURFACES = ["ops_runs", "portal_runs"] as const;
export const SavedViewSurface = z.enum(SAVED_VIEW_SURFACES);

export const SavedView = z.object({
  id: z.string(),
  surface: SavedViewSurface,
  name: z.string(),
  filters: RunFilter,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedView = z.infer<typeof SavedView>;

export const SavedViewBody = z.strictObject({
  // DECISION: only `ops_runs` views are saved today (docs/plan.md §1.40); `portal_runs` is kept in
  // the table's check for when the portal saves views.
  surface: z.literal("ops_runs").default("ops_runs"),
  name: z.string().trim().min(1).max(80),
  filters: RunFilter,
});

/** The CSV's columns (docs/plan.md §1.40). */
export const RUNS_CSV_COLUMNS = [
  "id",
  "client",
  "agent",
  "version",
  "started",
  "status",
  "failed step",
  "error key",
  "attempts",
  "cost",
] as const;

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export const runControlRoutes = {
  opsRetryRun: defineRoute({
    method: "POST",
    path: "/api/ops/runs/:id/retry",
    auth: "session",
    roles: OPS,
    summary:
      "Retry a failed live run from its failed step: earlier outputs reused, approvals signed under 72 hours carried (409 not_failed, not_live, already_retried)",
    params: IdParams,
    response: StartedRun.extend({ resumeFrom: z.string().nullable() }),
  }),
  opsCancelRun: defineRoute({
    method: "POST",
    path: "/api/ops/runs/:id/cancel",
    auth: "session",
    roles: OPS,
    summary:
      "Cancel a queued, running or waiting run: open steps cancelled, open items expired, proposed changes rejected (409 writing while a change is being made)",
    params: IdParams,
    response: z.object({ runId: z.string(), status: RunStatusSchema }),
  }),
  opsReplayRun: defineRoute({
    method: "POST",
    path: "/api/ops/runs/:id/replay",
    auth: "session",
    roles: OPS,
    summary:
      "Replay a run as a test run of the same version and trigger payload, in the same client (never writes)",
    params: IdParams,
    response: StartedRun,
  }),
  opsRunsCsv: defineRoute({
    method: "GET",
    path: "/api/ops/runs.csv",
    auth: "session",
    roles: OPS,
    summary: "The runs list as CSV: id, client, agent, version, started, status, failed step, …",
    query: OpsRunsQuery,
    response: ExportFile,
  }),
  opsRunModelCalls: defineRoute({
    method: "GET",
    path: "/api/ops/runs/:id/model-calls",
    auth: "session",
    roles: OPS,
    summary: "A run's model calls: provider, model, tokens, cost, duration, stop reason",
    params: IdParams,
    response: z.object({ modelCalls: z.array(OpsModelCall) }),
  }),
  opsModelCall: defineRoute({
    method: "GET",
    path: "/api/ops/model-calls/:id",
    auth: "session",
    roles: OPS,
    summary: "One model call with its request and answer (card numbers redacted)",
    params: IdParams,
    response: z.object({ modelCall: OpsModelCall, body: ModelCallBody.nullable() }),
  }),
  opsSavedViews: defineRoute({
    method: "GET",
    path: "/api/ops/saved-views",
    auth: "session",
    roles: OPS,
    summary: "Your saved views of the runs list",
    query: z.object({ surface: SavedViewSurface.default("ops_runs") }),
    response: z.object({ views: z.array(SavedView) }),
  }),
  opsCreateSavedView: defineRoute({
    method: "POST",
    path: "/api/ops/saved-views",
    auth: "session",
    roles: OPS,
    summary: "Save the runs list's filter under a name (yours only)",
    body: SavedViewBody,
    response: z.object({ view: SavedView }),
  }),
  opsDeleteSavedView: defineRoute({
    method: "DELETE",
    path: "/api/ops/saved-views/:id",
    auth: "session",
    roles: OPS,
    summary: "Delete one of your saved views",
    params: IdParams,
    response: z.object({ deleted: z.boolean() }),
  }),
};
