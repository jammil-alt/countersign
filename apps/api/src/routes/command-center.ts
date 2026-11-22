// v0.12 W2-F: the command center and its live feed (ARCHITECTURE §13.1; docs/plan.md §1.49), and
// the mounting of search and plain-words questions (./search.ts). Every figure is one SQL query
// over existing rows, across the clients the operator serves (or the one asked for): RLS scopes
// the transaction and every query also names the clients (invariant 1). Back office only.

import { versionsBehind } from "@countersign/agents";
import {
  AGENT_RECENT_RUNS,
  APPROVAL_OVERDUE_HOURS,
  approvalOverdue,
  BLOCKED_LONG_HOURS,
  type ClientCounts,
  type ClientMember,
  type CommandCenter,
  clientHealth,
  Decimal,
  ESCALATION_LIST_MAX,
  type Escalation,
  FAILED_RUN_ESCALATION_DAYS,
  FEED_DEFAULT_HOURS,
  FEED_LIMIT,
  type FeedItem,
  HEALTH_DAYS,
  isLiveAgent,
  isPlainObject,
  LOW_CONFIDENCE_DEFAULT,
  lowConfidenceThreshold,
  type NobodyToAct,
  newestFeed,
  nobodyToAct,
  type ReachContext,
  routes,
  runWaitOf,
  shareOf,
  sortEscalations,
  toNumeric,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  connection,
  docExtraction,
  document,
  externalAction,
  inboxItem,
  run,
  stepRun,
  type Tx,
  tenant,
} from "@countersign/db";
import { and, desc, eq, gt, gte, inArray, isNotNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, ensureClient, mount, type Services } from "../http";
import { daysOf, runsByDay } from "../runs/figures";
// UI cleanup (stream A)
import {
  clientMembers,
  notWaitingReminder,
  type OpenItemRow,
  openItems,
  opsStatusWhere,
  reachContext,
  runWaits,
  waitsOnPerson,
} from "../runs/run-wait";
import { oversightList } from "./ops-oversight";
import { searchRoutes } from "./search";
import { isBackOffice, type SpendLine, spendLines } from "./usage-spend";

const HOUR_MS = 60 * 60 * 1000;
/** The command center's Run oversight card: the latest decisions (as the lab's `limit`). */
const COMMAND_OVERSIGHT_SHOWN = 5;
const DAY_MS = 24 * HOUR_MS;

/** How far back a browser's start of day may be: a day, and an hour either way for clock changes. */
const TODAY_MAX_HOURS = 26;

/**
 * Today's start for the command center's "today" figures: the start of the operator's own day,
 * as their browser sends it (`today`), else midnight UTC.
 */
// DECISION (QA, 2026-11-22): "today" is the operator's local day, sent by the browser as an
// instant, so the tile, its link's filter and the recent runs read the same day. A value that
// can't be a start of today (in the future, or more than TODAY_MAX_HOURS back) falls back to UTC.
export function startOfToday(now: Date, asked?: string | undefined): Date {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (!asked) return utc;
  const at = Date.parse(asked);
  const back = now.getTime() - at;
  if (!Number.isFinite(at) || back < 0 || back > TODAY_MAX_HOURS * HOUR_MS) return utc;
  return new Date(at);
}

/** The clients a request covers: the one asked for (if served), else every client served. */
function scopeIds(ctx: { tenantIds: readonly string[] }, client: string | undefined): string[] {
  if (client) {
    ensureClient(ctx, client);
    return [client];
  }
  return [...ctx.tenantIds];
}

/** `x in (…)` over uuids, as parameters. */
function uuidList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** A timestamp as ISO 8601 text in UTC, from raw SQL. */
function isoText(column: SQL | unknown): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** The first line of a run's error, short. */
function errorLine(error: unknown): string {
  const e = (error ?? {}) as { reason?: unknown; message?: unknown };
  const raw =
    typeof e.reason === "string" ? e.reason : typeof e.message === "string" ? e.message : "";
  const line = raw.split("\n")[0]?.trim() ?? "";
  if (!line) return "Failed";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Open items no operator holds: assigned to a client role or a client person. */
// DECISION: an open item waits on the client when it is not the operator's (role `operator`,
// which lead checks also use): client roles and items addressed to one client person.
const clientAssigned = sql`coalesce(${inboxItem.assigneeRole}, '') <> 'operator'`;

/** An approval escalation before its client's and agent's names are filled in. */
type PendingApproval = Omit<Escalation, "agent" | "client"> & {
  tenantId: string;
  agentId: string | null;
};

/**
 * A client's approvals nobody there can act on, as Needs us lists them: one per client and reason
 * (nobody may approve, nobody signed in, nobody was told), named by its oldest item. Approvals
 * someone at the client can act on are not here, however long they wait: only the client can
 * answer them (Waiting on clients counts them).
 */
// DECISION (QA, 2026-11-22): Needs us is what the operator must act on. A client's approval is
// ours only when nobody at the client can act on it, and then the fix (an approver, a sign-in, a
// word to the client) is one act for all of that client's items with the same reason: one
// escalation that names them all (`itemIds`), not one per item or per run.
export function approvalEscalations(
  items: readonly OpenItemRow[],
  members: ReadonlyMap<string, readonly ClientMember[]>,
  reach: ReachContext,
): PendingApproval[] {
  const groups = new Map<string, { reason: NobodyToAct; items: OpenItemRow[] }>();
  for (const i of items) {
    const reason = nobodyToAct(i, members.get(i.tenantId) ?? [], reach);
    if (!reason) continue;
    const key = `${i.tenantId}:${reason}`;
    const g = groups.get(key) ?? { reason, items: [] };
    g.items.push(i);
    groups.set(key, g);
  }
  const out: PendingApproval[] = [];
  for (const { items: list } of groups.values()) {
    const sorted = [...list].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );
    const first = sorted[0];
    const wait = first ? runWaitOf(sorted, members.get(first.tenantId) ?? [], reach) : null;
    if (!first || !wait) continue;
    out.push({
      kind: "approval",
      id: first.id,
      tenantId: first.tenantId,
      agentId: first.agentId,
      runId: sorted.length === 1 ? first.runId : null,
      title: first.title,
      blockedSince: wait.since,
      wait,
      itemIds: sorted.slice(0, ESCALATION_LIST_MAX).map((i) => i.id),
    });
  }
  return out;
}

