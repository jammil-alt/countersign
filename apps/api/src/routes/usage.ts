// Usage and reports (docs/plan.md §1.15). The back office reads the `usage_daily` rollup per client,
// client agent and template, by month, with model cost (operator only, scoped to the clients the
// operator serves). The portal's activity report and service page count what the client's services
// did from the rows themselves: live runs, documents, changes made to its tools. They never carry
// cost, tokens or prompts (invariant 11): their contract schemas have no such fields.

import {
  type ActivityReport,
  Decimal,
  routes,
  toNumeric,
  USAGE_MAX_DAYS,
  type UsageFigures,
} from "@countersign/core";
import {
  agent,
  connection,
  document,
  externalAction,
  run,
  type Tx,
  tenant,
  tenantPack,
  usageDaily,
  usagePlatformDaily,
} from "@countersign/db";
import {
  and,
  type Column,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import type { Platform } from "../platform";
import { noRuns, runCounts } from "../runs/client-status";
import { runSummaries } from "./portal";

// ── Days and months ──────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const dayMs = (day: string) => new Date(`${day}T00:00:00.000Z`).getTime();

/** `YYYY-MM-DD` of now in a time zone (UTC if the zone is unknown). */
export function todayIn(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The first day of the month `back` months before `day`'s month. */
export function monthStart(day: string, back = 0): string {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 10);
}

/** Every `YYYY-MM` from `from`'s month to `to`'s, oldest first. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  for (let m = monthStart(from); m <= to; m = monthStart(m, -1)) months.push(m.slice(0, 7));
  return months;
}

/** A request's range: both ends inclusive, `from` not after `to`, at most USAGE_MAX_DAYS days. */
function checkRange(from: string, to: string): void {
  if (from > to) throw new HttpError(422, "invalid_range", "from is after to");
  if ((dayMs(to) - dayMs(from)) / DAY_MS + 1 > USAGE_MAX_DAYS) {
    throw new HttpError(422, "invalid_range", `a range is at most ${USAGE_MAX_DAYS} days`);
  }
}

// ── Back office: usage and cost ──────────────────────────────────────────────────────────────────

interface Sum {
  runs: number;
  steps: number;
  documents: number;
  externalActions: number;
  tokensIn: number;
  tokensOut: number;
  cost: Decimal;
}

const zero = (): Sum => ({
  runs: 0,
  steps: 0,
  documents: 0,
  externalActions: 0,
  tokensIn: 0,
  tokensOut: 0,
  cost: new Decimal(0),
});

function add(into: Sum, x: Sum): void {
  into.runs += x.runs;
  into.steps += x.steps;
  into.documents += x.documents;
  into.externalActions += x.externalActions;
  into.tokensIn += x.tokensIn;
  into.tokensOut += x.tokensOut;
  into.cost = into.cost.plus(x.cost);
}

const figures = (s: Sum): UsageFigures => ({
  runs: s.runs,
  steps: s.steps,
  documents: s.documents,
  externalActions: s.externalActions,
  tokensIn: s.tokensIn,
  tokensOut: s.tokensOut,
  costUsd: toNumeric(s.cost),
});

/** A row's total and its months, summed with decimal.js. */
class Series {
  readonly total = zero();
  readonly byMonth = new Map<string, Sum>();
  add(month: string, x: Sum): void {
    add(this.total, x);
    const m = this.byMonth.get(month) ?? zero();
    add(m, x);
    this.byMonth.set(month, m);
  }
  out(months: readonly string[]) {
    return {
      total: figures(this.total),
      byMonth: months.map((month) => ({
        month,
        figures: figures(this.byMonth.get(month) ?? zero()),
      })),
    };
  }
}

/** Highest cost first, then by name. */
const byCost = (a: { s: Series; name: string }, b: { s: Series; name: string }) =>
  b.s.total.cost.comparedTo(a.s.total.cost) || a.name.localeCompare(b.name);

const MONTH = sql<string>`to_char(${usageDaily.day}, 'YYYY-MM')`;

const PLATFORM_MONTH = sql<string>`to_char(${usagePlatformDaily.day}, 'YYYY-MM')`;

/** v0.12 W1-H: the clients' own usage (usage_platform_daily) by client and month. */
function platformRows(
  tx: Tx,
  tenantIds: readonly string[],
  query: { client?: string | undefined; from: string; to: string },
) {
  return tx
    .select({
      tenantId: usagePlatformDaily.tenantId,
      month: PLATFORM_MONTH,
      documents: sql<string>`sum(${usagePlatformDaily.documents})::text`,
      tokensIn: sql<string>`sum(${usagePlatformDaily.tokensIn})::text`,
      tokensOut: sql<string>`sum(${usagePlatformDaily.tokensOut})::text`,
      cost: sql<string>`sum(${usagePlatformDaily.costUsd})::text`,
    })
    .from(usagePlatformDaily)
    .where(
      and(
        inArray(usagePlatformDaily.tenantId, [...tenantIds]),
        gte(usagePlatformDaily.day, query.from),
        lte(usagePlatformDaily.day, query.to),
        ...(query.client ? [eq(usagePlatformDaily.tenantId, query.client)] : []),
      ),
    )
    .groupBy(usagePlatformDaily.tenantId, PLATFORM_MONTH);
}

async function usageReport(
  tx: Tx,
  tenantIds: readonly string[],
  query: {
    client?: string | undefined;
    agent?: string | undefined;
    template?: string | undefined;
    from: string;
    to: string;
  },
) {
  const months = monthsBetween(query.from, query.to);
  const all = new Series();
  const empty = {
    from: query.from,
    to: query.to,
    months,
    ...all.out(months),
    clients: [],
    agents: [],
    templates: [],
  };
  if (tenantIds.length === 0) return empty;

  // RLS holds the scope; the query says it too (invariant 1).
  const where: SQL[] = [
    inArray(usageDaily.tenantId, [...tenantIds]),
    gte(usageDaily.day, query.from),
    lte(usageDaily.day, query.to),
  ];
  if (query.client) where.push(eq(usageDaily.tenantId, query.client));
  if (query.agent) where.push(eq(usageDaily.agentId, query.agent));
  if (query.template) where.push(eq(agent.templateId, query.template));
  // Integers come back as text and money as numeric text: nothing passes through a JS float.
  const rows = await tx
    .select({
      tenantId: usageDaily.tenantId,
      agentId: usageDaily.agentId,
      month: MONTH,
      runs: sql<string>`sum(${usageDaily.runs})::text`,
      steps: sql<string>`sum(${usageDaily.steps})::text`,
      documents: sql<string>`sum(${usageDaily.documents})::text`,
      externalActions: sql<string>`sum(${usageDaily.externalActions})::text`,
      tokensIn: sql<string>`sum(${usageDaily.tokensIn})::text`,
      tokensOut: sql<string>`sum(${usageDaily.tokensOut})::text`,
      cost: sql<string>`sum(${usageDaily.costUsd})::text`,
    })
    .from(usageDaily)
    .innerJoin(
      agent,
      and(eq(agent.id, usageDaily.agentId), eq(agent.tenantId, usageDaily.tenantId)),
    )
    .where(and(...where))
    .groupBy(usageDaily.tenantId, usageDaily.agentId, MONTH);
  // v0.12 W1-H: the clients' own usage (background reading), unless narrowed to an agent or a
  // template, which it is not part of.
  const narrowed = Boolean(query.agent || query.template);
  const platform = narrowed ? [] : await platformRows(tx, tenantIds, query);
  if (rows.length === 0 && platform.length === 0) return empty;

  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const agents = await tx
    .select({
      id: agent.id,
      tenantId: agent.tenantId,
      slug: agent.slug,
      name: agent.name,
      templateId: agent.templateId,
      testCopy: agent.testCopy,
    })
    .from(agent)
    .where(and(inArray(agent.id, agentIds), inArray(agent.tenantId, [...tenantIds])));
  const templateIds = [
    ...new Set(agents.map((a) => a.templateId).filter((v): v is string => v !== null)),
  ];
  // Templates have no client (tenant_id null): operator sessions see them (ARCHITECTURE §4).
  const templates =
    templateIds.length > 0
      ? await tx
          .select({ id: agent.id, slug: agent.slug, name: agent.name })
          .from(agent)
          .where(and(inArray(agent.id, templateIds), isNull(agent.tenantId)))
      : [];
  const clientIds = [...new Set([...rows, ...platform].map((r) => r.tenantId))];
  const clients = await tx
    .select({ id: tenant.id, name: tenant.name })
    .from(tenant)
    .where(inArray(tenant.id, clientIds));

  const clientSeries = new Map<string, Series>();
  const agentSeries = new Map<string, Series>();
  const templateSeries = new Map<
    string,
    { s: Series; clients: Set<string>; agents: Set<string> }
  >();
  const agentOf = new Map(agents.map((a) => [a.id, a]));
  for (const r of rows) {
    const x: Sum = {
      runs: Number(r.runs),
      steps: Number(r.steps),
      documents: Number(r.documents),
      externalActions: Number(r.externalActions),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      cost: new Decimal(r.cost ?? "0"),
    };
    all.add(r.month, x);
    const c = clientSeries.get(r.tenantId) ?? new Series();
    c.add(r.month, x);
    clientSeries.set(r.tenantId, c);
    const a = agentSeries.get(r.agentId) ?? new Series();
    a.add(r.month, x);
    agentSeries.set(r.agentId, a);
    const templateId = agentOf.get(r.agentId)?.templateId;
    if (templateId) {
      const t = templateSeries.get(templateId) ?? {
        s: new Series(),
        clients: new Set<string>(),
        agents: new Set<string>(),
      };
      t.s.add(r.month, x);
      t.clients.add(r.tenantId);
      t.agents.add(r.agentId);
      templateSeries.set(templateId, t);
    }
  }

  const background = new Series();
  for (const r of platform) {
    const x: Sum = {
      ...zero(),
      documents: Number(r.documents),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      cost: new Decimal(r.cost ?? "0"),
    };
    all.add(r.month, x);
    background.add(r.month, x);
    const c = clientSeries.get(r.tenantId) ?? new Series();
    c.add(r.month, x);
    clientSeries.set(r.tenantId, c);
  }

  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const template = new Map(templates.map((t) => [t.id, t]));
  return {
    from: query.from,
    to: query.to,
    months,
    ...all.out(months),
    ...(narrowed ? {} : { background: background.out(months) }),
    clients: [...clientSeries]
      .map(([id, s]) => ({ id, name: clientName.get(id) ?? "", s }))
      .sort(byCost)
      .map(({ id, name, s }) => ({ id, name, ...s.out(months) })),
    agents: [...agentSeries]
      .flatMap(([id, s]) => {
        const a = agentOf.get(id);
        return a ? [{ a, name: a.name, s }] : [];
      })
      .sort(byCost)
      .map(({ a, s }) => {
        const t = a.templateId ? template.get(a.templateId) : undefined;
        return {
          id: a.id,
          slug: a.slug,
          name: a.name,
          client: { id: a.tenantId as string, name: clientName.get(a.tenantId as string) ?? "" },
          template: t ? { id: t.id, slug: t.slug, name: t.name } : null,
          testCopy: a.testCopy,
          ...s.out(months),
        };
      }),
    templates: [...templateSeries]
      .flatMap(([id, v]) => {
        const t = template.get(id);
        return t ? [{ t, name: t.name, ...v }] : [];
      })
      .sort(byCost)
      .map(({ t, s, clients, agents }) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        clients: clients.size,
        agents: agents.size,
        ...s.out(months),
      })),
  };
}

