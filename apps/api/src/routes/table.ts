// The Table and the Weekly Table (ARCHITECTURE §11.4, §14 v0.12; docs/plan.md §1.37). The Table is
// the portal's home, built from rows the portal already reads: each service and what it is doing
// now, this week's figures, the latest client-visible step summaries, the top three Desk items and
// the lead's latest message. Never a bundle, a prompt or a cost (invariant 11). The Weekly Table's
// routes: the lead's edits in the back office, sent tables and their PDF in the portal.

import {
  addDays,
  clientLabel,
  clientLanguage,
  findNodeStep,
  type Locale,
  routes,
  shownOnTimeline,
  type TableView,
  userLanguage,
  weekBounds,
  weekStartOf,
} from "@countersign/core";
import {
  agent,
  agentVersion,
  appUser,
  connection,
  externalAction,
  inboxItem,
  message,
  run,
  stepRun,
  type Tx,
  thread,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { senseEmitPosted } from "@countersign/threads";
import { and, desc, eq, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { clientTitles } from "../change-display";
import { type AppEnv, ensureClient, mount, notFound } from "../http";
// v0.12 W2-G
import { clientViewSql, parseClientView, readerLocale, weekKpisOf } from "../kpi/view";
import { leadUserId, type TenantRow, tenantRow } from "../notify/people";
import { LEAD_SUBJECT } from "../notify/scan";
import type { Platform } from "../platform";
import { at, clientState, countState, noRuns } from "../runs/client-status";
import { dispatchEvents } from "../runs/dispatch";
import { daysOf, runsByDay } from "../runs/figures";
import { paperFor, weeklyPdf } from "../weekly/pdf";
import { clientDescription, serviceName } from "../weekly/stats";
import { editWeek, replyToDecision, weeklyRow, weeklyRows, weeklyView } from "../weekly/tables";
import { portalInboxFilter, sourcesOf } from "./portal";
import { agentsNow, documentsReadSql, isLiveService, serviceNow, workflowsOf } from "./usage";

async function clientOf(tx: Tx, tenantId: string): Promise<TenantRow> {
  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  return t;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The Table's services with the client view of their live version (a JSON path, never the bundle). */
function servicesWithViews(tx: Tx, tenantId: string) {
  return tx
    .select({ a: agent, view: clientViewSql })
    .from(agent)
    .leftJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(isLiveService(tenantId))
    .orderBy(agent.slug);
}

/**
 * Live runs started this week and last week by the client's states, per agent, in one read
 * (`runCounts`' definition: a run counts in the week it was created).
 */
async function weekRunCounts(
  tx: Tx,
  tenantId: string,
  week: { from: Date; to: Date },
  lastWeek: { from: Date; to: Date },
) {
  const which = sql<"this" | "last" | null>`case
    when ${run.createdAt} >= ${at(week.from)} and ${run.createdAt} < ${at(week.to)} then 'this'
    when ${run.createdAt} >= ${at(lastWeek.from)} and ${run.createdAt} < ${at(lastWeek.to)} then 'last'
    end`;
  const rows = await tx
    .select({
      agentId: run.agentId,
      state: clientState,
      week: which,
      n: sql<number>`count(*)::int`,
    })
    .from(run)
    .where(
      and(
        eq(run.tenantId, tenantId),
        eq(run.mode, "live"),
        sql`${run.createdAt} >= ${at(lastWeek.from)}`,
        sql`${run.createdAt} < ${at(week.to)}`,
      ),
    )
    // By position: the bounds are parameters, and a repeated expression would be another one.
    .groupBy(sql`1`, sql`2`, sql`3`);
  const all = noRuns();
  const lastAll = noRuns();
  const byAgent = new Map<string, ReturnType<typeof noRuns>>();
  for (const r of rows) {
    const n = Number(r.n);
    if (r.week === "last") {
      countState(lastAll, r.state, n);
      continue;
    }
    if (r.week !== "this") continue;
    countState(all, r.state, n);
    const mine = byAgent.get(r.agentId) ?? noRuns();
    countState(mine, r.state, n);
    byAgent.set(r.agentId, mine);
  }
  return { all, byAgent, lastWeek: lastAll };
}

/**
 * Changes to the client's tools this week and last: per agent as Reports counts them
 * (`activity`), and signed or automatic as the Weekly Table counts them (`toolChanges`).
 */
async function weekChanges(
  tx: Tx,
  tenantId: string,
  week: { from: Date; to: Date },
  lastWeek: { from: Date; to: Date },
) {
  const thisWeek = sql`${externalAction.executedAt} >= ${at(week.from)} and ${externalAction.executedAt} < ${at(week.to)}`;
  const rows = await tx
    .select({
      agentId: run.agentId,
      // `activity`: through a connection, by a live run or none.
      actions: sql<number>`(count(*) filter (where ${thisWeek} and ${connection.id} is not null and (${run.mode} is null or ${run.mode} = 'live')))::int`,
      signed: sql<number>`(count(*) filter (where ${thisWeek} and ${externalAction.approvedBy} is not null))::int`,
      automatic: sql<number>`(count(*) filter (where ${thisWeek} and ${externalAction.approvedBy} is null))::int`,
      lastWeek: sql<number>`(count(*) filter (where ${externalAction.executedAt} < ${at(lastWeek.to)}))::int`,
    })
    .from(externalAction)
    .leftJoin(
      connection,
      and(
        eq(connection.id, externalAction.connectionId),
        eq(connection.tenantId, externalAction.tenantId),
      ),
    )
    .leftJoin(run, and(eq(run.id, externalAction.runId), eq(run.tenantId, externalAction.tenantId)))
    .where(
      and(
        eq(externalAction.tenantId, tenantId),
        eq(externalAction.status, "done"),
        gte(externalAction.executedAt, lastWeek.from),
        lt(externalAction.executedAt, week.to),
      ),
    )
    .groupBy(run.agentId);
  const byAgent = new Map<string, number>();
  const out = { signed: 0, automatic: 0, lastWeek: 0, byAgent };
  for (const r of rows) {
    out.signed += Number(r.signed);
    out.automatic += Number(r.automatic);
    out.lastWeek += Number(r.lastWeek);
    if (r.agentId) byAgent.set(r.agentId, (byAgent.get(r.agentId) ?? 0) + Number(r.actions));
  }
  return out;
}

/** Documents read this week (in all and per agent) and last week (in all), as Reports counts them. */
async function weekDocumentsRead(
  tx: Tx,
  tenantId: string,
  week: { from: Date; to: Date },
  lastWeek: { from: Date; to: Date },
) {
  const rows = await tx.execute<{ agentId: string | null; documentId: string; thisWeek: boolean }>(
    sql`select read.agent_id as "agentId", read.document_id as "documentId",
               read.at >= ${at(week.from)} as "thisWeek"
          from (${documentsReadSql(tenantId, at(lastWeek.from), at(week.to))}) read`,
  );
  const all = new Set<string>();
  const last = new Set<string>();
  const byAgent = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.thisWeek) {
      last.add(r.documentId);
      continue;
    }
    all.add(r.documentId);
    if (!r.agentId) continue;
    const docs = byAgent.get(r.agentId) ?? new Set<string>();
    docs.add(r.documentId);
    byAgent.set(r.agentId, docs);
  }
  return { all: all.size, lastWeek: last.size, byAgent };
}

/** The latest client-visible step summaries of the Table's services: a page of candidates. */
function recentSteps(tx: Tx, tenantId: string) {
  return (
    tx
      .select({
        s: {
          id: stepRun.id,
          nodeId: stepRun.nodeId,
          summary: stepRun.summary,
          // Only what `sourcesOf` reads, not the whole output.
          sources: sql<unknown>`${stepRun.output} -> 'sources'`,
          startedAt: stepRun.startedAt,
          finishedAt: stepRun.finishedAt,
        },
        r: {
          id: run.id,
          agentId: run.agentId,
          agentVersionId: run.agentVersionId,
          workflowSlug: run.workflowSlug,
        },
      })
      .from(stepRun)
      .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
      .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.tenantId, run.tenantId)))
      .where(
        and(
          eq(stepRun.tenantId, tenantId),
          eq(run.mode, "live"),
          isNotNull(stepRun.summary),
          isLiveService(tenantId),
        ),
      )
      // QA round 1: newest first by the time each row shows (finished, else started), so a step
      // still waiting doesn't sink below older ones.
      .orderBy(
        sql`coalesce(${stepRun.finishedAt}, ${stepRun.startedAt}) desc nulls last`,
        desc(stepRun.id),
      )
      .limit(40)
  );
}

