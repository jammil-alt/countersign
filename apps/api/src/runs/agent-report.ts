// R4: a report per agent (docs/reporting-plan.md §3 R4, docs/plan.md §1.214). One client agent's
// live runs created in a period, counted with the runs lists' own conditions (`runFilterWhere`,
// the portal's client states or the back office's), so each figure's RunFilter opens exactly the
// runs behind it. A figure RunFilter can't say exactly carries no filter rather than a wider one.
// The portal reads only what its timeline shows: the client's own items, the subjects of steps it
// shows (`client_visible`), never cost, tokens or errors (invariant 11). Every query names the one
// client as well as relying on RLS (invariant 1). Money is summed per currency with decimal.js,
// never added across currencies (invariant 6).

import {
  AGENT_REPORT_ERRORS,
  AGENT_REPORT_TOP,
  addDays,
  amountOf,
  Decimal,
  entityOfCall,
  type KpiValue,
  type Locale,
  type OpsAgentReport,
  type PortalAgentReport,
  RUN_ABOUT_MAX,
  type RunFilter,
  type RunStatus,
  type RunSubjectKind,
  type ToolSpec,
  zonedTimeToUtc,
} from "@countersign/core";
import {
  type agent,
  connection,
  externalAction,
  inboxItem,
  run,
  runSubject,
  stepRun,
  type Tx,
} from "@countersign/db";
import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { computeKpis } from "../kpi/compute";
import { liveClientView } from "../kpi/view";
import type { Platform } from "../platform";
import { runErrorGroups, runFilterWhere } from "../routes/run-controls";
import { steppedInOf } from "../step-in/service";
import { userNames } from "../work/issues";
import { clientStatusWhere, forClient } from "./client-status";
import { opsStatusWhere } from "./run-wait";

type Surface = "portal" | "ops";
type AgentRow = typeof agent.$inferSelect;

/** The portal's five states, as the runs lists' `statuses` say them. */
const OUTCOMES = {
  done: ["succeeded"],
  waiting: ["waiting"],
  failed: ["failed"],
  stopped: ["cancelled"],
  going: ["queued", "running"],
} as const satisfies Record<string, readonly RunStatus[]>;
type Outcome = keyof typeof OUTCOMES;
const OUTCOME_KEYS = Object.keys(OUTCOMES) as Outcome[];

export interface ReportInput {
  surface: Surface;
  agent: AgentRow;
  tenantId: string;
  timezone: string;
  from: string;
  to: string;
  /** The period compared with. */
  previous: { from: string; to: string };
  locale: Locale;
}

/** A period's instants: from the first day's midnight to the midnight after the last, there. */
export function periodBounds(from: string, to: string, timezone: string) {
  return {
    since: zonedTimeToUtc(from, 0, 0, timezone),
    until: zonedTimeToUtc(addDays(to, 1), 0, 0, timezone),
  };
}

/**
 * The default period: this month so far, against the whole of last month. A period asked for is
 * compared with as many days just before it.
 */
// DECISION (docs/plan.md §1.214): "this month, compared with last month" is the month so far
// against all of last month (what the client reads as last month); any other period against the
// same number of days before it.
export function reportPeriods(
  query: { from?: string | undefined; to?: string | undefined },
  today: string,
): { from: string; to: string; previous: { from: string; to: string } } {
  if (!query.from && !query.to) {
    const from = `${today.slice(0, 7)}-01`;
    const lastMonth = new Date(`${from}T00:00:00Z`);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    return {
      from,
      to: today,
      previous: { from: lastMonth.toISOString().slice(0, 10), to: addDays(from, -1) },
    };
  }
  const to = query.to ?? today;
  const from = query.from ?? `${to.slice(0, 7)}-01`;
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return { from, to, previous: { from: addDays(from, -days), to: addDays(from, -1) } };
}

/** Days from `from` to `to`, both included. */
function daysOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** What the queries of one period share: its filter, and that filter as conditions on `run`. */
interface Scope {
  surface: Surface;
  tenantId: string;
  base: RunFilter;
  where: SQL[];
  specs: Readonly<Record<string, ToolSpec>>;
}

