// The Table and the Weekly Table (ARCHITECTURE §11.4, §14 v0.12; docs/plan.md §1.37). The Table is
// the portal's home, built from rows the portal already reads: each service and what it is doing
// now, this week's figures, the latest client-visible step summaries, the top three Desk items and
// the lead's latest message. Never a bundle, a prompt or a cost (invariant 11). The Weekly Table's
// routes: the lead's edits in the back office, sent tables and their PDF in the portal.

import {
  clientLabel,
  clientLanguage,
  findStep,
  isClientVisible,
  type Locale,
  routes,
  type Step,
  type TableView,
  userLanguage,
  type Workflow,
  weekBounds,
  weekStartOf,
} from "@countersign/core";
import {
  agentVersion,
  appUser,
  inboxItem,
  message,
  run,
  stepRun,
  type Tx,
  thread,
} from "@countersign/db";
import type { EventRow } from "@countersign/senses";
import { senseEmitPosted } from "@countersign/threads";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { clientTitles } from "../change-display";
import { type AppEnv, ensureClient, mount, notFound } from "../http";
// v0.12 W2-G
import { readerLocale, weekKpis } from "../kpi/view";
import { leadUserId, type TenantRow, tenantRow } from "../notify/people";
import { LEAD_SUBJECT } from "../notify/scan";
import type { Platform } from "../platform";
import {
  at,
  clientWaits,
  noRuns,
  OPEN_RUN,
  openRunsByAgent,
  runCounts,
} from "../runs/client-status";
import { dispatchEvents } from "../runs/dispatch";
import { paperFor, weeklyPdf } from "../weekly/pdf";
import { clientDescription, serviceName, services, toolChanges } from "../weekly/stats";
import { editWeek, replyToDecision, weeklyRow, weeklyRows, weeklyView } from "../weekly/tables";
import { portalInboxFilter, sourcesOf } from "./portal";

async function clientOf(tx: Tx, tenantId: string): Promise<TenantRow> {
  const t = await tenantRow(tx, tenantId);
  if (!t) throw notFound("client");
  return t;
}

/** Workflows of the versions asked for, by version id and slug (read once per request). */
function workflowCache(tx: Tx, tenantId: string) {
  const cache = new Map<string, Promise<Map<string, Workflow>>>();
  return (versionId: string, slug: string): Promise<Workflow | undefined> => {
    let v = cache.get(versionId);
    if (!v) {
      v = tx
        .select({ bundle: agentVersion.bundle })
        .from(agentVersion)
        .where(and(eq(agentVersion.id, versionId), eq(agentVersion.tenantId, tenantId)))
        .then(([row]) => new Map((row?.bundle.workflows ?? []).map((w) => [w.slug, w.workflow])));
      cache.set(versionId, v);
    }
    return v.then((m) => m.get(slug));
  };
}

