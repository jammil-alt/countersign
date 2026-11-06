// v0.12 W2-F: the command center (ARCHITECTURE §13.1; docs/plan.md §1.49). The back office's
// figures across the clients an operator serves (or one of them), and the live feed it polls.
// Every figure is computed from existing rows in the request's scope; no table is added. Back
// office only: cost is here, and the portal never reaches these routes (invariant 11).

import { z } from "zod";
import { isUuid } from "../ids";
import { isPlainObject } from "../json";
import { defineRoute } from "./contract";
import { runsAskRoutes } from "./runs-ask";
import { searchRoutes } from "./search";

const Id = z.string().refine((v) => isUuid(v), "not an id");
const OPS = ["operator"] as const;
const Instant = z.iso.datetime({ offset: true });

// ── Thresholds ──────────────────────────────────────────────────────────────────────────────────

/** A reading under this confidence is low (overridable per client: `settings.ops.lowConfidence`). */
export const LOW_CONFIDENCE_DEFAULT = "0.80";

/** An escalation blocked longer than this counts in "Need us"' second figure. */
export const BLOCKED_LONG_HOURS = 6;

/** Client health looks back this many days. */
export const HEALTH_DAYS = 7;

/** Client health (§13.1): good, watch or bad from the clean share, response time and escalations. */
export const HEALTH_LIMITS = {
  goodCleanShare: 0.95,
  goodResponseHours: 24,
  badCleanShare: 0.85,
  badResponseHours: 72,
  badEscalations: 3,
} as const;

/** The agents table shows each agent's last this-many runs. */
export const AGENT_RECENT_RUNS = 24;

/** Failed live runs count as escalations while they are this recent (as the overview's list). */
// DECISION: "failed live runs not retried or cancelled" are those of the last 7 days with no retry,
// the window the back office's overview already uses; older ones stay in the runs list.
export const FAILED_RUN_ESCALATION_DAYS = 7;

/** The most escalations the response lists (the counts cover all of them). */
export const ESCALATION_LIST_MAX = 100;

/** The feed's page: the newest this many items after `since`. */
export const FEED_LIMIT = 100;

/** With no `since`, the feed starts this many hours back. */
export const FEED_DEFAULT_HOURS = 24;

/**
 * The client's low-confidence threshold, as a decimal string: `settings.ops.lowConfidence` when it
 * is a number (or numeric text) in (0, 1], else 0.80.
 */
export function lowConfidenceThreshold(settings: unknown): string {
  const ops = isPlainObject(settings) ? settings.ops : undefined;
  const raw = isPlainObject(ops) ? ops.lowConfidence : undefined;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    return LOW_CONFIDENCE_DEFAULT;
  }
  // Confidence is stored with 3 places (`numeric(4,3)`); the threshold keeps as many.
  return value.toFixed(3);
}

/** clean ÷ total, to 4 places; null when there is nothing to divide. */
export function shareOf(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 10_000) / 10_000;
}

export const HEALTH_STATUSES = ["good", "watch", "bad"] as const;
export const HealthStatus = z.enum(HEALTH_STATUSES);
export type HealthStatus = z.infer<typeof HealthStatus>;

/**
 * Good when clean ≥ 95%, response ≤ 24 h and no escalation; bad when clean < 85%, response > 72 h
 * or 3+ escalations; else watch (ARCHITECTURE §13.1).
 */
// DECISION: a figure with nothing to measure (no live runs, no answered items in 7 days) neither
// makes a client good nor bad: it is left out of the test.
export function clientHealth(input: {
  cleanShare: number | null;
  medianResponseHours: number | null;
  openEscalations: number;
}): HealthStatus {
  const { cleanShare: clean, medianResponseHours: response, openEscalations } = input;
  const L = HEALTH_LIMITS;
  if (
    (clean !== null && clean < L.badCleanShare) ||
    (response !== null && response > L.badResponseHours) ||
    openEscalations >= L.badEscalations
  ) {
    return "bad";
  }
  if (
    (clean === null || clean >= L.goodCleanShare) &&
    (response === null || response <= L.goodResponseHours) &&
    openEscalations === 0
  ) {
    return "good";
  }
  return "watch";
}

// ── Shapes ──────────────────────────────────────────────────────────────────────────────────────

const ClientRef = z.object({ id: z.string(), name: z.string() });
const AgentRef = z.object({
  id: z.string(),
  name: z.string(),
  /** What the client calls it; null when it has no service name. */
  serviceName: z.string().nullable(),
});

export const ESCALATION_KINDS = ["item", "failed_run", "connection", "low_confidence"] as const;
export const EscalationKind = z.enum(ESCALATION_KINDS);

export const Escalation = z.object({
  kind: EscalationKind,
  /** The item, run, connection or extraction. */
  id: z.string(),
  client: ClientRef,
  agent: AgentRef.nullable(),
  runId: z.string().nullable(),
  /** The item's title, the run's error, the connector, the document's file name. */
  title: z.string(),
  /** When the client started waiting on us: the oldest cause. */
  blockedSince: z.string(),
});
export type Escalation = z.infer<typeof Escalation>;