function scopeOf(
  platform: Pick<Platform, "ctx">,
  input: Pick<ReportInput, "surface" | "agent" | "tenantId" | "timezone">,
  from: string,
  to: string,
): Scope {
  const { since, until } = periodBounds(from, to, input.timezone);
  // DECISION: both surfaces count live runs only, as the KPIs do: the back office's filter says
  // so (`mode`), the portal's lists never show a test run.
  const base: RunFilter =
    input.surface === "ops"
      ? {
          clients: [input.tenantId],
          agents: [input.agent.id],
          mode: "live",
          since: since.toISOString(),
          until: until.toISOString(),
        }
      : { agents: [input.agent.id], since: since.toISOString(), until: until.toISOString() };
  const specs = platform.ctx.tools.specs();
  return {
    surface: input.surface,
    tenantId: input.tenantId,
    base,
    where: [
      eq(run.tenantId, input.tenantId),
      eq(run.mode, "live"),
      ...runFilterWhere(base, specs, input.surface),
    ],
    specs,
  };
}

/** A status filter as SQL, the way the surface's runs list reads it. */
function statusSql(surface: Surface, statuses: readonly RunStatus[]): SQL {
  const [where] = (surface === "portal" ? clientStatusWhere : opsStatusWhere)([...statuses]);
  return where ?? sql`true`;
}

const ms = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v));

/** `percentile_cont` of a duration in milliseconds. */
const percentile = (p: number, millis: SQL) =>
  sql<string | null>`percentile_cont(${sql.raw(String(p))}) within group (order by ${millis})`;

const finishMs = sql`extract(epoch from (${run.finishedAt} - coalesce(${run.startedAt}, ${run.createdAt}))) * 1000`;
const waitMs = sql`extract(epoch from (${inboxItem.resolvedAt} - ${inboxItem.createdAt})) * 1000`;

/** The client's items of the scope's runs (joined to `run`). */
async function clientItems<T extends Record<string, unknown>>(
  tx: Tx,
  scope: Scope,
  columns: T,
  ...more: SQL[]
) {
  return tx
    .select(columns as never)
    .from(inboxItem)
    .innerJoin(run, and(eq(run.id, inboxItem.runId), eq(run.tenantId, inboxItem.tenantId)))
    .where(and(eq(inboxItem.tenantId, scope.tenantId), forClient(), ...scope.where, ...more));
}

const APPROVAL_KINDS = ["approval", "external_action"] as const;

/** The figures each period is compared by. */
async function headline(tx: Tx, scope: Scope, from: string, to: string) {
  const done = statusSql(scope.surface, OUTCOMES.done);
  const failed = statusSql(scope.surface, OUTCOMES.failed);
  const [[runs], [items], [changes]] = await Promise.all([
    tx
      .select({
        runs: sql<number>`count(*)::int`,
        done: sql<number>`(count(*) filter (where ${done}))::int`,
        failed: sql<number>`(count(*) filter (where ${failed}))::int`,
        finish: sql<
          string | null
        >`percentile_cont(0.5) within group (order by ${finishMs}) filter (where ${run.status} = 'succeeded' and ${run.finishedAt} is not null)`,
      })
      .from(run)
      .where(and(...scope.where)),
    clientItems(tx, scope, {
      wait: sql<
        string | null
      >`percentile_cont(0.5) within group (order by ${waitMs}) filter (where ${inboxItem.resolvedAt} is not null)`,
      approvals: sql<number>`(count(*) filter (where ${inboxItem.status} = 'resolved' and ${inboxItem.kind} in ('approval', 'external_action')))::int`,
    }) as Promise<{ wait: string | null; approvals: number }[]>,
    changeRows(tx, scope, { n: sql<number>`count(*)::int` }) as Promise<{ n: number }[]>,
  ]);
  return {
    from,
    to,
    runs: Number(runs?.runs ?? 0),
    done: Number(runs?.done ?? 0),
    failed: Number(runs?.failed ?? 0),
    finishMedianMs: ms(runs?.finish),
    waitMedianMs: ms(items?.wait),
    approvals: Number(items?.approvals ?? 0),
    changes: Number(changes?.n ?? 0),
  };
}

/** The scope's changes made in the client's tools (done), with their connection's tool. */
function changeRows<T extends Record<string, unknown>>(tx: Tx, scope: Scope, columns: T) {
  return tx
    .select(columns as never)
    .from(externalAction)
    .innerJoin(
      run,
      and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)),
    )
    .innerJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .where(
      and(
        eq(externalAction.tenantId, scope.tenantId),
        eq(externalAction.status, "done"),
        ...scope.where,
      ),
    );
}