/**
 * What waits only on the clients (not in Needs us): open items no operator holds, outside the
 * Sandbox (whose items are ours), and not the supervisor's reminders about them.
 */
function waitingOnClientsWhere(ids: readonly string[], sandboxes: readonly string[]): SQL[] {
  return [
    inArray(inboxItem.tenantId, [...ids]),
    eq(inboxItem.status, "open"),
    clientAssigned,
    notWaitingReminder,
    ...(sandboxes.length ? [sql`${inboxItem.tenantId} not in (${uuidList(sandboxes)})`] : []),
  ];
}

interface Names {
  clients: Map<string, string>;
  agents: Map<string, { id: string; name: string; serviceName: string | null }>;
}

function clientRows(tx: Tx, ids: readonly string[]) {
  return tx
    .select({ id: tenant.id, name: tenant.name, settings: tenant.settings })
    .from(tenant)
    .where(inArray(tenant.id, [...ids]));
}

/** Agents' names by id; no client names (those come from `clientRows`). */
async function agentNames(tx: Tx, agentIds: Iterable<string | null>): Promise<Names> {
  const wanted = [...new Set([...agentIds].filter((v): v is string => !!v))];
  const agents = wanted.length
    ? await tx
        .select({ id: agent.id, name: agent.name, serviceName: agent.serviceName })
        .from(agent)
        .where(inArray(agent.id, wanted))
    : [];
  return { clients: new Map(), agents: new Map(agents.map((a) => [a.id, a])) };
}

async function namesFor(tx: Tx, ids: readonly string[], agentIds: Iterable<string | null>) {
  const [clients, { agents }] = await Promise.all([clientRows(tx, ids), agentNames(tx, agentIds)]);
  const names: Names = { clients: new Map(clients.map((c) => [c.id, c.name])), agents };
  return { names, clients };
}

const clientRef = (names: Names, id: string) => ({ id, name: names.clients.get(id) ?? "" });
const agentRef = (names: Names, id: string | null) => (id ? (names.agents.get(id) ?? null) : null);

/** What Needs us reads of the deployment: who can be reached, and connectors' names. */
export interface NeedsUsContext extends ReachContext {
  /** A connector's name from its manifest ("QuickBooks Online"), never its id. */
  connectorName: (id: string) => string;
}

export function needsUsContext(services: Pick<Services, "auth" | "env" | "platform">) {
  return {
    ...reachContext(services),
    connectorName: (id: string) => services.platform.connectors.get(id)?.manifest.name ?? id,
  } satisfies NeedsUsContext;
}

/** The low-confidence threshold of each client, as SQL over `doc_extraction.tenant_id`. */
function thresholdSql(thresholds: ReadonlyMap<string, string>): SQL {
  const cases = [...thresholds.entries()]
    .filter(([, t]) => t !== LOW_CONFIDENCE_DEFAULT)
    .map(([id, t]) => sql`when ${id}::uuid then ${t}::numeric`);
  if (cases.length === 0) return sql`${LOW_CONFIDENCE_DEFAULT}::numeric`;
  return sql`(case ${docExtraction.tenantId} ${sql.join(cases, sql` `)} else ${LOW_CONFIDENCE_DEFAULT}::numeric end)`;
}

// ── Needs us ────────────────────────────────────────────────────────────────────────────────────

/**
 * A client's agents as every count counts them, in SQL: core's `isCountedAgent` (a client agent,
 * not discarded, not a template's test copy, not retired). The command center and the clients
 * list both count with it, and the client page's line with `clientAgentCounts`.
 */
export function countedAgentWhere() {
  return and(
    eq(agent.kind, "client"),
    eq(agent.status, "active"),
    eq(agent.testCopy, false),
    or(sql`${agent.runStatus} is null`, ne(agent.runStatus, "retired")),
  );
}

/** Active client agents (not test copies, not retired): live counts, connection users, the table. */
async function activeClientAgents(tx: Tx, ids: readonly string[]) {
  return tx
    .select()
    .from(agent)
    .where(and(inArray(agent.tenantId, [...ids]), countedAgentWhere()))
    .orderBy(agent.tenantId, agent.slug);
}

/** What Needs us is built from, kept for the command center's other figures. */
interface NeedsUsParts {
  escalations: Escalation[];
  names: Names;
  clients: Awaited<ReturnType<typeof namesFor>>["clients"];
  clientAgents: (typeof agent.$inferSelect)[];
  thresholds: Map<string, string>;
  lowReadings: LowReading[];
}

