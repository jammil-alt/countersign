import { z } from "zod";
import { isUuid } from "../ids";

// v0.12 W1-E: the one typed filter both runs lists take (ARCHITECTURE §10.10; docs/plan.md §1.40).
// The back office's `GET /api/ops/runs` and the portal's `GET /api/runs` read it from their query
// parameters; saved views store it as JSON; plain-words questions (§11.6) produce it.

const Id = z.string().refine((v) => isUuid(v), "not an id");

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** How a run started, in people's terms (one per trigger kind, ARCHITECTURE §10.8). */
export const RUN_STARTED_BY = [
  "schedule",
  "event",
  "webhook",
  "manual",
  "message",
  "handoff",
  "person",
] as const;
export const RunStartedBy = z.enum(RUN_STARTED_BY);
export type RunStartedBy = z.infer<typeof RunStartedBy>;

/** A decimal amount in USD, as a string (invariant 6). */
const Usd = z.string().regex(/^\d{1,10}(\.\d{1,6})?$/, "an amount like 0.25");
const Instant = z.iso.datetime({ offset: true });

export const RunFilter = z.strictObject({
  clients: z.array(Id).max(100).optional(),
  agents: z.array(Id).max(100).optional(),
  /** Runs of client agents forked from these templates. */
  templates: z.array(Id).max(100).optional(),
  versions: z.array(Id).max(100).optional(),
  statuses: z.array(RunStatusSchema).max(6).optional(),
  mode: z.enum(["live", "test"]).optional(),
  /** Created at or after. */
  since: Instant.optional(),
  /** Created before. */
  until: Instant.optional(),
  startedBy: z.array(RunStartedBy).max(RUN_STARTED_BY.length).optional(),
  /** A person who approved one of the run's changes or answered one of its items. */
  signedBy: Id.optional(),
  /** A connector one of the run's changes was made in (an action that is done). */
  changedConnector: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .max(64)
    .optional(),
  /** Runs tried more than this many times (the run and the retries before it). */
  attemptsOver: z.number().int().min(0).max(1000).optional(),
  /** Runs that cost more than this, in USD. Back office only. */
  costOver: Usd.optional(),
  /** `error.key` (or `error.code` for older runs). */
  errorKey: z.string().min(1).max(200).optional(),
  /** A short id (`R-1a2b3c`), a workflow, an agent's or service's name, or words of the error. */
  text: z.string().trim().min(1).max(200).optional(),
});
export type RunFilter = z.infer<typeof RunFilter>;

/**
 * Keys only the back office may filter by. The portal refuses them (docs/plan.md §1.40): cost is
 * the operator's (invariant 11); the client sees its own runs, never test runs, and neither
 * templates, versions nor error keys.
 */
// DECISION: besides cost, the portal also refuses clients, templates, versions, mode and errorKey:
// it has one client, sees live runs only, and its run pages show neither versions nor error keys.
export const OPS_ONLY_RUN_FILTER_KEYS = [
  "clients",
  "templates",
  "versions",
  "mode",
  "costOver",
  "errorKey",
] as const;

// ── Query parameters ────────────────────────────────────────────────────────────────────────────

/** A comma-separated list (or a repeated parameter). */
function listParam<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v])
        .flatMap((s) => s.split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(100));
}

const Limit = z.coerce.number().int().min(1).max(200).default(50);
const Flag = z
  .union([z.boolean(), z.enum(["1", "0", "true", "false"])])
  .transform((v) => v === true || v === "1" || v === "true");

/** The query parameters both lists share, each one a RunFilter key. */
const sharedParams = {
  agents: listParam(Id).optional(),
  statuses: listParam(RunStatusSchema).optional(),
  since: Instant.optional(),
  until: Instant.optional(),
  startedBy: listParam(RunStartedBy).optional(),
  signedBy: Id.optional(),
  changedConnector: RunFilter.shape.changedConnector,
  attemptsOver: z.coerce.number().int().min(0).max(1000).optional(),
  text: RunFilter.shape.text,
  limit: Limit,
  /** Adds the number of runs per day (UTC) that match. */
  perDay: Flag.optional(),
};

const opsParams = {
  ...sharedParams,
  clients: listParam(Id).optional(),
  templates: listParam(Id).optional(),
  versions: listParam(Id).optional(),
  mode: RunFilter.shape.mode,
  costOver: Usd.optional(),
  errorKey: RunFilter.shape.errorKey,
  // The names the list took before RunFilter (ARCHITECTURE §14; the Ops MCP server uses them).
  client: listParam(Id).optional(),
  agent: listParam(Id).optional(),
  status: listParam(RunStatusSchema).optional(),
  /** `error`: failed runs grouped by error key, with counts, clients and agents. */
  groupBy: z.enum(["error"]).optional(),
};

const portalParams = {
  ...sharedParams,
  // The portal's name for an agent (ARCHITECTURE §14) and its earlier single status.
  service: listParam(Id).optional(),
  status: listParam(RunStatusSchema).optional(),
};

function merged<T>(...lists: (readonly T[] | undefined)[]): T[] | undefined {
  const all = lists.flatMap((l) => l ?? []);
  return all.length ? [...new Set(all)] : undefined;
}