/** Longest blocked first; ties by kind then id, so the order is stable between polls. */
export function sortEscalations<T extends Pick<Escalation, "blockedSince" | "kind" | "id">>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      a.blockedSince.localeCompare(b.blockedSince) ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
}

/** A decimal amount in USD, as text (invariant 6). */
const Usd = z.string();

export const CommandCenter = z.object({
  /** When the figures were taken (the server's clock). */
  at: z.string(),
  /** Today's start (UTC), for "today" figures. */
  today: z.string(),
  agentsLive: z.object({
    count: z.number().int(),
    clients: z.array(ClientRef.extend({ agents: z.number().int() })),
  }),
  runningNow: z.object({ runs: z.number().int(), steps: z.number().int() }),
  needUs: z.object({ count: z.number().int(), blockedLong: z.number().int() }),
  waitingOnClients: z.object({
    count: z.number().int(),
    oldestSince: z.string().nullable(),
    oldestAgeSeconds: z.number().int().nullable(),
  }),
  runsToday: z.object({
    runs: z.number().int(),
    clean: z.number().int(),
    /** clean ÷ runs, 0–1; null with no runs. */
    cleanShare: z.number().nullable(),
  }),
  spendToday: z.object({
    /** Step runs' model cost and background readings today. */
    costUsd: Usd,
    stepsUsd: Usd,
    readingUsd: Usd,
    /** Step runs' cost ÷ the runs that had a step today; null with none. */
    perRunUsd: Usd.nullable(),
  }),
  escalations: z.array(Escalation),
  lowConfidence: z.array(
    z.object({
      client: ClientRef,
      /** Null for background readings (no agent asked). */
      agent: AgentRef.nullable(),
      versionId: z.string().nullable(),
      version: z.number().int().nullable(),
      /** The template version the client version reconciles with. */
      template: z
        .object({ id: z.string(), name: z.string(), version: z.number().int() })
        .nullable(),
      threshold: z.string(),
      readings: z.number().int(),
      lowest: z.string(),
    }),
  ),
  health: z.array(
    ClientRef.extend({
      status: HealthStatus,
      cleanShare: z.number().nullable(),
      runs: z.number().int(),
      medianResponseHours: z.number().nullable(),
      openEscalations: z.number().int(),
    }),
  ),
  agents: z.array(
    AgentRef.extend({
      client: ClientRef,
      template: z.object({ id: z.string(), name: z.string() }).nullable(),
      /** `active` or `paused` (and draft, testing, retired for agents not yet or no longer on). */
      status: z.string(),
      /** bench, trial, signoff or live. */
      stage: z.string().nullable(),
      /** Runs queued, running or waiting now. */
      openRuns: z.number().int(),
      recentRuns: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          mode: z.string(),
          createdAt: z.string(),
        }),
      ),
      cost7dUsd: Usd,
    }),
  ),
});
export type CommandCenter = z.infer<typeof CommandCenter>;

export const FEED_KINDS = ["step", "write", "signature", "failure", "draft"] as const;
export const FeedKind = z.enum(FEED_KINDS);

export const FeedItem = z.object({
  /** `<kind>:<row id>`, unique across kinds. */
  id: z.string(),
  kind: FeedKind,
  at: z.string(),
  client: ClientRef,
  agent: AgentRef.nullable(),
  runId: z.string().nullable(),
  /** The step's summary, the tool written to, the item signed, the run's error, the draft. */
  text: z.string(),
});
export type FeedItem = z.infer<typeof FeedItem>;

/** Newest first, then by id, at most `limit`. */
export function newestFeed<T extends Pick<FeedItem, "at" | "id">>(
  items: readonly T[],
  limit = FEED_LIMIT,
): T[] {
  return [...items]
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

const commandCenterOnly = {
  opsCommandCenter: defineRoute({
    method: "GET",
    path: "/api/ops/command-center",
    auth: "session",
    roles: OPS,
    summary:
      "The command center across the clients served (or one): agents live, running now, escalations, today's runs and spend, low confidence, client health and the agents table",
    query: z.object({ client: Id.optional() }),
    response: CommandCenter,
  }),
  opsFeed: defineRoute({
    method: "GET",
    path: "/api/ops/feed",
    auth: "session",
    roles: OPS,
    summary:
      "The live feed after `since`, newest first: step summaries, writes done, signatures, failures and Sloan's drafts",
    query: z.object({ since: Instant.optional(), client: Id.optional() }),
    response: z.object({
      /** Pass back as `since` on the next poll. */
      at: z.string(),
      items: z.array(FeedItem),
    }),
  }),
} as const;

/** W2-F's routes: the command center and feed, search and plain-words questions. */
export const commandCenterRoutes = {
  ...commandCenterOnly,
  ...searchRoutes,
  ...runsAskRoutes,
} as const;
