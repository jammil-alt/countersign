import { z } from "zod";
import { isUuid } from "../ids";
import { CurrencyCode } from "../money";
import { RunSubjectKind } from "../schemas/tool-about";

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

// v0.14 W4-B (docs/plan.md §1.49 "Amounts"): an amount range on the run's changes.
/** A non-negative decimal amount, as `numeric(14,4)` holds it (invariant 6). */
const AmountBound = z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "an amount like 5000.00");

/**
 * Runs with a change (an external action not turned down) whose amount, read where its tool
 * declares it (`ToolSpec.amount`, as approver rules read it), is in this currency and range. Both
 * bounds are exclusive; at least one is given.
 */
export const RunAmountFilter = z
  .strictObject({
    over: AmountBound.optional(),
    under: AmountBound.optional(),
    currency: CurrencyCode,
  })
  .refine((a) => a.over !== undefined || a.under !== undefined, "give over, under or both");
export type RunAmountFilter = z.infer<typeof RunAmountFilter>;

// R2 (docs/reporting-plan.md §3, docs/plan.md §1.193): what a run was about, read from
// `run_subject` (R1). An entry is one of our records by its kind and id, or words matched against
// the kept labels and numbers ("Acme", "PO-1032").

/** The most entries `about` takes. */
export const RUN_ABOUT_MAX = 20;

/** Words as an `about` entry holds them: one line, spaces folded, commas made spaces, cut to 100. */
// DECISION: words can't hold a comma, so a filter reads back from its query parameter as it was
// written (`about=vendor:<id>,Acme`); a question's words lose theirs here.
export function aboutWords(text: string): string {
  return text.replaceAll(",", " ").split(/\s+/).filter(Boolean).join(" ").slice(0, 100).trim();
}

const AboutText = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((v) => aboutWords(v) === v, "words on one line, without a comma");

/** One of our records a run was about. Matched by its id; the kind names it for people. */
export const RunAboutRecord = z.strictObject({ kind: RunSubjectKind, id: Id });
export type RunAboutRecord = z.infer<typeof RunAboutRecord>;
/** Words matched against what runs were about: labels ("Acme Supply") and numbers ("4471"). */
export const RunAboutWords = z.strictObject({ text: AboutText });
export const RunAbout = z.union([RunAboutRecord, RunAboutWords]);
export type RunAbout = z.infer<typeof RunAbout>;

/** An entry as its query parameter: `vendor:<id>`, or the words. */
export function aboutParam(entry: RunAbout): string {
  return "kind" in entry ? `${entry.kind}:${entry.id}` : entry.text;
}

/** Other names a record's kind goes by: a receivable is a transaction to runs (§1.188), and lists. */
// DECISION: `receivable:<id>` and the records list's plural kinds (`vendors:<id>`) read as the
// kind runs keep, so an id copied from ⌘K or the records list finds its runs.
const ABOUT_KIND_ALIASES: Record<string, string> = {
  receivable: "transaction",
  receivables: "transaction",
  transactions: "transaction",
  vendors: "vendor",
  items: "item",
  documents: "document",
};

/** A query parameter as an entry: `kind:<uuid>` is a record, anything else words. */
export function readAboutParam(value: string): { kind: string; id: string } | { text: string } {
  const at = value.indexOf(":");
  if (at > 0) {
    const named = value.slice(0, at).toLowerCase();
    const kind = ABOUT_KIND_ALIASES[named] ?? named;
    const id = value.slice(at + 1);
    if (RunSubjectKind.safeParse(kind).success && isUuid(id)) return { kind, id: id.toLowerCase() };
  }
  return { text: value };
}