type LowReading = Awaited<ReturnType<typeof lowReadingsSince>>[number];

/** Readings since `since` under each client's threshold, oldest first. */
async function lowReadingsSince(
  tx: Tx,
  ids: readonly string[],
  thresholds: ReadonlyMap<string, string>,
  since: Date,
) {
  return tx
    .select({
      id: docExtraction.id,
      tenantId: docExtraction.tenantId,
      documentId: docExtraction.documentId,
      versionId: docExtraction.agentVersionId,
      confidence: docExtraction.confidence,
      createdAt: docExtraction.createdAt,
      filename: document.filename,
      agentId: agentVersion.agentId,
      version: agentVersion.version,
      templateVersionId: agentVersion.basedOnTemplateVersionId,
    })
    .from(docExtraction)
    .innerJoin(
      document,
      and(eq(document.id, docExtraction.documentId), eq(document.tenantId, docExtraction.tenantId)),
    )
    .leftJoin(agentVersion, eq(agentVersion.id, docExtraction.agentVersionId))
    .where(
      and(
        inArray(docExtraction.tenantId, [...ids]),
        gte(docExtraction.createdAt, since),
        isNotNull(docExtraction.confidence),
        sql`${docExtraction.confidence} < ${thresholdSql(thresholds)}`,
      ),
    )
    .orderBy(docExtraction.createdAt);
}

/**
 * Needs us (§13.1), longest blocked first: what the operator must act on. Open items for us,
 * failed live runs not retried, broken connections an agent uses, low-confidence readings of the
 * last day, and clients' approvals nobody there can act on (`approvalEscalations`). `lowReadings`
 * also holds the readings since `today`, for the command center's card.
 */
async function needsUsParts(
  tx: Tx,
  ids: readonly string[],
  now: Date,
  reach: NeedsUsContext,
  today: Date = startOfToday(now),
): Promise<NeedsUsParts> {
  // DECISION (QA, 2026-11-22): a low reading escalates for a day after it was read, not until
  // midnight, so Needs us is the same on every page whatever day the browser is in (the badges
  // ask without one) and a reading just before midnight doesn't drop out a minute later.
  const lowSince = new Date(now.getTime() - DAY_MS);
  const failedSince = new Date(now.getTime() - FAILED_RUN_ESCALATION_DAYS * DAY_MS);
  // DECISION: the reads that need nothing from each other are asked at once, in the request's
  // transaction, which the driver pipelines (as search.ts does): a few round trips instead of one
  // per query (docs/plan.md §1.82). Escalations are still added in the same order.
  const [clientAgents, clients, failed, broken] = await Promise.all([
    activeClientAgents(tx, ids),
    clientRows(tx, ids),
    tx
      .select()
      .from(run)
      .where(
        and(
          inArray(run.tenantId, [...ids]),
          eq(run.mode, "live"),
          eq(run.status, "failed"),
          gte(run.createdAt, failedSince),
          sql`not exists (select 1 from run retry where retry.retry_of = ${run.id} and retry.tenant_id = ${run.tenantId})`,
        ),
      ),
    tx
      .select()
      .from(connection)
      .where(and(inArray(connection.tenantId, [...ids]), eq(connection.status, "error"))),
  ]);

  // The Sandbox has no client people: the operator resolves every item there, so all of its items
  // are items for us (as Escalations lists them), never a client's approval.
  const sandboxes = clients
    .filter((c) => isPlainObject(c.settings) && c.settings.sandbox === true)
    .map((c) => c.id);
  const ours = sandboxes.length
    ? (or(eq(inboxItem.assigneeRole, "operator"), inArray(inboxItem.tenantId, sandboxes)) as SQL)
    : eq(inboxItem.assigneeRole, "operator");

  // Low confidence: today's readings under each client's threshold.
  const thresholds = new Map(clients.map((c) => [c.id, lowConfidenceThreshold(c.settings)]));
  const [names, items, lowReadings, clientItems] = await Promise.all([
    agentNames(tx, [...clientAgents.map((a) => a.id), ...clientAgents.map((a) => a.templateId)]),
    tx
      .select()
      .from(inboxItem)
      .where(
        and(
          inArray(inboxItem.tenantId, [...ids]),
          eq(inboxItem.status, "open"),
          ours,
          // DECISION: a test run's items (always the operator's) block no client: left out.
          sql`coalesce(${inboxItem.payload}->>'testRun', '') <> 'true'`,
          notWaitingReminder,
        ),
      ),
    lowReadingsSince(tx, ids, thresholds, today < lowSince ? today : lowSince),
    // The clients' approvals, for those nobody there can act on. A test run's items are ours, so
    // never here; the supervisor's reminders are about other items, not items of their own.
    openItems(
      tx,
      ids.filter((id) => !sandboxes.includes(id)),
      [
        clientAssigned,
        sql`coalesce(${inboxItem.payload}->>'testRun', '') <> 'true'`,
        notWaitingReminder,
      ],
    ),
  ]);
  names.clients = new Map(clients.map((c) => [c.id, c.name]));

  type Pending = Omit<Escalation, "agent"> & { agentId: string | null };
  const escalations: Pending[] = [];
  for (const i of items) {
    escalations.push({
      kind: "item",
      id: i.id,
      client: clientRef(names, i.tenantId),
      agentId: i.agentId,
      runId: i.runId,
      title: i.title,
      blockedSince: i.createdAt.toISOString(),
    });
  }
  for (const r of failed) {
    escalations.push({
      kind: "failed_run",
      id: r.id,
      client: clientRef(names, r.tenantId),
      agentId: r.agentId,
      runId: r.id,
      title: errorLine(r.error),
      blockedSince: (r.finishedAt ?? r.createdAt).toISOString(),
    });
  }
  for (const c of broken) {
    const users = clientAgents.filter(
      (a) =>
        a.tenantId === c.tenantId &&
        (Object.values(a.bindings).includes(c.id) || Object.values(a.channels).includes(c.id)),
    );
    // DECISION: a connection in error escalates only while an agent uses it (a binding or a
    // channel), as §13.1 says; it is blocked since the connection last changed.
    if (users.length === 0) continue;
    escalations.push({
      kind: "connection",
      id: c.id,
      client: clientRef(names, c.tenantId),
      agentId: users[0]?.id ?? null,
      runId: null,
      title: reach.connectorName(c.connector),
      blockedSince: c.updatedAt.toISOString(),
    });
  }

  // DECISION: each document read under the threshold today escalates once (its latest such
  // reading), blocked since that reading; the low-confidence figure counts every reading.
  const latestPerDocument = new Map<string, LowReading>();
  for (const r of lowReadings) {
    if (r.createdAt >= lowSince) latestPerDocument.set(r.documentId, r);
  }
  for (const r of latestPerDocument.values()) {
    escalations.push({
      kind: "low_confidence",
      id: r.id,
      client: clientRef(names, r.tenantId),
      agentId: r.agentId ?? null,
      runId: null,
      title: r.filename,
      blockedSince: r.createdAt.toISOString(),
    });
  }

  if (clientItems.length > 0) {
    const members = await clientMembers(tx, ids, reach);
    for (const { tenantId, ...e } of approvalEscalations(clientItems, members, reach)) {
      escalations.push({ ...e, client: clientRef(names, tenantId) });
    }
  }

  // Names for every agent an escalation or reading points at.
  const moreAgents = [
    ...escalations.map((e) => e.agentId),
    ...lowReadings.map((r) => r.agentId),
  ].filter((id): id is string => !!id && !names.agents.has(id));
  const extra = await agentNames(tx, moreAgents);
  for (const [id, a] of extra.agents) names.agents.set(id, a);
  return {
    escalations: sortEscalations(
      escalations.map(({ agentId, ...rest }) => ({ ...rest, agent: agentRef(names, agentId) })),
    ),
    names,
    clients,
    clientAgents,
    thresholds,
    lowReadings,
  };
}