// DECISION (audit-plan 6.1): the Table is read in three rounds of reads asked together: the
// client row; then every read that needs only the client (services with their client views,
// the two weeks' counts, each service's latest run with its step and wait, the Desk, the recent
// steps, the lead); then the KPIs, the workflows the steps are named from, and the Desk titles.
// No count grows per agent or per KPI.
async function buildTable(
  tx: Tx,
  t: TenantRow,
  viewer: { userId: string; role: Parameters<typeof portalInboxFilter>[0] },
  now: Date,
  platform: Platform,
): Promise<TableView> {
  const weekStart = weekStartOf(now, t.timezone);
  const bounds = weekBounds(weekStart, t.timezone);
  // UI cleanup (design pass): Home's KPI strip and each agent card's figures, counted as Reports
  // counts them (`activity`): this week so far and all of last week, in the client's days.
  const lastBounds = weekBounds(addDays(weekStart, -7), t.timezone);
  const locale = readerLocale(t, viewer.userId);

  // Open Desk items the viewer sees (snoozed ones wait), for "waiting on you" and the top three.
  const deskWhere = and(
    eq(inboxItem.tenantId, t.id),
    eq(inboxItem.status, "open"),
    portalInboxFilter(viewer.role, viewer.userId),
    or(isNull(inboxItem.snoozedUntil), lte(inboxItem.snoozedUntil, now)),
  );
  const [agentRows, counts, changes, read, daily, nowRows, desk, steps, lead] = await Promise.all([
    servicesWithViews(tx, t.id),
    // QA round 1: runs started this week by how they stand, as Reports counts them.
    weekRunCounts(tx, t.id, bounds, lastBounds),
    weekChanges(tx, t.id, bounds, lastBounds),
    weekDocumentsRead(tx, t.id, bounds, lastBounds),
    runsByDay(tx, [eq(run.tenantId, t.id), eq(run.mode, "live")], { timezone: t.timezone, now }),
    // What each agent has going now (any run, not only its latest) for its state, and its latest.
    agentsNow(tx, t.id),
    tx
      .select()
      .from(inboxItem)
      .where(deskWhere)
      .orderBy(sql`${inboxItem.dueAt} asc nulls last`, desc(inboxItem.createdAt)),
    recentSteps(tx, t.id),
    leadOf(tx, t),
  ]);
  const agents = agentRows.map((r) => r.a);
  const nowOf = new Map(nowRows.map((r) => [r.agentId, r]));
  const top = desk.slice(0, 3);

  const [kpis, workflows, titles] = await Promise.all([
    // v0.12 W2-G: each service's KPIs for this week, in the viewer's language.
    weekKpisOf(
      tx,
      agentRows.map((r) => ({
        agent: r.a,
        view: r.a.liveVersionId ? parseClientView(r.a.liveVersionId, r.view) : null,
      })),
      { locale, bounds: { from: bounds.from, to: now } },
    ),
    workflowsOf(
      tx,
      t.id,
      steps.map(({ r }) => r.agentVersionId),
    ),
    clientTitles(tx, top, platform, locale),
  ]);

  const out: TableView["services"] = agents.map((a) => {
    const going = nowOf.get(a.id);
    return {
      id: a.id,
      name: serviceName(a),
      description: clientDescription(a),
      status: a.runStatus ?? "draft",
      stage: a.stage,
      now: going ? serviceNow(going) : null,
      runsDone: counts.byAgent.get(a.id)?.succeeded ?? 0,
      runs: counts.byAgent.get(a.id) ?? noRuns(),
      runsNow: going?.runsNow ?? { running: 0, waitingOnYou: 0 },
      perDay: daysOf(daily.byAgent, a.id),
      changes: changes.byAgent.get(a.id) ?? 0,
      documentsRead: read.byAgent.get(a.id)?.size ?? 0,
      // v0.12 W2-G
      kpis: kpis.get(a.id) ?? [],
    };
  });

  // The latest client-visible step summaries across services.
  const names = new Map(agents.map((a) => [a.id, serviceName(a)]));
  const recent: TableView["recent"] = [];
  for (const { s, r } of steps) {
    if (recent.length >= 5) break;
    const workflow = workflows.get(r.agentVersionId)?.get(r.workflowSlug);
    const step = workflow ? findNodeStep(workflow, s.nodeId) : undefined;
    if (!step || !shownOnTimeline(step)) continue;
    recent.push({
      runId: r.id,
      service: { id: r.agentId, name: names.get(r.agentId) ?? "" },
      label: clientLabel(step),
      summary: s.summary,
      sources: sourcesOf({ sources: s.sources }),
      at: iso(s.finishedAt ?? s.startedAt),
    });
  }

  return {
    client: { id: t.id, name: t.name, timezone: t.timezone },
    week: { weekStart, from: bounds.from.toISOString(), to: bounds.to.toISOString() },
    services: out,
    figures: {
      runsDone: counts.all.succeeded,
      runs: counts.all,
      changes: { automatic: changes.automatic, signed: changes.signed },
      documentsRead: read.all,
      perDay: daily.all,
      lastWeek: {
        runsDone: counts.lastWeek.succeeded,
        changes: changes.lastWeek,
        documentsRead: read.lastWeek,
      },
    },
    recent,
    desk: {
      open: desk.length,
      top: top.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: titles.get(i.id) ?? i.title,
        runId: i.runId,
        dueAt: iso(i.dueAt),
        createdAt: i.createdAt.toISOString(),
      })),
    },
    lead,
  };
}