/** Entries without repeats, in order: a record once by its id, words once whatever their case. */
export function uniqueAbout(entries: readonly RunAbout[]): RunAbout[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = "kind" in e ? `r:${e.id.toLowerCase()}` : `w:${e.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A record an `about` filter names, as the list names it back (from what its runs kept). */
export const RunAboutName = z.object({
  kind: RunSubjectKind,
  id: z.string(),
  label: z.string().nullable(),
  number: z.string().nullable(),
});
export type RunAboutName = z.infer<typeof RunAboutName>;

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
  // v0.14 W4-B
  /** Runs with a change whose amount is in this range and currency ("over $5,000"). */
  amount: RunAmountFilter.optional(),
  /** Runs that cost more than this, in USD. Back office only. */
  costOver: Usd.optional(),
  /** `error.key` (or `error.code` for older runs). */
  errorKey: z.string().min(1).max(200).optional(),
  /**
   * A short id (`R-1a2b3c`), a workflow, an agent's or service's name, words of the error, or a
   * label or number of what the run was about (R2).
   */
  text: z.string().trim().min(1).max(200).optional(),
  // R2: runs about any of these (the portal matches only what its timeline shows).
  about: z.array(RunAbout).min(1).max(RUN_ABOUT_MAX).optional(),
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

/** `about` as a parameter: entries split on commas, each `kind:<id>` or words (R2). */
const AboutParam = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : [v])
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .map(readAboutParam),
  )
  .pipe(z.array(RunAbout).max(RUN_ABOUT_MAX))
  .transform((list) => (list.length ? uniqueAbout(list) : undefined));

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
  // v0.14 W4-B: `amount` as three parameters.
  amountOver: AmountBound.optional(),
  amountUnder: AmountBound.optional(),
  amountCurrency: CurrencyCode.optional(),
  text: RunFilter.shape.text,
  // R2
  about: AboutParam.optional(),
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

// v0.14 W4-B
type AmountParams = {
  amountOver?: string | undefined;
  amountUnder?: string | undefined;
  amountCurrency?: string | undefined;
};

/** A bound needs a currency, and a currency a bound. */
function checkAmountParams(q: AmountParams, ctx: z.RefinementCtx) {
  const bound = q.amountOver !== undefined || q.amountUnder !== undefined;
  if (bound && q.amountCurrency === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["amountCurrency"],
      message: "say the amount's currency",
    });
  }
  if (!bound && q.amountCurrency !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["amountOver"],
      message: "give amountOver or amountUnder",
    });
  }
}

function amountFrom(q: AmountParams): RunAmountFilter | undefined {
  if (q.amountCurrency === undefined) return undefined;
  if (q.amountOver === undefined && q.amountUnder === undefined) return undefined;
  return {
    ...(q.amountOver !== undefined ? { over: q.amountOver } : {}),
    ...(q.amountUnder !== undefined ? { under: q.amountUnder } : {}),
    currency: q.amountCurrency,
  };
}

export interface RunListQuery {
  filter: RunFilter;
  limit: number;
  perDay: boolean;
}

/** `GET /api/ops/runs` (and its CSV): a RunFilter from the query, plus paging and grouping. */
export const OpsRunsQuery = z
  .object(opsParams)
  .superRefine(checkAmountParams)
  .transform((q): RunListQuery & { groupBy?: "error" } => ({
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
      amount: amountFrom(q),
      costOver: q.costOver,
      errorKey: q.errorKey,
      text: q.text,
      about: q.about,
    }),
    limit: q.limit,
    perDay: q.perDay === true,
    ...(q.groupBy ? { groupBy: q.groupBy } : {}),
  }));

/** `GET /api/runs`: the same filter, refusing the back office's keys. */
export const PortalRunsQuery = z
  .looseObject(portalParams)
  .superRefine((q, ctx) => {
    for (const key of [...OPS_ONLY_RUN_FILTER_KEYS, "client", "groupBy"]) {
      if (key in q) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} is not a filter here` });
      }
    }
    checkAmountParams(q as AmountParams, ctx);
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
        amount: amountFrom(q),
        text: q.text,
        about: q.about as RunAbout[] | undefined,
      }),
      limit: q.limit,
      perDay: q.perDay === true,
    }),
  );

/** A filter as query parameters (a saved view opened on the list, a CSV link). */
export function runFilterQuery(filter: RunFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || key === "amount" || key === "about") continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  // v0.14 W4-B: the amount as its three parameters.
  if (filter.amount) {
    if (filter.amount.over !== undefined) out.amountOver = filter.amount.over;
    if (filter.amount.under !== undefined) out.amountUnder = filter.amount.under;
    out.amountCurrency = filter.amount.currency;
  }
  // R2: `about` as `vendor:<id>,Acme`.
  if (filter.about?.length) out.about = filter.about.map(aboutParam).join(",");
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
  z.object({
    day: z.string(),
    runs: z.number().int(),
    failed: z.number().int(),
    // QA round 1 (portal): the day's runs by how they stand, bucketed by the client's start day.
    done: z.number().int().optional(),
    waiting: z.number().int().optional(),
    going: z.number().int().optional(),
    stopped: z.number().int().optional(),
  }),
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