// ── Portal: activity ─────────────────────────────────────────────────────────────────────────────

type Runs = ActivityReport["runs"];

const serviceName = (a: { serviceName: string | null; name: string }) => a.serviceName ?? a.name;

/**
 * A client's services: its client agents that have gone live (active or paused now, or retired
 * after), never drafts, agents in testing or a template's test copy.
 */
// DECISION: a retired service keeps its page, so links from old runs and reports still open.
const isService = (tenantId: string) =>
  and(
    eq(agent.tenantId, tenantId),
    eq(agent.kind, "client"),
    eq(agent.testCopy, false),
    inArray(agent.runStatus, ["active", "paused", "retired"]),
  ) as SQL;

async function clientTimezone(tx: Tx, tenantId: string): Promise<string> {
  const [t] = await tx
    .select({ timezone: tenant.timezone })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  if (!t) throw notFound("client");
  return t.timezone;
}

/**
 * What a client's services did between two of its days (inclusive, in its time zone): live runs by
 * how they ended, documents received and read, changes made to its tools by connector.
 */
// DECISION: the portal's figures are counted from the rows, not from usage_daily: the rollup is the
// operator's ledger (UTC days, test runs included), while a client's report is its own days and
// live work only. Documents read by a test run still count as read: the document was read.
async function activity(
  tx: Tx,
  platform: Platform,
  input: { tenantId: string; timezone: string; from: string; to: string; service?: string },
): Promise<ActivityReport> {
  const t = input.tenantId;
  const lo = sql`((${input.from})::date)::timestamp at time zone ${input.timezone}`;
  const hi = sql`((${input.to})::date + 1)::timestamp at time zone ${input.timezone}`;
  const inPeriod = (col: Column) => and(gte(col, lo), lt(col, hi)) as SQL;
  const svc = input.service;

  // QA round 1: runs started in the period by the client's states (waiting = on the client).
  const counts = await runCounts(tx, t, { lo, hi }, svc ? [eq(run.agentId, svc)] : []);

  const [received] = await tx
    .select({ n: sql<string>`count(*)::text` })
    .from(document)
    .where(and(eq(document.tenantId, t), inPeriod(document.receivedAt)));

  // QA round 1: read = extracted (attributed to a service through the agent version that read
  // it), or worked on by a live run started in the period (the document that started it, e.g. an
  // invoice read on upload that the Bill clerk then matched). One definition for the total and
  // each service, so a service's count is never above the total.
  const readSql = sql`
    select av.agent_id, de.document_id::text as document_id
      from doc_extraction de
      left join agent_version av on av.id = de.agent_version_id and av.tenant_id = de.tenant_id
     where de.tenant_id = ${t} and de.created_at >= ${lo} and de.created_at < ${hi}
    union
    select r.agent_id, r.trigger->'payload'->>'documentId'
      from run r
     where r.tenant_id = ${t} and r.mode = 'live' and r.created_at >= ${lo} and r.created_at < ${hi}
       and jsonb_typeof(r.trigger->'payload'->'documentId') = 'string'
       and exists (select 1 from document d
                    where d.tenant_id = r.tenant_id
                      and d.id::text = r.trigger->'payload'->>'documentId')`;
  const readList = [
    ...(await tx.execute<{ agentId: string | null; documentId: string }>(sql`
      select read.agent_id as "agentId", read.document_id as "documentId" from (${readSql}) read
       ${svc ? sql`where read.agent_id = ${svc}` : sql``}`)),
  ];
  const readTotal = new Set(readList.map((r) => r.documentId)).size;
  const readByAgent = new Map<string, Set<string>>();
  for (const r of readList) {
    if (!r.agentId) continue;
    const docs = readByAgent.get(r.agentId) ?? new Set<string>();
    docs.add(r.documentId);
    readByAgent.set(r.agentId, docs);
  }

  const actionRows = await tx
    .select({
      agentId: run.agentId,
      connector: connection.connector,
      n: sql<string>`count(*)::text`,
    })
    .from(externalAction)
    .innerJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .leftJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .where(
      and(
        eq(externalAction.tenantId, t),
        eq(externalAction.status, "done"),
        inPeriod(externalAction.executedAt),
        or(isNull(run.mode), eq(run.mode, "live")),
        ...(svc ? [eq(run.agentId, svc)] : []),
      ),
    )
    .groupBy(run.agentId, connection.connector);

  const agents = await tx
    .select({
      id: agent.id,
      name: agent.name,
      serviceName: agent.serviceName,
      runStatus: agent.runStatus,
    })
    .from(agent)
    .where(and(isService(t), ...(svc ? [eq(agent.id, svc)] : [])))
    .orderBy(agent.slug);
  const packs = await tx
    .select({ pack: tenantPack.pack })
    .from(tenantPack)
    .where(eq(tenantPack.tenantId, t))
    .orderBy(tenantPack.pack);

  const runs = counts.all;
  const perService = new Map<string, { runs: Runs; documentsRead: number; actions: number }>();
  const entry = (id: string) => {
    const e = perService.get(id) ?? { runs: noRuns(), documentsRead: 0, actions: 0 };
    perService.set(id, e);
    return e;
  };
  for (const [agentId, r] of counts.byAgent) entry(agentId).runs = r;
  for (const [agentId, docs] of readByAgent) entry(agentId).documentsRead = docs.size;
  const byConnector = new Map<string, number>();
  let actions = 0;
  for (const r of actionRows) {
    const n = Number(r.n);
    actions += n;
    byConnector.set(r.connector, (byConnector.get(r.connector) ?? 0) + n);
    if (r.agentId) entry(r.agentId).actions += n;
  }

  // Services shown: those still offered (active or paused), and any other that worked this period.
  const services = agents
    .filter((a) => a.runStatus === "active" || a.runStatus === "paused" || perService.has(a.id))
    .map((a) => {
      const e = perService.get(a.id) ?? { runs: noRuns(), documentsRead: 0, actions: 0 };
      return { id: a.id, name: serviceName(a), ...e };
    });

  return {
    from: input.from,
    to: input.to,
    timezone: input.timezone,
    runs,
    documents: { received: Number(received?.n ?? "0"), read: readTotal },
    actions: {
      total: actions,
      byConnector: [...byConnector]
        .map(([connector, count]) => ({
          connector,
          name: platform.connectors.get(connector)?.manifest.name ?? connector,
          count,
        }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
    services,
    packs: packs.map((p) => p.pack),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────────

export function usageRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.opsUsage, async ({ tx, tenantIds, query }) => {
    // DECISION: the back office's default range is the last six months (this one and the five
    // before), in UTC days like the rollup; a range spans at most USAGE_MAX_DAYS days.
    const to = query.to ?? new Date().toISOString().slice(0, 10);
    const from = query.from ?? monthStart(to, 5);
    checkRange(from, to);
    return usageReport(tx, tenantIds, { ...query, from, to });
  });

  mount(app, routes.portalActivityReport, async ({ tx, tenantIds, query, services }) => {
    const tenantId = tenantIds[0] as string;
    const timezone = await clientTimezone(tx, tenantId);
    // DECISION: the portal's default period is this month so far, in the client's time zone.
    const to = query.to ?? todayIn(timezone);
    const from = query.from ?? monthStart(to);
    checkRange(from, to);
    if (query.service) {
      const [a] = await tx
        .select({ id: agent.id })
        .from(agent)
        .where(and(isService(tenantId), eq(agent.id, query.service)));
      if (!a) throw notFound("service");
    }
    return activity(tx, services.platform, {
      tenantId,
      timezone,
      from,
      to,
      ...(query.service ? { service: query.service } : {}),
    });
  });

  mount(app, routes.portalService, async ({ tx, tenantIds, params, services }) => {
    const tenantId = tenantIds[0] as string;
    const [a] = await tx
      .select()
      .from(agent)
      .where(and(isService(tenantId), eq(agent.id, params.id)));
    if (!a) throw notFound("service");
    const timezone = await clientTimezone(tx, tenantId);
    const to = todayIn(timezone);
    const from = monthStart(to);
    const report = await activity(tx, services.platform, {
      tenantId,
      timezone,
      from,
      to,
      service: a.id,
    });
    const mine = report.services.find((s) => s.id === a.id);
    return {
      service: {
        id: a.id,
        name: serviceName(a),
        description: a.serviceDescription,
        status: a.runStatus ?? "draft",
      },
      thisMonth: {
        from,
        to,
        runs: mine?.runs ?? noRuns(),
        documentsRead: mine?.documentsRead ?? 0,
        actions: mine?.actions ?? 0,
      },
      recentRuns: await runSummaries(tx, tenantId, [eq(run.agentId, a.id)], 10, services.platform),
      packs: report.packs,
    };
  });
}