/** Needs us alone: for Escalations and each client's count. */
export async function needsUs(
  tx: Tx,
  ids: readonly string[],
  now: Date,
  reach: NeedsUsContext,
): Promise<Escalation[]> {
  if (ids.length === 0) return [];
  return (await needsUsParts(tx, ids, now, reach)).escalations;
}

// ── The command center ──────────────────────────────────────────────────────────────────────────

async function commandCenter(
  tx: Tx,
  ids: string[],
  now: Date,
  reach: NeedsUsContext,
  today: Date = startOfToday(now),
): Promise<CommandCenter> {
  const weekAgo = new Date(now.getTime() - HEALTH_DAYS * DAY_MS);
  const base: CommandCenter = {
    at: now.toISOString(),
    today: today.toISOString(),
    agentsLive: { count: 0, clients: [] },
    runningNow: { runs: 0, steps: 0 },
    waitingForApproval: { runs: 0, oldestSince: null, overdue: 0, nobodyToAct: 0 },
    failedToday: { runs: 0 },
    needUs: { count: 0, blockedLong: 0 },
    waitingOnClients: { count: 0, oldestSince: null, oldestAgeSeconds: null, overdue: 0 },
    runsToday: { runs: 0, clean: 0, cleanShare: null },
    spendToday: {
      costUsd: "0",
      stepsUsd: "0",
      readingUsd: "0",
      backOfficeUsd: "0",
      perRunUsd: null,
    },
    escalations: [],
    lowConfidence: [],
    health: [],
    agents: [],
  };
  if (ids.length === 0) return base;

  const parts = await needsUsParts(tx, ids, now, reach, today);
  const { names, clients, clientAgents, thresholds } = parts;
  // The card's readings are today's; Needs us took the last day's.
  const lowReadings = parts.lowReadings.filter((r) => r.createdAt >= today);
  const sandboxes = clients
    .filter((c) => isPlainObject(c.settings) && c.settings.sandbox === true)
    .map((c) => c.id);
  const overdueBefore = new Date(now.getTime() - APPROVAL_OVERDUE_HOURS * HOUR_MS);
  const sorted = parts.escalations;

  // Agents live: switched on and at the live stage (isLiveAgent, one meaning everywhere), by client.
  const liveByClient = new Map<string, number>();
  for (const a of clientAgents) {
    if (!isLiveAgent(a) || !a.tenantId) continue;
    liveByClient.set(a.tenantId, (liveByClient.get(a.tenantId) ?? 0) + 1);
  }

  const blockedLongBefore = new Date(now.getTime() - BLOCKED_LONG_HOURS * HOUR_MS).toISOString();
  const templateVersionIds = [
    ...new Set(lowReadings.map((r) => r.templateVersionId).filter((v): v is string => !!v)),
  ];
  const agentIds = clientAgents.map((a) => a.id);

  // Runs today (live, since `today`) and the clean ones: succeeded with no step retried.
  const retried = tx
    .select({ runId: stepRun.runId, tenantId: stepRun.tenantId })
    .from(stepRun)
    .where(and(inArray(stepRun.tenantId, ids), gt(stepRun.attempts, 1)))
    .groupBy(stepRun.runId, stepRun.tenantId)
    .as("retried");
  const noRetry = and(eq(retried.runId, run.id), eq(retried.tenantId, run.tenantId));
  const clean = sql<number>`(count(*) filter (where ${run.status} = 'succeeded' and ${retried.runId} is null))::int`;
  const stepDay = sql`coalesce(${stepRun.startedAt}, ${run.createdAt})`;

  // DECISION: every figure below reads only what Needs us already gave, so all are asked at once
  // in the request's transaction, which the driver pipelines (docs/plan.md §1.82). A figure that
  // needs a second read (the waits, the template names, the spend) chains it on its own first.
  const [
    [running],
    { waitingRows, waits },
    templateVersions,
    [waiting],
    [todayRuns],
    { steps, reading, backOffice, spend },
    weekRuns,
    responses,
    recent,
    open,
    weekCost,
    agentDays,
    liveDays,
    behind,
    oversight,
  ] = await Promise.all([
    // Running now: runs queued or running that wait on nobody, and their steps in flight.
    // (Joined, not a correlated subquery: drizzle leaves a single table's columns unqualified in
    // its select list, which would bind them inside a subquery to the wrong table.)
    tx
      .select({
        runs: sql<number>`count(distinct ${run.id})::int`,
        steps: sql<number>`(count(${stepRun.id}) filter (where ${stepRun.status} = 'running'))::int`,
      })
      .from(run)
      .leftJoin(stepRun, and(eq(stepRun.runId, run.id), eq(stepRun.tenantId, run.tenantId)))
      .where(and(inArray(run.tenantId, ids), ...opsStatusWhere(["queued", "running"]))),

    // Waiting for approval (UI cleanup, stream A): live runs waiting on a person, as Runs filters
    // them; how many waited over a day, and how many nobody can act on.
    (async () => {
      const rows = await tx
        .select()
        .from(run)
        .where(
          and(inArray(run.tenantId, ids), eq(run.mode, "live"), ...opsStatusWhere(["waiting"])),
        );
      return { waitingRows: rows, waits: [...(await runWaits(tx, rows, reach)).values()] };
    })(),

    // The template versions low readings ran on, and their names.
    (async () => {
      if (templateVersionIds.length === 0) return [];
      const rows = await tx
        .select({
          id: agentVersion.id,
          agentId: agentVersion.agentId,
          version: agentVersion.version,
        })
        .from(agentVersion)
        .where(inArray(agentVersion.id, templateVersionIds));
      const extra = await agentNames(
        tx,
        rows.map((t) => t.agentId).filter((id) => !names.agents.has(id)),
      );
      for (const [id, a] of extra.agents) names.agents.set(id, a);
      return rows;
    })(),

    // Waiting on clients: open items only the client can answer, the oldest's age, and how many
    // waited over APPROVAL_OVERDUE_HOURS.
    tx
      .select({
        count: sql<number>`count(*)::int`,
        oldest: sql<string | null>`${isoText(sql`min(${inboxItem.createdAt})`)}`,
        overdue: sql<number>`(count(*) filter (where ${inboxItem.createdAt} < ${overdueBefore.toISOString()}::timestamptz))::int`,
      })
      .from(inboxItem)
      .where(and(...waitingOnClientsWhere(ids, sandboxes))),

    tx
      .select({
        runs: sql<number>`count(*)::int`,
        clean,
        failed: sql<number>`(count(*) filter (where ${run.status} = 'failed'))::int`,
      })
      .from(run)
      .leftJoin(retried, noRetry)
      .where(and(inArray(run.tenantId, ids), eq(run.mode, "live"), gte(run.createdAt, today))),

    // Model spend today (QA usage costs): the Usage screen's "Today", from the same lines: the
    // runs' calls and steps (any mode: test runs cost the same), the clients' own reading and
    // translation, and the back office's (Reggie, the Builder, builds). Owner, 2026-11-22: Home
    // read $0.00 after a talk with Reggie, whose calls were in none of the old figures.
    (async () => {
      const day = today.toISOString().slice(0, 10);
      const [lines, [stepped]] = await Promise.all([
        spendLines(tx, ids, { from: day, to: day }),
        tx
          .select({ runs: sql<number>`count(distinct ${stepRun.runId})::int` })
          .from(stepRun)
          .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
          .where(
            and(
              inArray(stepRun.tenantId, ids),
              sql`${stepDay} >= ${today.toISOString()}::timestamptz`,
            ),
          ),
      ]);
      const part = (keep: (l: SpendLine) => boolean) =>
        lines.filter(keep).reduce((sum, l) => sum.plus(l.cost), new Decimal(0));
      const stepsUsd = part((l) => l.source === "run" || l.source === "unrecorded");
      const readingUsd = part(
        (l) => l.source === "background_read" || l.source === "background_translation",
      );
      const backOfficeUsd = part(isBackOffice);
      const runsWithSteps = stepped?.runs ?? 0;
      return {
        steps: {
          usd: toNumeric(stepsUsd),
          perRun: runsWithSteps > 0 ? toNumeric(stepsUsd.div(runsWithSteps)) : null,
        },
        reading: { usd: toNumeric(readingUsd) },
        backOffice: { usd: toNumeric(backOfficeUsd) },
        spend: { total: toNumeric(stepsUsd.plus(readingUsd).plus(backOfficeUsd)) },
      };
    })(),

    // Client health over 7 days.
    tx
      .select({ tenantId: run.tenantId, runs: sql<number>`count(*)::int`, clean })
      .from(run)
      .leftJoin(retried, noRetry)
      .where(and(inArray(run.tenantId, ids), eq(run.mode, "live"), gte(run.createdAt, weekAgo)))
      .groupBy(run.tenantId),
    tx
      .select({
        tenantId: inboxItem.tenantId,
        hours: sql<number>`(percentile_cont(0.5) within group (order by extract(epoch from (${inboxItem.resolvedAt} - ${inboxItem.createdAt}))) / 3600)::float8`,
      })
      .from(inboxItem)
      .where(
        and(
          inArray(inboxItem.tenantId, ids),
          eq(inboxItem.status, "resolved"),
          gte(inboxItem.resolvedAt, weekAgo),
          clientAssigned,
        ),
      )
      .groupBy(inboxItem.tenantId),

    // The agents table: state now, last 24 runs, cost over 7 days.
    agentIds.length
      ? tx
          .execute<{
            id: string;
            agent_id: string;
            status: string;
            mode: string;
            created_at: string;
            waiting: boolean;
          }>(sql`
        select id, agent_id, status, mode, created_at, waiting from (
          select ${run.id} as id, ${run.agentId} as agent_id, ${run.status} as status,
                 ${run.mode} as mode, ${isoText(run.createdAt)} as created_at,
                 (${run.status} = 'waiting' or (${run.status} in ('queued', 'running') and ${waitsOnPerson})) as waiting,
                 row_number() over (partition by ${run.agentId} order by ${run.createdAt} desc, ${run.id} desc) as n
          from ${run}
          where ${run.tenantId} in (${uuidList(ids)}) and ${run.agentId} in (${uuidList(agentIds)})
        ) x where n <= ${AGENT_RECENT_RUNS}
        order by agent_id, created_at desc`)
          .then((rows) => [...rows])
      : Promise.resolve([]),
    agentIds.length
      ? tx
          .select({
            agentId: run.agentId,
            n: sql<number>`count(*)::int`,
            waiting: sql<number>`(count(*) filter (where ${run.status} = 'waiting' or ${waitsOnPerson}))::int`,
          })
          .from(run)
          .where(
            and(
              inArray(run.tenantId, ids),
              inArray(run.agentId, agentIds),
              inArray(run.status, ["queued", "running", "waiting"]),
            ),
          )
          .groupBy(run.agentId)
      : Promise.resolve([]),
    agentIds.length
      ? tx
          .select({
            agentId: run.agentId,
            usd: sql<string>`coalesce(sum(${stepRun.costUsd}), 0)::numeric(14,4)::text`,
          })
          .from(stepRun)
          .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
          .where(
            and(
              inArray(stepRun.tenantId, ids),
              inArray(run.agentId, agentIds),
              sql`${stepDay} >= ${weekAgo.toISOString()}::timestamptz`,
            ),
          )
          .groupBy(run.agentId)
      : Promise.resolve([]),
    // UI cleanup (design pass): runs each day for the small charts, in UTC like "today": every
    // run of each agent (test runs included), and live runs across the clients for the figures.
    agentIds.length
      ? runsByDay(tx, [inArray(run.tenantId, ids), inArray(run.agentId, agentIds)], {
          timezone: "UTC",
          now,
        })
      : Promise.resolve({ all: [], byAgent: new Map() }),
    runsByDay(tx, [inArray(run.tenantId, ids), eq(run.mode, "live")], { timezone: "UTC", now }),
    // §1.84: what the page asked other routes for (the overview's updates, oversight).
    versionsBehind(tx, agentIds),
    oversightList(tx, ids, { limit: COMMAND_OVERSIGHT_SHOWN }),
  ]);
  const oldestWait = waits.map((w) => w.since).sort()[0] ?? null;

  const groups = new Map<string, CommandCenter["lowConfidence"][number]>();
  for (const r of lowReadings) {
    const key = `${r.tenantId}:${r.versionId ?? "background"}`;
    const confidence = r.confidence ?? "0";
    const g = groups.get(key);
    if (g) {
      g.readings += 1;
      if (Number(confidence) < Number(g.lowest)) g.lowest = confidence;
      continue;
    }
    const tv = templateVersions.find((t) => t.id === r.templateVersionId);
    groups.set(key, {
      client: clientRef(names, r.tenantId),
      agent: agentRef(names, r.agentId ?? null),
      versionId: r.versionId,
      version: r.version ?? null,
      template: tv
        ? { id: tv.agentId, name: names.agents.get(tv.agentId)?.name ?? "", version: tv.version }
        : null,
      threshold: thresholds.get(r.tenantId) ?? LOW_CONFIDENCE_DEFAULT,
      readings: 1,
      lowest: confidence,
    });
  }

  const health = clients
    .map((c) => {
      const w = weekRuns.find((x) => x.tenantId === c.id);
      const resp = responses.find((x) => x.tenantId === c.id);
      const cleanShare = shareOf(w?.clean ?? 0, w?.runs ?? 0);
      const medianResponseHours =
        resp?.hours === null || resp?.hours === undefined
          ? null
          : Math.round(Number(resp.hours) * 10) / 10;
      const openEscalations = sorted.filter((e) => e.client.id === c.id).length;
      return {
        id: c.id,
        name: c.name,
        status: clientHealth({ cleanShare, medianResponseHours, openEscalations }),
        cleanShare,
        runs: w?.runs ?? 0,
        medianResponseHours,
        openEscalations,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const recentRows = recent;
  const agents = clientAgents.map((a) => ({
    id: a.id,
    name: a.name,
    serviceName: a.serviceName,
    client: clientRef(names, a.tenantId as string),
    template: a.templateId
      ? { id: a.templateId, name: names.agents.get(a.templateId)?.name ?? "" }
      : null,
    status: a.runStatus ?? "draft",
    stage: a.stage ?? null,
    openRuns: open.find((o) => o.agentId === a.id)?.n ?? 0,
    waitingRuns: open.find((o) => o.agentId === a.id)?.waiting ?? 0,
    recentRuns: recentRows
      .filter((r) => r.agent_id === a.id)
      .map((r) => ({
        id: r.id,
        status: r.status,
        mode: r.mode,
        createdAt: r.created_at,
        waiting: r.waiting === true,
      })),
    cost7dUsd: weekCost.find((w) => w.agentId === a.id)?.usd ?? "0.0000",
    ...(behind.has(a.id) ? { behind: behind.get(a.id) } : {}),
    perDay: daysOf(agentDays.byAgent, a.id),
  }));

  const oldest = waiting?.oldest ?? null;
  return {
    ...base,
    agentsLive: {
      count: [...liveByClient.values()].reduce((s, n) => s + n, 0),
      clients: clients
        .filter((c) => liveByClient.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, agents: liveByClient.get(c.id) ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
    runningNow: { runs: running?.runs ?? 0, steps: running?.steps ?? 0 },
    waitingForApproval: {
      runs: waitingRows.length,
      oldestSince: oldestWait,
      overdue: waits.filter((w) => approvalOverdue(w.since, now)).length,
      nobodyToAct: waits.filter((w) => w.nobodyToAct !== null).length,
    },
    failedToday: { runs: todayRuns?.failed ?? 0 },
    needUs: {
      count: sorted.length,
      blockedLong: sorted.filter((e) => e.blockedSince < blockedLongBefore).length,
    },
    waitingOnClients: {
      count: waiting?.count ?? 0,
      oldestSince: oldest,
      oldestAgeSeconds: oldest
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(oldest)) / 1000))
        : null,
      overdue: waiting?.overdue ?? 0,
    },
    runsToday: {
      runs: todayRuns?.runs ?? 0,
      clean: todayRuns?.clean ?? 0,
      cleanShare: shareOf(todayRuns?.clean ?? 0, todayRuns?.runs ?? 0),
    },
    spendToday: {
      costUsd: spend.total,
      stepsUsd: steps.usd,
      readingUsd: reading.usd,
      backOfficeUsd: backOffice.usd,
      perRunUsd: steps.perRun,
    },
    escalations: sorted.slice(0, ESCALATION_LIST_MAX),
    lowConfidence: [...groups.values()],
    health,
    agents,
    perDay: liveDays.all,
    oversight,
    clientCounts: countsOf(ids, sorted, waitingRows),
  };
}

/** Each client's badge counts: its escalations, and its live runs waiting for approval. */
function countsOf(
  ids: readonly string[],
  escalations: readonly Pick<Escalation, "client">[],
  waitingRuns: readonly { tenantId: string }[],
): ClientCounts[] {
  return ids.map((id) => ({
    id,
    needsUs: escalations.filter((e) => e.client.id === id).length,
    waitingRuns: waitingRuns.filter((r) => r.tenantId === id).length,
  }));
}

/** The badges alone (§1.84): Needs us and the waiting runs, each client's and in all. */
export async function clientCounts(
  tx: Tx,
  ids: readonly string[],
  now: Date,
  reach: NeedsUsContext,
): Promise<{ needsUs: number; clients: ClientCounts[] }> {
  if (ids.length === 0) return { needsUs: 0, clients: [] };
  const [escalations, waitingRows] = await Promise.all([
    needsUs(tx, ids, now, reach),
    tx
      .select({ tenantId: run.tenantId })
      .from(run)
      .where(
        and(inArray(run.tenantId, [...ids]), eq(run.mode, "live"), ...opsStatusWhere(["waiting"])),
      ),
  ]);
  return { needsUs: escalations.length, clients: countsOf(ids, escalations, waitingRows) };
}

// ── The feed ────────────────────────────────────────────────────────────────────────────────────

async function feed(tx: Tx, ids: string[], since: Date): Promise<FeedItem[]> {
  if (ids.length === 0) return [];
  type Raw = Omit<FeedItem, "client" | "agent"> & { tenantId: string; agentId: string | null };
  const raw: Raw[] = [];

  // Client-visible step summaries of live runs.
  const stepsQ = tx
    .select({
      id: stepRun.id,
      tenantId: stepRun.tenantId,
      runId: stepRun.runId,
      agentId: run.agentId,
      summary: stepRun.summary,
      at: stepRun.finishedAt,
    })
    .from(stepRun)
    .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
    .where(
      and(
        inArray(stepRun.tenantId, ids),
        eq(run.mode, "live"),
        eq(stepRun.status, "succeeded"),
        isNotNull(stepRun.summary),
        gt(stepRun.finishedAt, since),
      ),
    )
    .orderBy(desc(stepRun.finishedAt))
    .limit(FEED_LIMIT);
  const writesQ = tx
    .select({
      id: externalAction.id,
      tenantId: externalAction.tenantId,
      runId: externalAction.runId,
      agentId: run.agentId,
      tool: externalAction.tool,
      at: externalAction.executedAt,
    })
    .from(externalAction)
    .leftJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .where(
      and(
        inArray(externalAction.tenantId, ids),
        eq(externalAction.status, "done"),
        gt(externalAction.executedAt, since),
      ),
    )
    .orderBy(desc(externalAction.executedAt))
    .limit(FEED_LIMIT);
  const signedQ = tx
    .select()
    .from(inboxItem)
    .where(
      and(
        inArray(inboxItem.tenantId, ids),
        eq(inboxItem.status, "resolved"),
        isNotNull(inboxItem.resolvedBy),
        gt(inboxItem.resolvedAt, since),
      ),
    )
    .orderBy(desc(inboxItem.resolvedAt))
    .limit(FEED_LIMIT);
  const failuresQ = tx
    .select()
    .from(run)
    .where(
      and(
        inArray(run.tenantId, ids),
        eq(run.mode, "live"),
        eq(run.status, "failed"),
        sql`coalesce(${run.finishedAt}, ${run.createdAt}) > ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(sql`coalesce(${run.finishedAt}, ${run.createdAt})`))
    .limit(FEED_LIMIT);
  const draftsQ = tx
    .select()
    .from(inboxItem)
    .where(
      and(
        inArray(inboxItem.tenantId, ids),
        eq(inboxItem.subjectType, "account_change"),
        gt(inboxItem.createdAt, since),
      ),
    )
    .orderBy(desc(inboxItem.createdAt))
    .limit(FEED_LIMIT);

  // DECISION: the five reads are asked at once, in the request's transaction, which the driver
  // pipelines (docs/plan.md §1.82).
  const [steps, writes, signed, failures, drafts] = await Promise.all([
    stepsQ,
    writesQ,
    signedQ,
    failuresQ,
    draftsQ,
  ]);
  // DECISION: "client-visible" step summaries are the summaries of live runs' finished steps (the
  // line the timeline shows); internal steps write none.
  for (const s of steps) {
    if (!s.at || !s.summary) continue;
    raw.push({ ...s, id: `step:${s.id}`, kind: "step", at: s.at.toISOString(), text: s.summary });
  }

  // Writes done in the client's tools.
  for (const w of writes) {
    if (!w.at) continue;
    raw.push({
      id: `write:${w.id}`,
      kind: "write",
      at: w.at.toISOString(),
      tenantId: w.tenantId,
      runId: w.runId,
      agentId: w.agentId,
      text: w.tool,
    });
  }

  // Signatures: items a person resolved.
  for (const i of signed) {
    if (!i.resolvedAt) continue;
    raw.push({
      id: `signature:${i.id}`,
      kind: "signature",
      at: i.resolvedAt.toISOString(),
      tenantId: i.tenantId,
      runId: i.runId,
      agentId: i.agentId,
      text: i.title,
    });
  }

  // Failures of live runs.
  for (const r of failures) {
    raw.push({
      id: `failure:${r.id}`,
      kind: "failure",
      at: (r.finishedAt ?? r.createdAt).toISOString(),
      tenantId: r.tenantId,
      runId: r.id,
      agentId: r.agentId,
      text: errorLine(r.error),
    });
  }

  // Sloan's drafted changes: account-change items, when drafted (docs/plan.md §1.47).
  for (const d of drafts) {
    raw.push({
      id: `draft:${d.id}`,
      kind: "draft",
      at: d.createdAt.toISOString(),
      tenantId: d.tenantId,
      runId: d.runId,
      agentId: d.agentId,
      text: d.title,
    });
  }

  const kept = newestFeed(raw);
  const { names } = await namesFor(
    tx,
    ids,
    kept.map((r) => r.agentId),
  );
  return kept.map(({ tenantId, agentId, ...rest }) => ({
    ...rest,
    client: clientRef(names, tenantId),
    agent: agentRef(names, agentId),
  }));
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

export function commandCenterRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsCommandCenter, async (ctx) => {
    const now = new Date();
    return commandCenter(
      ctx.tx,
      scopeIds(ctx, ctx.query.client),
      now,
      needsUsContext(ctx.services),
      startOfToday(now, ctx.query.today),
    );
  });

  // UI cleanup (stream A): Needs us alone (Escalations).
  mount(app, routes.opsNeedsUs, async (ctx) => {
    const escalations = await needsUs(
      ctx.tx,
      scopeIds(ctx, ctx.query.client),
      new Date(),
      needsUsContext(ctx.services),
    );
    return { count: escalations.length, escalations: escalations.slice(0, ESCALATION_LIST_MAX) };
  });

  // §1.84: the back office's badges, on pages without the command center.
  mount(app, routes.opsCounts, async (ctx) =>
    clientCounts(ctx.tx, [...ctx.tenantIds], new Date(), needsUsContext(ctx.services)),
  );

  mount(app, routes.opsFeed, async (ctx) => {
    const now = new Date();
    const since = ctx.query.since
      ? new Date(ctx.query.since)
      : new Date(now.getTime() - FEED_DEFAULT_HOURS * HOUR_MS);
    const items = await feed(ctx.tx, scopeIds(ctx, ctx.query.client), since);
    return { at: now.toISOString(), items };
  });

  // Search and plain-words questions, both surfaces.
  searchRoutes(app);
}