/** A step_run's node names its step: the id, or `${loop}:${index}:${childId}` inside a loop. */
function stepOf(workflow: Workflow, nodeId: string): Step | undefined {
  return (
    findStep(workflow, nodeId)?.step ?? findStep(workflow, nodeId.split(":").at(-1) ?? nodeId)?.step
  );
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

async function buildTable(
  tx: Tx,
  t: TenantRow,
  viewer: { userId: string; role: Parameters<typeof portalInboxFilter>[0] },
  now: Date,
  platform: Pick<Platform, "tools">,
): Promise<TableView> {
  const weekStart = weekStartOf(now, t.timezone);
  const bounds = weekBounds(weekStart, t.timezone);
  const workflows = workflowCache(tx, t.id);
  const agents = await services(tx, t.id);
  // QA round 1: runs started this week by how they stand, as Reports counts them; what each
  // agent has going now (any run, not only its latest) for its state.
  const counts = await runCounts(tx, t.id, { lo: at(bounds.from), hi: at(bounds.to) });
  const going = await openRunsByAgent(tx, t.id);
  const changes = await toolChanges(tx, t.id, bounds);
  // v0.12 W2-G: each service's KPIs for this week, in the viewer's language.
  const kpis = await weekKpis(tx, agents, {
    locale: readerLocale(t, viewer.userId),
    bounds: { from: bounds.from, to: now },
  });

  // Open Desk items the viewer sees (snoozed ones wait), for "waiting on you" and the top three.
  const deskWhere = and(
    eq(inboxItem.tenantId, t.id),
    eq(inboxItem.status, "open"),
    portalInboxFilter(viewer.role, viewer.userId),
    or(isNull(inboxItem.snoozedUntil), lte(inboxItem.snoozedUntil, now)),
  );
  const desk = await tx
    .select()
    .from(inboxItem)
    .where(deskWhere)
    .orderBy(sql`${inboxItem.dueAt} asc nulls last`, desc(inboxItem.createdAt));

  const out: TableView["services"] = [];
  for (const a of agents) {
    const [latest] = await tx
      .select()
      .from(run)
      .where(and(eq(run.tenantId, t.id), eq(run.agentId, a.id), eq(run.mode, "live")))
      .orderBy(desc(run.createdAt))
      .limit(1);
    let now_: TableView["services"][number]["now"] = null;
    if (latest) {
      const active = (OPEN_RUN as readonly string[]).includes(latest.status);
      let step: { index: number; total: number; label: string } | null = null;
      let since = active ? iso(latest.startedAt ?? latest.createdAt) : iso(latest.finishedAt);
      // The client's wait (anyone of the client), the one definition every portal route uses.
      const waiting = active
        ? (await clientWaits(tx, t.id, [latest.id], now)).get(latest.id)
        : undefined;
      if (active) {
        const workflow = await workflows(latest.agentVersionId, latest.workflowSlug);
        const [current] = await tx
          .select({ nodeId: stepRun.nodeId, startedAt: stepRun.startedAt })
          .from(stepRun)
          .where(
            and(
              eq(stepRun.tenantId, t.id),
              eq(stepRun.runId, latest.id),
              inArray(stepRun.status, ["running", "waiting"]),
            ),
          )
          .orderBy(desc(stepRun.startedAt))
          .limit(1);
        if (workflow && current) {
          const top = current.nodeId.split(":")[0] ?? current.nodeId;
          const index = workflow.steps.findIndex((s) => s.id === top);
          const s = workflow.steps[index];
          if (s) step = { index: index + 1, total: workflow.steps.length, label: clientLabel(s) };
          since = iso(current.startedAt) ?? since;
        }
        if (waiting?.since) since = waiting.since.toISOString();
      }
      now_ = {
        runId: latest.id,
        status: latest.status,
        step,
        since,
        waitingOnYou: waiting?.waitingOnYou ?? false,
      };
    }
    out.push({
      id: a.id,
      name: serviceName(a),
      description: clientDescription(a),
      status: a.runStatus ?? "draft",
      stage: a.stage,
      now: now_,
      runsDone: counts.byAgent.get(a.id)?.succeeded ?? 0,
      runs: counts.byAgent.get(a.id) ?? noRuns(),
      runsNow: going.get(a.id) ?? { running: 0, waitingOnYou: 0 },
      // v0.12 W2-G
      kpis: kpis.get(a.id) ?? [],
    });
  }

  // The latest client-visible step summaries across services.
  const names = new Map(agents.map((a) => [a.id, serviceName(a)]));
  const steps = await tx
    .select({ s: stepRun, r: run })
    .from(stepRun)
    .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
    .where(
      and(
        eq(stepRun.tenantId, t.id),
        eq(run.mode, "live"),
        isNotNull(stepRun.summary),
        inArray(
          run.agentId,
          agents.map((a) => a.id),
        ),
      ),
    )
    // QA round 1: newest first by the time each row shows (finished, else started), so a step
    // still waiting doesn't sink below older ones.
    .orderBy(
      sql`coalesce(${stepRun.finishedAt}, ${stepRun.startedAt}) desc nulls last`,
      desc(stepRun.id),
    )
    .limit(40);
  const recent: TableView["recent"] = [];
  for (const { s, r } of steps) {
    if (recent.length >= 5) break;
    const workflow = await workflows(r.agentVersionId, r.workflowSlug);
    const step = workflow ? stepOf(workflow, s.nodeId) : undefined;
    if (!step || !isClientVisible(step)) continue;
    recent.push({
      runId: r.id,
      service: { id: r.agentId, name: names.get(r.agentId) ?? "" },
      label: clientLabel(step),
      summary: s.summary,
      sources: sourcesOf(s.output),
      at: iso(s.finishedAt ?? s.startedAt),
    });
  }

  const top = desk.slice(0, 3);
  const titles = await clientTitles(tx, top, platform, readerLocale(t, viewer.userId));
  return {
    client: { id: t.id, name: t.name, timezone: t.timezone },
    week: { weekStart, from: bounds.from.toISOString(), to: bounds.to.toISOString() },
    services: out,
    figures: {
      runsDone: counts.all.succeeded,
      runs: counts.all,
      changes: { automatic: changes.automatic.length, signed: changes.signed.length },
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
    lead: await leadOf(tx, t),
  };
}

/** The lead and their latest client-visible message in the lead thread. */
async function leadOf(tx: Tx, t: TenantRow): Promise<TableView["lead"]> {
  const leadId = leadUserId(t);
  if (!leadId) return null;
  const [u] = await tx.select({ name: appUser.name }).from(appUser).where(eq(appUser.id, leadId));
  if (!u) return null;
  const [m] = await tx
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
    .limit(1);
  const text = m && typeof m.body.text === "string" ? m.body.text : null;
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