/** The lead and their latest client-visible message in the lead thread, in one read. */
async function leadOf(tx: Tx, t: TenantRow): Promise<TableView["lead"]> {
  const leadId = leadUserId(t);
  if (!leadId) return null;
  const latest = tx
    .select({ id: message.id, body: message.body, createdAt: message.createdAt })
    .from(message)
    .innerJoin(thread, and(eq(thread.id, message.threadId), eq(thread.tenantId, message.tenantId)))
    .where(
      and(
        eq(message.tenantId, t.id),
        eq(thread.subjectType, LEAD_SUBJECT),
        eq(thread.subjectId, t.id),
        eq(message.audience, "client"),
        eq(message.senderType, "user"),
        eq(message.senderId, leadId),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(1)
    .as("latest");
  const [u] = await tx
    .select({
      name: appUser.name,
      m: { id: latest.id, body: latest.body, createdAt: latest.createdAt },
    })
    .from(appUser)
    .leftJoinLateral(latest, sql`true`)
    .where(eq(appUser.id, leadId));
  if (!u) return null;
  const m = u.m?.id ? u.m : null;
  const text = m && typeof m.body?.text === "string" ? m.body.text : null;
  return {
    id: leadId,
    name: u.name,
    message: m && text !== null ? { id: m.id, text, at: m.createdAt.toISOString() } : null,
  };
}

/** The person's language for the PDF: theirs, else the client's, else English. */
function localeFor(t: TenantRow, userId: string): Locale {
  return userLanguage(t.settings, userId) ?? clientLanguage(t.settings) ?? "en";
}

/** The PDF bytes a request asked for, swapped in for the JSON answer after the handler runs. */
const pdfs = new WeakMap<Request, { bytes: Uint8Array; filename: string }>();

export function tableRouteHandlers(app: Hono<AppEnv>): void {
  mount(app, routes.portalTable, async ({ tx, tenantIds, role, session, services }) => {
    const t = await clientOf(tx, tenantIds[0] as string);
    return buildTable(tx, t, { userId: session.user.id, role }, new Date(), services.platform);
  });

  mount(app, routes.portalWeekly, async ({ tx, tenantIds, query }) => {
    const tenantId = tenantIds[0] as string;
    const sent = await weeklyRows(tx, tenantId, { status: "sent", limit: 104 });
    const row = query.week ? sent.find((r) => r.weekStart === query.week) : sent[0];
    if (query.week && !row) throw notFound("weekly summary");
    return { table: row ? await weeklyView(tx, row) : null, weeks: sent.map((r) => r.weekStart) };
  });

  // The PDF: the route's sign-in, roles, client scope and audit as any route (mount), then the
  // JSON answer is replaced by the file.
  app.use(routes.portalWeeklyPdf.path, async (c, next) => {
    await next();
    const file = pdfs.get(c.req.raw);
    if (!file || c.res.status !== 200) return;
    c.res = new Response(file.bytes, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "private, max-age=0, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  mount(app, routes.portalWeeklyPdf, async ({ c, tx, tenantIds, params, session }) => {
    const t = await clientOf(tx, tenantIds[0] as string);
    const row = await weeklyRow(tx, t.id, params.weekStart);
    if (row?.status !== "sent") throw notFound("weekly summary");
    const locale = localeFor(t, session.user.id);
    const bytes = await weeklyPdf({
      table: await weeklyView(tx, row),
      clientName: t.name,
      locale,
      paper: paperFor({ language: clientLanguage(t.settings), timezone: t.timezone }),
    });
    pdfs.set(c.req.raw, { bytes, filename: `mezonas-week-${row.weekStart}.pdf` });
    return { ok: true };
  });

  // v0.12 W1-C: a reply to a decision is the client's message in the lead thread (§11.4).
  mount(app, routes.portalWeeklyReply, async (ctx) => {
    const { tx, tenantIds, params, body, session, services } = ctx;
    const collect: EventRow[] = [];
    const messageId = await replyToDecision(tx, {
      tenantId: tenantIds[0] as string,
      weekStart: params.weekStart,
      decisionId: params.decisionId,
      userId: session.user.id,
      text: body.text,
      now: new Date(),
      emitPosted: senseEmitPosted({ registry: services.platform.events, collect }),
    });
    if (collect.length > 0) {
      ctx.defer(() => dispatchEvents({ db: services.db, instances: services.instances }, collect));
    }
    return { messageId };
  });

  mount(app, routes.opsWeekly, async ({ tx, params, ...ctx }) => {
    ensureClient(ctx, params.id);
    const rows = await weeklyRows(tx, params.id, { limit: 12 });
    const tables = [];
    for (const r of rows) tables.push(await weeklyView(tx, r));
    return { tables };
  });

  mount(app, routes.opsWeeklyEdit, async ({ tx, params, body, session, services, ...ctx }) => {
    ensureClient(ctx, params.id);
    const t = await clientOf(tx, params.id);
    const row = await editWeek(tx, {
      t,
      platform: services.platform,
      weekStart: params.weekStart,
      body,
      by: session.user.id,
      now: new Date(),
    });
    return { table: await weeklyView(tx, row) };
  });
}