/** Drops keys left undefined, so a filter compares and stores cleanly. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export interface RunListQuery {
  filter: RunFilter;
  limit: number;
  perDay: boolean;
}

/** `GET /api/ops/runs` (and its CSV): a RunFilter from the query, plus paging and grouping. */
export const OpsRunsQuery = z.object(opsParams).transform(
  (q): RunListQuery & { groupBy?: "error" } => ({
    filter: compact({
      clients: merged(q.clients, q.client),
      agents: merged(q.agents, q.agent),
      templates: merged(q.templates),
      versions: merged(q.versions),
      statuses: merged(q.statuses, q.status),
      mode: q.mode,
      since: q.since,
      until: q.until,
      startedBy: merged(q.startedBy),
      signedBy: q.signedBy,
      changedConnector: q.changedConnector,
      attemptsOver: q.attemptsOver,
      costOver: q.costOver,
      errorKey: q.errorKey,
      text: q.text,
    }),
    limit: q.limit,
    perDay: q.perDay === true,
    ...(q.groupBy ? { groupBy: q.groupBy } : {}),
  }),
);

/** `GET /api/runs`: the same filter, refusing the back office's keys. */
export const PortalRunsQuery = z
  .looseObject(portalParams)
  .superRefine((q, ctx) => {
    for (const key of [...OPS_ONLY_RUN_FILTER_KEYS, "client", "groupBy"]) {
      if (key in q) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is not a filter here` });
      }
    }
  })
  .transform(
    (q): RunListQuery => ({
      filter: compact({
        agents: merged(q.agents, q.service),
        statuses: merged(q.statuses, q.status),
        since: q.since,
        until: q.until,
        startedBy: merged(q.startedBy),
        signedBy: q.signedBy,
        changedConnector: q.changedConnector,
        attemptsOver: q.attemptsOver,
        text: q.text,
      }),
      limit: q.limit,
      perDay: q.perDay === true,
    }),
  );

/** A filter as query parameters (a saved view opened on the list, a CSV link). */
export function runFilterQuery(filter: RunFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

/** The portal's filter: the same RunFilter without the back office's keys. */
export function portalRunFilter(filter: RunFilter): RunFilter {
  const out: Record<string, unknown> = { ...filter };
  for (const key of OPS_ONLY_RUN_FILTER_KEYS) delete out[key];
  return out as RunFilter;
}

// ── How a run started ───────────────────────────────────────────────────────────────────────────

/** Event types that mean another kind of start (ARCHITECTURE §10.8). */
const STARTED_BY_EVENT: Record<string, RunStartedBy> = {
  "webhook.received": "webhook",
  "inbound.message": "message",
  "thread.message_posted": "message",
  "account.request_passed": "message",
  "run.succeeded": "handoff",
};

/**
 * How a run started, from `run.trigger`: its trigger type, or for an event trigger the kind of
 * event. Null for runs no list filters by (an agent's ask).
 */
// DECISION: a manual run is `person` when a client person started it (`trigger.client`, W1-A's
// manual trigger for clients, or `trigger.startedBy.role` a client role) and `manual` when the
// operator did; a `/command` in a thread is a `message`.
export function runStartedBy(trigger: Record<string, unknown>): RunStartedBy | null {
  const type = typeof trigger.type === "string" ? trigger.type : "";
  if (type === "event") {
    const eventType = typeof trigger.eventType === "string" ? trigger.eventType : "";
    return STARTED_BY_EVENT[eventType] ?? "event";
  }
  if (type === "command") return "message";
  if (type === "manual") {
    const by = trigger.startedBy as { role?: unknown } | undefined;
    const client =
      trigger.client === true || (typeof by?.role === "string" && by.role.startsWith("client_"));
    return client ? "person" : "manual";
  }
  return (RUN_STARTED_BY as readonly string[]).includes(type) ? (type as RunStartedBy) : null;
}

/** The event types a `startedBy` value matches among event-triggered runs. */
export function startedByEventTypes(kind: RunStartedBy): string[] {
  return Object.entries(STARTED_BY_EVENT)
    .filter(([, k]) => k === kind)
    .map(([type]) => type);
}

// ── What the lists add to their answer ──────────────────────────────────────────────────────────

/** `perDay=1`: runs per day (UTC) matching the filter, oldest first; days with none left out. */
export const RunsPerDay = z.array(
  z.object({ day: z.string(), runs: z.number().int(), failed: z.number().int() }),
);
export type RunsPerDay = z.infer<typeof RunsPerDay>;

/** `groupBy=error`: failed runs matching the filter, by error key, the most frequent first. */
export const RunErrorGroup = z.object({
  /** `error.key`, else `error.code` (older runs), else `unknown`. */
  key: z.string(),
  count: z.number().int(),
  clients: z.array(z.object({ id: z.string(), name: z.string() })),
  agents: z.array(z.string()),
  latestRunId: z.string(),
  latestAt: z.string(),
});
export type RunErrorGroup = z.infer<typeof RunErrorGroup>;