/** Decimal sums per currency, as the report lists them (currency order). */
function amountList(sums: Map<string, Decimal>) {
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, total: total.toFixed(4) }));
}

/** The report the portal shows, and the back office's figures beside it. */
export async function agentReport(
  tx: Tx,
  platform: Platform,
  input: ReportInput,
): Promise<PortalAgentReport | Omit<OpsAgentReport, "client" | "errors" | "spend">> {
  const { surface, tenantId, timezone } = input;
  const scope = scopeOf(platform, input, input.from, input.to);
  const before = scopeOf(platform, input, input.previous.from, input.previous.to);
  const withFilter = (extra: Partial<RunFilter>): RunFilter => ({ ...scope.base, ...extra });

  // ── Runs by outcome, per day ────────────────────────────────────────────────────────────────
  const day = sql<string>`to_char(${run.createdAt} at time zone ${timezone}, 'YYYY-MM-DD')`;
  const outcomeColumns = Object.fromEntries(
    OUTCOME_KEYS.map((k) => [
      k,
      sql<number>`(count(*) filter (where ${statusSql(surface, OUTCOMES[k])}))::int`,
    ]),
  ) as Record<Outcome, SQL<number>>;

  const [
    perDayRows,
    [finish],
    [waits],
    approvalRows,
    changes,
    handledKinds,
    handledTop,
    view,
    current,
    previous,
  ] = await Promise.all([
    tx
      .select({ day, ...outcomeColumns })
      .from(run)
      .where(and(...scope.where))
      // By position: the time zone is a parameter, and a repeated expression would be another one.
      .groupBy(sql`1`),
    tx
      .select({
        runs: sql<number>`count(*)::int`,
        median: percentile(0.5, finishMs),
        p90: percentile(0.9, finishMs),
      })
      .from(run)
      .where(and(...scope.where, statusSql(surface, OUTCOMES.done), isNotNull(run.finishedAt))),
    clientItems(tx, scope, {
      answered: sql<number>`(count(*) filter (where ${inboxItem.resolvedAt} is not null))::int`,
      open: sql<number>`(count(*) filter (where ${inboxItem.status} = 'open'))::int`,
      median: sql<
        string | null
      >`percentile_cont(0.5) within group (order by ${waitMs}) filter (where ${inboxItem.resolvedAt} is not null)`,
      p90: sql<
        string | null
      >`percentile_cont(0.9) within group (order by ${waitMs}) filter (where ${inboxItem.resolvedAt} is not null)`,
      total: sql<
        string | null
      >`coalesce(sum(${waitMs}) filter (where ${inboxItem.resolvedAt} is not null), 0)`,
    }) as Promise<
      { answered: number; open: number; median: string | null; p90: string | null; total: string }[]
    >,
    clientItems(
      tx,
      scope,
      {
        id: inboxItem.id,
        payload: inboxItem.payload,
        resolution: inboxItem.resolution,
        resolvedBy: inboxItem.resolvedBy,
        edited: sql<boolean>`exists (select 1 from ${externalAction} ea
          where ea.tenant_id = ${inboxItem.tenantId} and ea.inbox_item_id = ${inboxItem.id}
            and ea.edited_input is not null)`,
      },
      eq(inboxItem.status, "resolved"),
      inArray(inboxItem.kind, [...APPROVAL_KINDS]),
    ) as Promise<
      {
        id: string;
        payload: Record<string, unknown>;
        resolution: Record<string, unknown> | null;
        resolvedBy: string | null;
        edited: boolean;
      }[]
    >,
    changeRows(tx, scope, {
      tool: externalAction.tool,
      input: externalAction.input,
      editedInput: externalAction.editedInput,
      connector: connection.connector,
    }) as Promise<{ tool: string; input: unknown; editedInput: unknown; connector: string }[]>,
    handledByKind(tx, scope),
    handledTopRecords(tx, scope),
    liveClientView(tx, input.agent),
    headline(tx, scope, input.from, input.to),
    headline(tx, before, input.previous.from, input.previous.to),
  ]);

  // Every day of the period, a day without runs a row of zeros.
  const byDay = new Map(perDayRows.map((r) => [r.day, r]));
  const perDay = daysOf(input.from, input.to).map((d) => {
    const row = byDay.get(d);
    const { since, until } = periodBounds(d, d, timezone);
    const span = { since: since.toISOString(), until: until.toISOString() };
    return {
      day: d,
      ...(Object.fromEntries(
        OUTCOME_KEYS.map((k) => [
          k,
          {
            count: Number(row?.[k] ?? 0),
            filter: withFilter({ ...span, statuses: [...OUTCOMES[k]] }),
          },
        ]),
      ) as Record<Outcome, { count: number; filter: RunFilter }>),
    };
  });
  const totals = Object.fromEntries(
    OUTCOME_KEYS.map((k) => [
      k,
      {
        count: perDay.reduce((n, d) => n + d[k].count, 0),
        filter: withFilter({ statuses: [...OUTCOMES[k]] }),
      },
    ]),
  ) as Record<Outcome, { count: number; filter: RunFilter }>;
  const runCount = OUTCOME_KEYS.reduce((n, k) => n + totals[k].count, 0);

  // ── Approvals, by person ────────────────────────────────────────────────────────────────────
  const names = await userNames(
    tx,
    approvalRows.map((r) => r.resolvedBy),
  );
  type PersonRow = PortalAgentReport["approvals"]["byPerson"][number];
  const people = new Map<string, PersonRow>();
  let signed = 0;
  let edited = 0;
  let turnedDown = 0;
  for (const r of approvalRows) {
    const res = (r.resolution ?? {}) as { approved?: unknown; decision?: unknown };
    const approved = typeof res.approved === "boolean" ? res.approved : res.decision === "approve";
    const steppedIn = steppedInOf(r) !== null;
    // DECISION: when we stepped in, the portal names neither our person nor their id, and opens
    // no runs by them; the back office names who it was.
    const hidden = steppedIn && surface === "portal";
    const key = hidden ? "us" : (r.resolvedBy ?? "unknown");
    const row = people.get(key) ?? {
      person:
        hidden || !r.resolvedBy
          ? null
          : { id: r.resolvedBy, name: names.get(r.resolvedBy) ?? null },
      steppedIn,
      signed: 0,
      edited: 0,
      turnedDown: 0,
      filter: hidden || !r.resolvedBy ? null : withFilter({ signedBy: r.resolvedBy }),
    };
    if (!approved) {
      row.turnedDown += 1;
      turnedDown += 1;
    } else if (r.edited) {
      row.edited += 1;
      edited += 1;
    } else {
      row.signed += 1;
      signed += 1;
    }
    people.set(key, row);
  }
  const byPerson = [...people.values()].sort(
    (a, b) =>
      b.signed + b.edited + b.turnedDown - (a.signed + a.edited + a.turnedDown) ||
      (a.person?.name ?? "").localeCompare(b.person?.name ?? ""),
  );

  // ── Changes, by tool and record type, with amounts per currency ─────────────────────────────
  const all = new Map<string, Decimal>();
  const perConnector = new Map<
    string,
    { count: number; sums: Map<string, Decimal>; entities: Map<string, number> }
  >();
  for (const c of changes) {
    const spec = scope.specs[c.tool];
    const entry = perConnector.get(c.connector) ?? {
      count: 0,
      sums: new Map<string, Decimal>(),
      entities: new Map<string, number>(),
    };
    entry.count += 1;
    // The input it ran with: the signer's edit, else the agent's (as RunFilter's `amount` reads).
    const ran = c.editedInput ?? c.input;
    const amount = spec ? amountOf(spec, ran) : null;
    if (amount) {
      const add = (m: Map<string, Decimal>) =>
        m.set(amount.currency, (m.get(amount.currency) ?? new Decimal(0)).plus(amount.value));
      add(entry.sums);
      add(all);
    }
    const entity = (spec ? entityOfCall(spec, ran) : undefined) ?? "other";
    entry.entities.set(entity, (entry.entities.get(entity) ?? 0) + 1);
    perConnector.set(c.connector, entry);
  }
  const byConnector = [...perConnector]
    .map(([connector, e]) => ({
      connector,
      name: platform.connectors.get(connector)?.manifest.name ?? connector,
      count: e.count,
      amounts: amountList(e.sums),
      entities: [...e.entities]
        .map(([entity, count]) => ({ entity, count }))
        .sort((a, b) => b.count - a.count || a.entity.localeCompare(b.entity)),
      filter: withFilter({ changedConnector: connector }),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // ── What it handled ─────────────────────────────────────────────────────────────────────────
  const handled = handledKinds.map((k) => {
    // DECISION: a kind opens its runs by its records (RunFilter's `about`) only when every one of
    // them is one of our records and there are at most RUN_ABOUT_MAX of them; otherwise no filter.
    const exact = k.allRecords && k.records > 0 && k.records <= RUN_ABOUT_MAX;
    return {
      kind: k.kind,
      records: k.records,
      runs: k.runs,
      filter: exact ? withFilter({ about: k.ids.map((id) => ({ kind: k.kind, id })) }) : null,
      top: handledTop
        .filter((t) => t.kind === k.kind)
        .map((t) => ({
          id: t.id,
          label: t.label,
          number: t.number,
          runs: t.runs,
          filter: t.id ? withFilter({ about: [{ kind: k.kind, id: t.id }] }) : null,
        })),
    };
  });

  // ── Its own KPIs, over the period ───────────────────────────────────────────────────────────
  const { since, until } = periodBounds(input.from, input.to, timezone);
  const kpis: KpiValue[] =
    view?.view && view.view.kpis.length > 0
      ? await computeKpis(tx, { tenantId, agentId: input.agent.id }, view.view.kpis, {
          locale: input.locale,
          boundsOf: () => ({ from: since, to: until }),
        })
      : [];

  return {
    service: { id: input.agent.id, name: input.agent.serviceName ?? input.agent.name },
    from: input.from,
    to: input.to,
    timezone,
    headline: current,
    previous,
    runs: { count: runCount, filter: withFilter({}) },
    outcomes: totals,
    perDay,
    timeToFinish: {
      runs: { count: Number(finish?.runs ?? 0), filter: totals.done.filter },
      medianMs: ms(finish?.median),
      p90Ms: ms(finish?.p90),
    },
    waitingOnPeople: {
      answered: Number(waits?.answered ?? 0),
      open: Number(waits?.open ?? 0),
      medianMs: ms(waits?.median),
      p90Ms: ms(waits?.p90),
      totalMs: ms(waits?.total) ?? 0,
    },
    approvals: { signed, edited, turnedDown, byPerson },
    changes: {
      // RunFilter takes one tool a change was made in: the total opens its runs when there is one.
      total: {
        count: changes.length,
        filter: byConnector.length === 1 ? (byConnector[0]?.filter ?? null) : null,
      },
      amounts: amountList(all),
      byConnector,
    },
    handled,
    kpis,
  };
}

/** A kept row's identity: our record's id, else the tool's id for it, else its words. */
const subjectKey = sql<string>`coalesce(${runSubject.recordId}::text,
  ${runSubject.connector} || ':' || ${runSubject.externalId},
  'w:' || coalesce(${runSubject.label}, '') || '|' || coalesce(${runSubject.number}, ''))`;

/** The scope's kept rows (the portal's: those its timeline shows). */
function subjectWhere(scope: Scope): SQL[] {
  return [
    eq(runSubject.tenantId, scope.tenantId),
    ...(scope.surface === "portal" ? [eq(runSubject.clientVisible, true)] : []),
    ...scope.where,
  ];
}

async function handledByKind(tx: Tx, scope: Scope) {
  const rows = await tx
    .select({
      kind: runSubject.kind,
      records: sql<number>`count(distinct ${subjectKey})::int`,
      runs: sql<number>`count(distinct ${runSubject.runId})::int`,
      allRecords: sql<boolean>`bool_and(${runSubject.recordId} is not null)`,
      ids: sql<
        string[]
      >`coalesce(array_agg(distinct ${runSubject.recordId}::text) filter (where ${runSubject.recordId} is not null), '{}')`,
    })
    .from(runSubject)
    .innerJoin(run, and(eq(run.id, runSubject.runId), eq(run.tenantId, runSubject.tenantId)))
    .where(and(...subjectWhere(scope)))
    .groupBy(runSubject.kind);
  return rows
    .map((r) => ({
      kind: r.kind as RunSubjectKind,
      records: Number(r.records),
      runs: Number(r.runs),
      allRecords: r.allRecords === true,
      ids: (r.ids ?? []).slice(0, RUN_ABOUT_MAX + 1),
    }))
    .sort((a, b) => b.runs - a.runs || a.kind.localeCompare(b.kind));
}

/** Each kind's records with the most runs (AGENT_REPORT_TOP), with their latest words. */
async function handledTopRecords(tx: Tx, scope: Scope) {
  const grouped = tx
    .select({
      kind: sql<string>`${runSubject.kind}`.as("kind"),
      key: sql<string>`${subjectKey}`.as("key"),
      id: sql<string | null>`max(${runSubject.recordId}::text)`.as("id"),
      label: sql<
        string | null
      >`(array_agg(${runSubject.label} order by ${runSubject.createdAt} desc) filter (where ${runSubject.label} is not null))[1]`.as(
        "label",
      ),
      number: sql<
        string | null
      >`(array_agg(${runSubject.number} order by ${runSubject.createdAt} desc) filter (where ${runSubject.number} is not null))[1]`.as(
        "number",
      ),
      runs: sql<number>`count(distinct ${runSubject.runId})::int`.as("runs"),
    })
    .from(runSubject)
    .innerJoin(run, and(eq(run.id, runSubject.runId), eq(run.tenantId, runSubject.tenantId)))
    .where(and(...subjectWhere(scope)))
    .groupBy(runSubject.kind, subjectKey)
    .as("grouped");
  const ranked = tx
    .select({
      kind: grouped.kind,
      id: grouped.id,
      label: grouped.label,
      number: grouped.number,
      runs: grouped.runs,
      rank: sql<number>`row_number() over (partition by ${grouped.kind} order by ${grouped.runs} desc, ${grouped.label} nulls last, ${grouped.key})`.as(
        "rank",
      ),
    })
    .from(grouped)
    .as("ranked");
  const rows = await tx
    .select({
      kind: ranked.kind,
      id: ranked.id,
      label: ranked.label,
      number: ranked.number,
      runs: ranked.runs,
    })
    .from(ranked)
    .where(sql`${ranked.rank} <= ${AGENT_REPORT_TOP}`)
    .orderBy(ranked.kind, ranked.rank);
  return rows.map((r) => ({ ...r, runs: Number(r.runs) }));
}

/** The back office's own figures: the five most frequent errors and what the runs cost. */
export async function opsReportExtras(
  tx: Tx,
  platform: Platform,
  input: Pick<ReportInput, "agent" | "tenantId" | "timezone" | "from" | "to">,
): Promise<Pick<OpsAgentReport, "errors" | "spend">> {
  const scope = scopeOf(platform, { ...input, surface: "ops" }, input.from, input.to);
  const [groups, [spend], [tokens]] = await Promise.all([
    runErrorGroups(tx, scope.where),
    tx
      .select({
        runs: sql<number>`count(*)::int`,
        cost: sql<string>`coalesce(sum(${run.costUsd}), 0)::text`,
      })
      .from(run)
      .where(and(...scope.where)),
    tx
      .select({
        tokensIn: sql<string>`coalesce(sum(${stepRun.tokensIn}), 0)::text`,
        tokensOut: sql<string>`coalesce(sum(${stepRun.tokensOut}), 0)::text`,
      })
      .from(stepRun)
      .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
      .where(and(eq(stepRun.tenantId, input.tenantId), ...scope.where)),
  ]);
  const runs = Number(spend?.runs ?? 0);
  const cost = new Decimal(spend?.cost ?? "0");
  const tokensIn = Number(tokens?.tokensIn ?? 0);
  const tokensOut = Number(tokens?.tokensOut ?? 0);
  return {
    errors: groups.slice(0, AGENT_REPORT_ERRORS).map((g) => ({
      key: g.key,
      count: g.count,
      filter: { ...scope.base, statuses: ["failed"], errorKey: g.key },
    })),
    spend: {
      runs,
      costUsd: cost.toFixed(4),
      costPerRunUsd: runs > 0 ? cost.div(runs).toFixed(4) : null,
      tokensIn,
      tokensOut,
      tokensPerRun: runs > 0 ? Math.round((tokensIn + tokensOut) / runs) : null,
      filter: scope.base,
    },
  };
}
